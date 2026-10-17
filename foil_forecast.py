#!/usr/bin/env python3
"""Foil forecast: pulls wind and wave forecasts from Open-Meteo, scores every
daylight hour for wing, downwind, prone and SUP foiling at each spot for each
rider's own gear, and writes a single-page HTML dashboard with a rider switcher.

Scores combine two layers:
  conditions  - direction, gusts, swell. The same for everyone.
  gear fit    - how well the wind suits each rider's weight, boards, wings and
                front wings, estimated from rules of thumb or set by override.

Usage:
    python foil_forecast.py --out site/index.html
    python foil_forecast.py --demo --out demo.html   # synthetic data, no network
"""
import argparse
import json
import math
import os
import random
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from html import escape
from zoneinfo import ZoneInfo

import yaml

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
MARINE_URL = "https://marine-api.open-meteo.com/v1/marine"
WIND_VARS = ["wind_speed_10m", "wind_gusts_10m", "wind_direction_10m"]
MARINE_VARS = [
    "wave_height", "wave_direction", "wave_period",
    "wind_wave_height", "wind_wave_direction", "wind_wave_period",
    "swell_wave_height", "swell_wave_direction", "swell_wave_period",
]
DISC_NAMES = {"wing": "Wing", "downwind": "Downwind", "prone": "Prone", "sup": "SUP"}
DISC_ORDER = {"wing": 0, "downwind": 1, "prone": 2, "sup": 3}
COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


# ================================================================ data

def get_json(url, params):
    req = urllib.request.Request(
        f"{url}?{urllib.parse.urlencode(params)}",
        headers={"User-Agent": "foil-forecast/2.0"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def fetch_spot(spot, cfg):
    common = {"timezone": cfg["timezone"], "forecast_days": cfg["days"]}
    wind = get_json(FORECAST_URL, {
        **common, "latitude": spot["lat"], "longitude": spot["lon"],
        "hourly": ",".join(WIND_VARS), "daily": "sunrise,sunset",
        "wind_speed_unit": "kn",
    })
    try:
        marine = get_json(MARINE_URL, {
            **common,
            "latitude": spot.get("marine_lat", spot["lat"]),
            "longitude": spot.get("marine_lon", spot["lon"]),
            "hourly": ",".join(MARINE_VARS),
        })
    except Exception as exc:  # wave model may not cover the point
        print(f"warning: no wave data for {spot['name']}: {exc}", file=sys.stderr)
        marine = {"hourly": {"time": []}}
    return merge(wind, marine)


def merge(wind, marine):
    hours = {}
    wh = wind["hourly"]
    for i, t in enumerate(wh["time"]):
        hours[t] = {
            "time": t,
            "wind": wh["wind_speed_10m"][i],
            "gust": first(wh["wind_gusts_10m"][i], wh["wind_speed_10m"][i]),
            "wdir": wh["wind_direction_10m"][i],
        }
    mh = marine.get("hourly", {})
    for i, t in enumerate(mh.get("time", [])):
        if t in hours:
            for v in MARINE_VARS:
                series = mh.get(v)
                hours[t][v] = series[i] if series else None
    d = wind["daily"]
    daylight = {day: (d["sunrise"][i], d["sunset"][i]) for i, day in enumerate(d["time"])}
    return [hours[t] for t in sorted(hours)], daylight


def demo_spot(spot, cfg, seed):
    """Plausible synthetic weather so the dashboard can be previewed offline."""
    rng = random.Random(seed)
    tz = ZoneInfo(cfg["timezone"])
    start = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    hours, daylight = [], {}
    base_dir = rng.choice([170, 200, 330, 350])
    for d in range(cfg["days"]):
        day = start + timedelta(days=d)
        daylight[day.strftime("%Y-%m-%d")] = (
            day.replace(hour=6, minute=40).strftime("%Y-%m-%dT%H:%M"),
            day.replace(hour=19, minute=35).strftime("%Y-%m-%dT%H:%M"),
        )
        day_wind = rng.uniform(4, 26)
        day_dir = (base_dir + rng.uniform(-60, 60)) % 360
        swell = rng.uniform(0.3, 2.4)
        for h in range(24):
            t = day + timedelta(hours=h)
            diurnal = 1 + 0.25 * math.sin((h - 9) / 24 * 2 * math.pi)
            w = max(1.0, day_wind * diurnal + rng.uniform(-2, 2))
            hours.append({
                "time": t.strftime("%Y-%m-%dT%H:%M"),
                "wind": round(w, 1),
                "gust": round(w * rng.uniform(1.15, 1.5), 1),
                "wdir": round((day_dir + rng.uniform(-15, 15)) % 360),
                "wave_height": round(swell + w / 30, 2),
                "wave_direction": round((spot["faces"] + rng.uniform(-40, 40)) % 360),
                "wave_period": round(rng.uniform(6, 13), 1),
                "wind_wave_height": round(w / 25, 2),
                "wind_wave_direction": round(day_dir),
                "wind_wave_period": round(rng.uniform(3, 6), 1),
                "swell_wave_height": round(swell, 2),
                "swell_wave_direction": round((spot["faces"] + rng.uniform(-45, 45)) % 360),
                "swell_wave_period": round(rng.uniform(7, 14), 1),
            })
    return hours, daylight


# ================================================================ helpers

def first(*vals):
    for v in vals:
        if v is not None:
            return v
    return None


def compass(deg):
    return COMPASS[int((deg % 360) / 22.5 + 0.5) % 16]


def angdiff(a, b):
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


def in_window(deg, lo, hi):
    return (deg - lo) % 360 <= (hi - lo) % 360


def ramp(x, x0, x1, y0, y1):
    return y1 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)


def clamp(x, lo=0.0, hi=10.0):
    return max(lo, min(hi, x))


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "rider"


def swell_text(h, combined=False):
    if combined:
        hgt = first(h.get("wave_height"), h.get("swell_wave_height"))
        sd = first(h.get("wave_direction"), h.get("swell_wave_direction"))
        if hgt is None:
            return "no wave data"
        return f"{hgt:.1f} m sea" + (f" from the {compass(sd)}" if sd is not None else "")
    hgt = first(h.get("swell_wave_height"), h.get("wave_height"))
    per = first(h.get("swell_wave_period"), h.get("wave_period"))
    sd = first(h.get("swell_wave_direction"), h.get("wave_direction"))
    if hgt is None:
        return "no wave data"
    txt = f"{hgt:.1f} m"
    if per is not None:
        txt += f" at {per:.0f} s"
    if sd is not None:
        txt += f" {compass(sd)}"
    return txt


# ================================================================ gear model
# Rules of thumb, tuned so an 80 kg rider on a 5 m wing has a sweet spot of
# roughly 14-20 knots. Riders can override any combo in config.yaml.

WING_POWER = 17.0      # wind^2 x wing m^2 / kg at the middle of a wing's sweet spot
REF_LOADING = 13.0     # cm^2 of front wing per kg of rider (a mid-size freeride setup)
ASPECT = {             # how front-wing aspect shifts the low end and top end
    "low": {"low": 0.96, "top": 0.92},
    "mid": {"low": 1.00, "top": 1.00},
    "high": {"low": 1.06, "top": 1.10},
}
DW_LEVEL = {"beginner": 3, "intermediate": 0, "advanced": -2}   # knots added to the low end


def board_factor(volume, weight):
    """Sinker boards need more wind to get going; floaty boards need less."""
    return clamp(1.0 + (1.0 - volume / weight) * 0.4, 0.9, 1.15)


def foil_factors(foil, weight):
    loading = foil["area"] / weight
    a = ASPECT.get(foil.get("type", "mid"), ASPECT["mid"])
    return (REF_LOADING / loading) ** 0.25 * a["low"], (REF_LOADING / loading) ** 0.3 * a["top"]


def wing_range(rider, board, wing_m2, foil):
    mid = math.sqrt(WING_POWER * rider["weight"] / wing_m2)
    low, top = foil_factors(foil, rider["weight"])
    lo, hi = mid * 0.82, mid * 1.22
    mn = min(mid * 0.68 * board_factor(board["volume"], rider["weight"]) * low, lo - 1)
    return {"min": mn, "ideal": [lo, hi], "max": max(mid * 1.55 * top, hi * 1.08)}


def downwind_range(rider, board, foil):
    low, top = foil_factors(foil, rider["weight"])
    off = DW_LEVEL.get(rider.get("downwind_level", "intermediate"), 0)
    mn = 13 * low * board_factor(board["volume"], rider["weight"]) + off
    hi = max(mn + 6, 24 * top - max(off, 0))
    return {"min": mn, "ideal": [mn + 3, hi], "max": max(32 * top - 2 * max(off, 0), hi + 3)}


def wind_fit(w, r):
    """0-10: how well a wind speed suits a gear range."""
    lo, hi = r["ideal"]
    if w < r["min"] or w > r["max"]:
        return 0.0
    if w < lo:
        return ramp(w, r["min"], lo, 3, 10)
    if w <= hi:
        return 10.0
    return ramp(w, hi, r["max"], 10, 4)


def build_combos(rider):
    """Every usable gear combination per sport, with its wind range."""
    over = rider.get("overrides") or {}
    combos = {"wing": [], "downwind": [], "prone": [], "sup": []}
    for board in rider.get("boards", []):
        uses = board.get("use", [])
        for foil in rider.get("foils", []):
            fuse = foil.get("use", [])
            if "wing" in uses and "wing" in fuse:
                for wing_m2 in rider.get("wings", []):
                    label = f"{float(wing_m2):.1f}m + {foil['name']}"
                    combos["wing"].append({"label": label, "range":
                                           over.get(label) or wing_range(rider, board, wing_m2, foil)})
            if "downwind" in uses and "downwind" in fuse:
                label = foil["name"]
                combos["downwind"].append({"label": label, "range":
                                           over.get(label) or downwind_range(rider, board, foil)})
    for disc in ("prone", "sup"):
        combos[disc] = [f for f in rider.get("foils", []) if disc in f.get("use", [])]
    return combos


def best_combo(w, combos):
    """Best-fitting gear for a wind speed. Ties go to the combo nearest its sweet-spot middle."""
    best, best_key = (0.0, None), None
    for c in combos:
        s = wind_fit(w, c["range"])
        if s <= 0:
            continue
        key = (s, -abs(w - sum(c["range"]["ideal"]) / 2))
        if best_key is None or key > best_key:
            best, best_key = (s, c["label"]), key
    return best


# ================================================================ scoring

def gust_penalty(w, g, warn):
    """Forecast gusts near the coast often run far above what you feel on the water,
    so the penalty is based on the gust-to-average ratio and capped at 2 points."""
    if not g or w < 5:
        return 0.0
    ratio = g / w
    if ratio > 1.7:
        warn.append("gusty")
    return min(2.0, max(0.0, (ratio - 1.5) * 4))


# Each scorer returns (score 0-10, reasons, warnings, gear label or None).

def score_wing(h, spot, combos):
    w, g, d = h["wind"], h["gust"], h["wdir"]
    if w is None or d is None:
        return None
    s, kit = best_combo(w, combos)
    s *= 0.9  # headroom for the swell bonus
    why, warn = [], []
    s -= gust_penalty(w, g, warn)
    rel = angdiff(d, spot["faces"])
    if rel <= 30:
        s *= 1.0 if spot.get("onshore_ok") else 0.9
        why.append("onshore")
    elif rel <= 120:
        why.append("cross-shore")
    elif rel <= 150:
        s *= 0.6
        why.append("cross-offshore")
        warn.append("cross-offshore")
    else:
        s *= 0.6 if spot.get("offshore_ok") else 0.15
        why.append("offshore")
        warn.append("offshore wind, drift risk")
    hgt = first(h.get("swell_wave_height"), h.get("wave_height"))
    if hgt is not None:
        if 0.4 <= hgt <= 3.0:
            s += 1
            why.append("swell to ride")
        elif hgt > 3.5:
            s -= 1.5
            warn.append("big swell")
    if kit is None:
        why.insert(0, "too light" if w < 12 else "too strong for your gear")
    return clamp(s), why, warn, kit


def score_downwind(h, spot, combos):
    dw = spot.get("downwind")
    w, g, d = h["wind"], h["gust"], h["wdir"]
    if not dw or w is None or d is None:
        return None
    s, kit = best_combo(w, combos)
    why, warn = [], []
    tol = dw.get("tolerance", 30)
    diff = angdiff(d, dw["wind_from"])
    if diff <= tol * 0.6:
        why.append("wind lined up with the run")
    elif diff <= tol:
        s *= 0.75
        why.append("wind slightly off the run")
    elif diff <= tol * 1.7:
        s *= 0.4
        why.append("wind well off the run")
    else:
        s *= 0.05
        why.append("wrong direction for the run")
    bumps = first(h.get("wind_wave_height"), h.get("wave_height"))
    if bumps is None:
        s *= 0.85
    elif bumps < 0.3:
        s *= 0.55
        why.append("small bumps")
    elif bumps < 0.6:
        s *= 0.85
    else:
        why.append("good bumps")
    s -= gust_penalty(w, g, warn)
    return clamp(s), why, warn, kit


def score_surf(h, spot, p, foils):
    hgt = first(h.get("swell_wave_height"), h.get("wave_height"))
    per = first(h.get("swell_wave_period"), h.get("wave_period"))
    sd = first(h.get("swell_wave_direction"), h.get("wave_direction"))
    w, d = h["wind"], h["wdir"]
    if hgt is None or w is None:
        return None
    why, warn = [], []
    lo, hi = p["ideal_height"]
    if hgt < p["min_height"]:
        s = 0.0
        why.append("too small")
    elif hgt < lo:
        s = ramp(hgt, p["min_height"], lo, 4, 10)
    elif hgt <= hi:
        s = 10.0
    elif hgt <= p["max_height"]:
        s = ramp(hgt, hi, p["max_height"], 10, 4)
        warn.append("solid size")
    else:
        s = 2.0
        warn.append("big swell")
    if per is not None:
        if per < 6:
            s *= 0.5
            why.append("short, weak period")
        elif per < 8:
            s *= 0.75
        elif per < 11:
            s *= 0.9
        else:
            why.append("long-period swell")
    if sd is not None and "swell_window" in spot:
        a, b = spot["swell_window"]
        if not in_window(sd, a, b):
            if min(angdiff(sd, a), angdiff(sd, b)) <= 20:
                s *= 0.6
                why.append("swell direction marginal")
            else:
                s *= 0.2
                why.append("swell direction misses the break")
    rel = angdiff(d, spot["faces"]) if d is not None else 90
    if w <= p["glassy_wind"]:
        why.append("light wind")
    elif rel > 120 and w <= 15:
        if w > 10:
            s *= 0.85
        why.append("offshore, groomed")
    elif w <= p["calm_wind"]:
        s *= 0.75
    elif w <= p["calm_wind"] + 6:
        s *= 0.45
        why.append("wind chop")
    else:
        s *= 0.2
        why.append("blown out")
    # Bigger front wing for small, weak waves; smaller for punchy ones.
    kit = None
    if foils:
        ordered = sorted(foils, key=lambda f: f["area"])
        kit = (ordered[-1] if hgt < 0.8 else ordered[0])["name"]
    return clamp(s), why, warn, kit


def score_hour(disc, h, spot, cfg, combos):
    if disc == "wing":
        return score_wing(h, spot, combos["wing"])
    if disc == "downwind":
        return score_downwind(h, spot, combos["downwind"])
    return score_surf(h, spot, cfg[disc], combos[disc])


# ================================================================ windows

def is_daylight(t, daylight):
    sunrise, sunset = daylight.get(t[:10], (None, None))
    if not sunrise:
        return False
    start = datetime.fromisoformat(t)
    return start + timedelta(hours=1) > datetime.fromisoformat(sunrise) and \
        start < datetime.fromisoformat(sunset)


def best_window(rows):
    """Consecutive hours around the best pair of hours. Returns (start, end, peak)."""
    scores = [r["score"] for r in rows]
    if not scores or max(scores) <= 0:
        return None
    pair = [(scores[i] + scores[i + 1]) / 2 for i in range(len(scores) - 1)] or scores
    i = max(range(len(pair)), key=pair.__getitem__)
    peak = i if len(pair) == len(scores) or scores[i] >= scores[i + 1] else i + 1
    floor = max(scores[peak] - 1.5, 3)
    start = end = peak
    while start > 0 and scores[start - 1] >= floor:
        start -= 1
    while end < len(scores) - 1 and scores[end + 1] >= floor:
        end += 1
    return start, end, peak


def win_score(r):
    """Average score across the best window: rewards sessions that hold up."""
    if not r["window"]:
        return 0.0
    s, e, _ = r["window"]
    vals = [h["score"] for h in r["rows"][s:e + 1]]
    return round(sum(vals) / len(vals), 1)


def rider_has_gear(disc, combos):
    return bool(combos[disc]) if disc in ("wing", "downwind") else True


def build(cfg, demo=False):
    tz = ZoneInfo(cfg["timezone"])
    weather = {}
    for n, spot in enumerate(cfg["spots"]):
        hours, daylight = demo_spot(spot, cfg, n + 7) if demo else fetch_spot(spot, cfg)
        factor = spot.get("wave_factor", 1.0)
        if factor != 1.0:  # scale offshore wave data to what reaches the beach
            for h in hours:
                for v in ("wave_height", "wind_wave_height", "swell_wave_height"):
                    if h.get(v) is not None:
                        h[v] = round(h[v] * factor, 2)
        weather[spot["name"]] = (hours, daylight)
    riders = []
    for rider in cfg["riders"]:
        combos = build_combos(rider)
        results = []
        for spot in cfg["spots"]:
            hours, daylight = weather[spot["name"]]
            for disc in spot.get("disciplines", []):
                if disc not in rider.get("sports", []) or not rider_has_gear(disc, combos):
                    continue
                by_day = {}
                for h in hours:
                    if not is_daylight(h["time"], daylight):
                        continue
                    res = score_hour(disc, h, spot, cfg, combos)
                    if res is None:
                        continue
                    score, why, warn, kit = res
                    by_day.setdefault(h["time"][:10], []).append(
                        {**h, "score": round(score, 1), "why": why, "warn": warn, "kit": kit})
                for day, rows in sorted(by_day.items()):
                    results.append({"spot": spot, "disc": disc, "day": day,
                                    "rows": rows, "window": best_window(rows)})
        riders.append({"rider": rider, "combos": combos, "results": results})
    return riders, datetime.now(tz)


# ================================================================ output

def rating(score):
    if score >= 8:
        return "epic", "Epic"
    if score >= 6:
        return "good", "Good"
    if score >= 4:
        return "fair", "Fair"
    if score >= 2:
        return "marginal", "Marginal"
    return "nogo", "No go"


def hour_label(t):
    h = int(t[11:13])
    return f"{h % 12 or 12}{'am' if h < 12 else 'pm'}"


def window_label(r):
    s, e, _ = r["window"]
    end = datetime.fromisoformat(r["rows"][e]["time"]) + timedelta(hours=1)
    return f"{hour_label(r['rows'][s]['time'])} to {hour_label(end.strftime('%Y-%m-%dT%H:%M'))}"


def day_label(day, long=True):
    d = datetime.fromisoformat(day)
    return d.strftime("%A %-d %B") if long else d.strftime("%a %-d %b")


def summary(row, disc):
    parts = [f"{row['wind']:.0f} kn {compass(row['wdir'])}, gusting {row['gust']:.0f}"]
    if disc == "wing":
        parts.append(swell_text(row, combined=True))
    elif disc in ("prone", "sup"):
        parts.append(swell_text(row))
    else:
        b = first(row.get("wind_wave_height"), row.get("wave_height"))
        if b is not None:
            parts.append(f"{b:.1f} m wind swell")
    text = ". ".join(p[0].upper() + p[1:] for p in parts) + "."
    if row["why"]:
        text += " " + ", ".join(row["why"]).capitalize() + "."
    return text


def best_bets(results, n=5):
    picks = [r for r in results if r["window"] and win_score(r) >= 4]
    picks.sort(key=lambda r: win_score(r) + 0.15 * min(r["window"][1] - r["window"][0] + 1, 4),
               reverse=True)
    return picks[:n]


def gear_phrase(kit, disc):
    if not kit:
        return ""
    return f" with the {kit}" if disc in ("prone", "sup") else f" on {kit}"


def render_row(r):
    disc, spot, win = r["disc"], r["spot"], r["window"]
    peak = r["rows"][win[2]] if win else None
    cls, word = rating(win_score(r))
    cells = []
    for i, h in enumerate(r["rows"]):
        c, w = rating(h["score"])
        inwin = win and win[0] <= i <= win[1]
        tip = (f"{hour_label(h['time'])}: {h['score']:.1f} {w}. "
               f"{h['wind']:.0f} kn {compass(h['wdir'])}, gusting {h['gust']:.0f}. {swell_text(h)}")
        lbl = hour_label(h["time"]) if int(h["time"][11:13]) % 3 == 0 else ""
        cells.append(
            f'<span class="cell s-{c}{" inwin" if inwin else ""}" title="{escape(tip)}">'
            f'<i class="arrow" style="transform:rotate({h["wdir"]:.0f}deg)" aria-hidden="true">↓</i>'
            f'<b class="hr">{lbl}</b></span>')
    detail = "".join(
        f"<tr><td>{hour_label(h['time'])}</td>"
        f'<td><span class="pill s-{rating(h["score"])[0]}">{h["score"]:.1f}</span></td>'
        f"<td>{h['wind']:.0f} / {h['gust']:.0f} kn {compass(h['wdir'])}</td>"
        f"<td>{escape(swell_text(h))}</td>"
        f"<td>{escape(h['kit'] or '')}</td>"
        f"<td>{escape(', '.join(h['why'] + h['warn']))}</td></tr>"
        for h in r["rows"])
    if win:
        warn = (f' <span class="warn">Watch for: {escape(", ".join(peak["warn"]))}.</span>'
                if peak["warn"] else "")
        best = f"Best {window_label(r)}{escape(gear_phrase(peak['kit'], disc))}.{warn}"
    else:
        best = "Nothing worth rigging for."
    return f"""
<details class="row" data-disc="{disc}" data-rating="{cls}">
  <summary>
    <span class="who"><span class="disc">{DISC_NAMES[disc]}</span>
      <span class="where">{escape(spot['name'])}</span></span>
    <span class="ribbon">{''.join(cells)}</span>
    <span class="score s-{cls}"><b>{win_score(r):.1f}</b><small>{word}</small></span>
    <span class="best">{best}</span>
  </summary>
  <div class="detail"><table>
    <thead><tr><th>Hour</th><th>Score</th><th>Wind / gust</th><th>Swell</th><th>Gear</th><th>Notes</th></tr></thead>
    <tbody>{detail}</tbody></table></div>
</details>"""


def render_ranges(combos):
    rows = []
    for disc in ("wing", "downwind"):
        for c in combos[disc]:
            r = c["range"]
            rows.append(f"<tr><td>{DISC_NAMES[disc]}</td><td>{escape(c['label'])}</td>"
                        f"<td>{r['min']:.0f}</td><td>{r['ideal'][0]:.0f} to {r['ideal'][1]:.0f}</td>"
                        f"<td>{r['max']:.0f}</td></tr>")
    if not rows:
        return ""
    return f"""
<details class="ranges"><summary>Your wind ranges</summary>
<p>Estimated from weight, board volume, wing size and front wing. If these don't match how it feels on the water,
copy the combo name into <code>overrides</code> in config.yaml with your own numbers.</p>
<div class="detail"><table><thead><tr><th>Sport</th><th>Gear</th><th>Gets going (kn)</th><th>Sweet spot (kn)</th><th>Overpowered (kn)</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table></div></details>"""


def render_rider(entry, sid):
    results = entry["results"]
    bets = best_bets(results)
    bet_html = "".join(f"""
<li class="bet">
  <span class="big s-{rating(win_score(b))[0]}">{win_score(b):.1f}</span>
  <div>
    <h3>{DISC_NAMES[b['disc']]} at {escape(b['spot']['name'])}</h3>
    <p class="when">{day_label(b['day'], False)}, {window_label(b)}{escape(gear_phrase(b['rows'][b['window'][2]]['kit'], b['disc']))}</p>
    <p>{escape(summary(b['rows'][b['window'][2]], b['disc']))}</p>
  </div>
</li>""" for b in bets) or '<li class="empty">No sessions scoring Fair or better this week. Check back after the next update.</li>'

    days = {}
    for r in results:
        days.setdefault(r["day"], []).append(r)
    day_html = ""
    for day, rows in sorted(days.items()):
        rows.sort(key=lambda r: (DISC_ORDER[r["disc"]], r["spot"]["name"]))
        day_html += f'<section class="day"><h2>{day_label(day)}</h2>{"".join(render_row(r) for r in rows)}</section>'

    discs = sorted({r["disc"] for r in results}, key=DISC_ORDER.get)
    chips = '<button class="chip on" data-f="all">All</button>' + "".join(
        f'<button class="chip" data-f="{d}">{DISC_NAMES[d]}</button>' for d in discs)
    return f"""
<div class="rider" id="{sid}" data-name="{escape(entry['rider']['name'])}">
<h2>Best bets</h2>
<ul class="bets">{bet_html}</ul>
{render_ranges(entry['combos'])}
<div class="filters" role="toolbar" aria-label="Filter by sport">{chips}
  <label class="toggle"><input type="checkbox" class="hideNogo"> Hide no-go</label></div>
{day_html or '<p class="empty">No spots match this rider\'s sports and gear. Check config.yaml.</p>'}
</div>"""


CSS = """
:root {
  --paper:#EDF2F1; --panel:#F8FAFA; --ink:#13313A; --muted:#5B737A; --line:#D2DDDB;
  --nogo:#D5DDDC; --marginal:#E6D293; --fair:#9FCDB9; --good:#2C8C80; --epic:#1D3F96;
  --on-dark:#FFFFFF; --warn:#9A4A12;
  --head:"Barlow Semi Condensed", "Arial Narrow", system-ui, sans-serif;
  --body:"Barlow", system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --paper:#0E1D22; --panel:#14272D; --ink:#E2ECEA; --muted:#93A9AE; --line:#24393F;
    --nogo:#24363B; --marginal:#8F7A33; --fair:#3E7C6B; --good:#2FA393; --epic:#4C74E0; --warn:#F0A060; }
}
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; background:var(--paper); color:var(--ink); font:16px/1.5 var(--body);
  padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom); }
main { max-width:1100px; margin:0 auto; padding:28px 18px 60px; }
header h1 { font:700 clamp(2rem,6vw,3.4rem)/1 var(--head); margin:0 0 6px; letter-spacing:-.01em; }
header p { margin:0; color:var(--muted); }
.demo { background:var(--marginal); color:#13313A; padding:8px 12px; border-radius:6px; margin:14px 0 0; font-weight:500; }
.riders { display:flex; flex-wrap:wrap; gap:8px; margin:18px 0 0; }
.rider-btn { font:600 1.1rem var(--head); border:2px solid var(--ink); background:transparent; color:var(--ink);
  padding:6px 18px; border-radius:6px; cursor:pointer; }
.rider-btn[aria-pressed="true"] { background:var(--ink); color:var(--paper); }
h2 { font:600 1.35rem/1.2 var(--head); margin:36px 0 10px; }
.bets { list-style:none; padding:0; margin:12px 0 0; display:grid; gap:12px; }
.bet { display:grid; grid-template-columns:auto 1fr; gap:16px; align-items:start;
  background:var(--panel); border-left:4px solid var(--good); padding:14px 16px; border-radius:4px; }
.bet h3 { font:600 1.2rem/1.2 var(--head); margin:0; }
.bet p { margin:2px 0 0; color:var(--muted); max-width:70ch; }
.bet .when { color:var(--ink); font-weight:500; }
.big { font:700 clamp(1.6rem,6vw,2.4rem)/1 var(--head); min-width:2.4ch; text-align:center; padding:6px 8px; border-radius:6px; }
.empty { color:var(--muted); }
.ranges { margin:22px 0 0; background:var(--panel); border-radius:4px; padding:10px 16px; }
.ranges > summary { font:600 1.05rem var(--head); cursor:pointer; }
.ranges p { color:var(--muted); max-width:70ch; font-size:.92rem; }
code { font-size:.9em; }
.filters { display:flex; flex-wrap:wrap; gap:8px; margin:30px 0 0; position:sticky; top:0;
  padding:10px 0; background:var(--paper); z-index:2; }
.chip { font:600 .95rem var(--head); border:1px solid var(--line); background:var(--panel); color:var(--ink);
  padding:6px 14px; border-radius:999px; cursor:pointer; }
.chip.on { background:var(--ink); color:var(--paper); border-color:var(--ink); }
button:focus-visible, summary:focus-visible { outline:2px solid var(--epic); outline-offset:2px; }
.toggle { margin-left:auto; color:var(--muted); font-size:.9rem; display:flex; align-items:center; gap:6px; }
.row { border-top:1px solid var(--line); }
.row > summary { list-style:none; cursor:pointer; display:grid; align-items:center; gap:6px 14px; padding:10px 0;
  grid-template-columns:150px 1fr 70px; grid-template-areas:"who ribbon score" "best best best"; }
.row > summary::-webkit-details-marker { display:none; }
.who { grid-area:who; display:flex; flex-direction:column; line-height:1.2; }
.disc { font:600 1.05rem var(--head); }
.where { color:var(--muted); font-size:.9rem; }
.ribbon { grid-area:ribbon; display:flex; gap:2px; min-width:0; }
.cell { flex:1; min-width:0; height:34px; border-radius:3px; position:relative; display:flex; justify-content:center; }
.cell.inwin { box-shadow:inset 0 -3px 0 var(--ink); }
.arrow { font-style:normal; font-size:.75rem; line-height:34px; opacity:.75; display:inline-block; }
.hr { position:absolute; top:36px; left:0; font:500 .68rem var(--body); color:var(--muted); white-space:nowrap; }
.score { grid-area:score; text-align:center; border-radius:6px; padding:4px 0; line-height:1.05; }
.score b { display:block; font:700 1.35rem var(--head); }
.score small { font-size:.72rem; font-weight:500; }
.best { grid-area:best; color:var(--muted); font-size:.92rem; margin-top:12px; }
.warn { color:var(--warn); }
.s-nogo { background:var(--nogo); color:var(--ink); }
.s-marginal { background:var(--marginal); color:#13313A; }
.s-fair { background:var(--fair); color:#13313A; }
.s-good { background:var(--good); color:var(--on-dark); }
.s-epic { background:var(--epic); color:var(--on-dark); }
.detail { overflow-x:auto; padding:0 0 14px; }
table { border-collapse:collapse; font-size:.9rem; width:100%; min-width:600px; }
th, td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font:600 .9rem var(--head); color:var(--muted); }
.pill { display:inline-block; min-width:2.6em; text-align:center; border-radius:4px; padding:0 4px; font-weight:500; }
.hidden { display:none !important; }
footer { margin-top:48px; color:var(--muted); font-size:.88rem; max-width:70ch; }
@media (max-width:640px) {
  .row > summary { grid-template-columns:1fr 64px; grid-template-areas:"who score" "ribbon ribbon" "best best"; }
  .best { margin-top:14px; }
  .bet { gap:12px; padding:12px; }
}
"""

JS = """
(function(){
  var riders = Array.prototype.slice.call(document.querySelectorAll('.rider'));
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.rider-btn'));
  function pick(id){
    if (!document.getElementById(id)) id = riders[0].id;
    riders.forEach(function(r){ r.classList.toggle('hidden', r.id !== id); });
    buttons.forEach(function(b){ b.setAttribute('aria-pressed', b.dataset.id === id ? 'true' : 'false'); });
    try { localStorage.setItem('foilRider', id); } catch (e) {}
  }
  buttons.forEach(function(b){
    b.addEventListener('click', function(){ history.replaceState(null, '', '#' + b.dataset.id); pick(b.dataset.id); });
  });
  var saved = null;
  try { saved = localStorage.getItem('foilRider'); } catch (e) {}
  pick(location.hash.slice(1) || saved || riders[0].id);

  riders.forEach(function(rider){
    var filter = 'all', hide = false;
    function apply(){
      rider.querySelectorAll('.row').forEach(function(r){
        var show = (filter === 'all' || r.dataset.disc === filter) && !(hide && r.dataset.rating === 'nogo');
        r.classList.toggle('hidden', !show);
      });
    }
    rider.querySelectorAll('.chip').forEach(function(c){
      c.addEventListener('click', function(){
        rider.querySelectorAll('.chip').forEach(function(x){ x.classList.remove('on'); });
        c.classList.add('on'); filter = c.dataset.f; apply();
      });
    });
    rider.querySelector('.hideNogo').addEventListener('change', function(e){ hide = e.target.checked; apply(); });
  });
})();
"""


def render(riders, updated, days, demo=False):
    ids = []
    for e in riders:
        sid = slug(e["rider"]["name"])
        while sid in ids:
            sid += "-2"
        ids.append(sid)
    switcher = ""
    if len(riders) > 1:
        switcher = '<div class="riders" role="group" aria-label="Choose rider">' + "".join(
            f'<button class="rider-btn" data-id="{sid}" aria-pressed="false">{escape(e["rider"]["name"])}</button>'
            for e, sid in zip(riders, ids)) + "</div>"
    else:
        switcher = f'<p>Scores for {escape(riders[0]["rider"]["name"])}\'s gear.</p>'
    banner = '<p class="demo">Sample data for preview only. This is not a real forecast.</p>' if demo else ""
    stamp = updated.strftime("%a %-d %b at %-I:%M%p").replace("AM", "am").replace("PM", "pm")
    body = "".join(render_rider(e, sid) for e, sid in zip(riders, ids))
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Foil forecast</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌊</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@500;600;700&family=Barlow:wght@400;500&display=swap" rel="stylesheet">
<style>{CSS}</style></head>
<body><main>
<header>
  <h1>Foil forecast</h1>
  <p>Updated {stamp}. Daylight hours, next {days} days.</p>
  {banner}
  {switcher}
</header>
{body}
<footer>Scores run from 0 to 10 for each daylight hour. Conditions (direction, gusts, swell) are the same for everyone;
gear fit uses each rider's weight, boards, wings and front wings from config.yaml.
Arrows show which way the wind is blowing. Tap a row for hour-by-hour numbers. Forecast data from Open-Meteo.
Always check conditions on the beach before going out.</footer>
</main>
<script>{JS}</script>
</body></html>"""


# ================================================================ alerts

def send_alerts(riders, cfg, updated):
    a = cfg.get("alerts", {})
    limit = updated.replace(tzinfo=None) + timedelta(hours=a.get("lookahead_hours", 48))
    try:
        secrets = json.loads(os.environ.get("SECRETS_JSON") or "{}")
    except ValueError:
        secrets = {}
    for e in riders:
        key = e["rider"].get("alert_secret")
        topic = secrets.get(key) or (os.environ.get(key) if key else None)
        if not topic:
            continue
        hits = []
        for r in best_bets(e["results"], n=20):
            peak = r["rows"][r["window"][2]]
            if win_score(r) >= a.get("threshold", 7.5) and datetime.fromisoformat(peak["time"]) <= limit:
                hits.append(f"{DISC_NAMES[r['disc']]} at {r['spot']['name']}: "
                            f"{day_label(r['day'], False)} {window_label(r)} ({win_score(r):.1f})")
        if not hits:
            continue
        req = urllib.request.Request(
            f"https://ntfy.sh/{topic}", data="\n".join(hits[:5]).encode(),
            headers={"Title": "Foil forecast: good sessions coming", "Tags": "ocean"})
        try:
            urllib.request.urlopen(req, timeout=15)
        except Exception as exc:
            print(f"warning: alert failed for {e['rider']['name']}: {exc}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", default="config.yaml")
    ap.add_argument("--out", default="site/index.html")
    ap.add_argument("--demo", action="store_true", help="use synthetic data, no network")
    args = ap.parse_args()
    with open(args.config) as f:
        cfg = yaml.safe_load(f)
    riders, updated = build(cfg, demo=args.demo)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(render(riders, updated, cfg["days"], demo=args.demo))
    if not args.demo:
        send_alerts(riders, cfg, updated)
    for e in riders:
        print(f"{e['rider']['name']}: {len(e['results'])} spot-days scored")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
