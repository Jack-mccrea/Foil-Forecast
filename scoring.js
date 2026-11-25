/* Foil Forecast scoring engine.
 * Pure functions, no DOM. Used by the app and by tests in Node.
 *
 * Scores combine two layers:
 *   conditions - wind direction against the beach, gusts, swell. Same for everyone.
 *   gear fit   - how well the wind suits each rider's weight, boards, wings and
 *                front wings, estimated from rules of thumb or set by override.
 */
(function (root) {
  'use strict';

  const DISC_NAMES = { wing: 'Wing', downwind: 'Downwind', prone: 'Prone', sup: 'SUP' };
  const DISC_ORDER = { wing: 0, downwind: 1, prone: 2, sup: 3 };
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const SURF_DEFAULTS = {
    prone: { min_height: 0.3, ideal_height: [0.6, 1.8], max_height: 3.0, glassy_wind: 6, calm_wind: 10 },
    sup: { min_height: 0.2, ideal_height: [0.4, 1.5], max_height: 2.5, glassy_wind: 5, calm_wind: 8 },
  };

  // ------------------------------------------------------------ helpers
  const first = (...v) => { for (const x of v) if (x !== null && x !== undefined) return x; return null; };
  const compass = (deg) => COMPASS[Math.floor(((deg % 360) + 360) % 360 / 22.5 + 0.5) % 16];
  function angdiff(a, b) { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
  function inWindow(deg, lo, hi) { const m = (x) => ((x % 360) + 360) % 360; return m(deg - lo) <= m(hi - lo); }
  const ramp = (x, x0, x1, y0, y1) => (x1 === x0 ? y1 : y0 + (y1 - y0) * (x - x0) / (x1 - x0));
  const clamp = (x, lo = 0, hi = 10) => Math.max(lo, Math.min(hi, x));
  const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rider';
  const hasWindow = (w) => Array.isArray(w) && w.length === 2 && w.every((x) => Number.isFinite(Number(x))) && !(Number(w[0]) === 0 && Number(w[1]) === 0);

  function swellText(h, combined) {
    if (combined) {
      const hgt = first(h.wave_height, h.swell_wave_height);
      const sd = first(h.wave_direction, h.swell_wave_direction);
      if (hgt === null) return 'no wave data';
      return `${hgt.toFixed(1)} m sea` + (sd !== null ? ` from the ${compass(sd)}` : '');
    }
    const hgt = first(h.swell_wave_height, h.wave_height);
    const per = first(h.swell_wave_period, h.wave_period);
    const sd = first(h.swell_wave_direction, h.wave_direction);
    if (hgt === null) return 'no wave data';
    let t = `${hgt.toFixed(1)} m`;
    if (per !== null) t += ` at ${Math.round(per)} s`;
    if (sd !== null) t += ` ${compass(sd)}`;
    return t;
  }

  // ------------------------------------------------------------ gear model
  // Rules of thumb, tuned so an 80 kg rider on a 5 m wing has a sweet spot of
  // roughly 14-20 knots. Riders can override any combo.
  const WING_POWER = 17.0;
  const REF_LOADING = 13.0;
  const ASPECT = {
    low: { low: 0.96, top: 0.92 },
    mid: { low: 1.00, top: 1.00 },
    high: { low: 1.06, top: 1.10 },
  };
  const DW_LEVEL = { beginner: 3, intermediate: 0, advanced: -2 };

  const boardFactor = (volume, weight) => clamp(1 + (1 - volume / weight) * 0.4, 0.9, 1.15);
  function foilFactors(foil, weight) {
    const loading = foil.area / weight;
    const a = ASPECT[foil.type] || ASPECT.mid;
    return [Math.pow(REF_LOADING / loading, 0.25) * a.low, Math.pow(REF_LOADING / loading, 0.3) * a.top];
  }
  function wingRange(rider, board, m2, foil) {
    const mid = Math.sqrt(WING_POWER * rider.weight / m2);
    const [low, top] = foilFactors(foil, rider.weight);
    const lo = mid * 0.82, hi = mid * 1.22;
    const mn = Math.min(mid * 0.68 * boardFactor(board.volume, rider.weight) * low, lo - 1);
    return { min: mn, ideal: [lo, hi], max: Math.max(mid * 1.55 * top, hi * 1.08) };
  }
  function downwindRange(rider, board, foil) {
    const [low, top] = foilFactors(foil, rider.weight);
    const off = DW_LEVEL[rider.downwind_level] ?? 0;
    const mn = 13 * low * boardFactor(board.volume, rider.weight) + off;
    const hi = Math.max(mn + 6, 24 * top - Math.max(off, 0));
    return { min: mn, ideal: [mn + 3, hi], max: Math.max(32 * top - 2 * Math.max(off, 0), hi + 3) };
  }
  function windFit(w, r) {
    const [lo, hi] = r.ideal;
    if (w < r.min || w > r.max) return 0;
    if (w < lo) return ramp(w, r.min, lo, 3, 10);
    if (w <= hi) return 10;
    return ramp(w, hi, r.max, 10, 4);
  }
  const wingLabel = (m2, foil) => `${Number(m2).toFixed(1)}m + ${foil.name}`;

  function validOverride(o) {
    return o && [o.min, o.max].every(Number.isFinite) && Array.isArray(o.ideal) && o.ideal.every(Number.isFinite);
  }

  /** Every usable gear combination per sport, with its wind range. */
  function buildCombos(rider) {
    const over = rider.overrides || {};
    const combos = { wing: [], downwind: [], prone: [], sup: [] };
    const seen = { wing: new Set(), downwind: new Set() };
    for (const board of rider.boards || []) {
      const uses = board.use || [];
      for (const foil of rider.foils || []) {
        const fuse = foil.use || [];
        if (!foil.area || !rider.weight || !board.volume) continue;
        if (uses.includes('wing') && fuse.includes('wing')) {
          for (const m2 of rider.wings || []) {
            if (!(Number(m2) > 0)) continue;
            const label = wingLabel(m2, foil);
            if (seen.wing.has(label)) continue;
            seen.wing.add(label);
            const auto = wingRange(rider, board, Number(m2), foil);
            combos.wing.push({ label, auto, range: validOverride(over[label]) ? over[label] : auto, overridden: validOverride(over[label]) });
          }
        }
        if (uses.includes('downwind') && fuse.includes('downwind')) {
          const label = foil.name;
          if (seen.downwind.has(label)) continue;
          seen.downwind.add(label);
          const auto = downwindRange(rider, board, foil);
          combos.downwind.push({ label, auto, range: validOverride(over[label]) ? over[label] : auto, overridden: validOverride(over[label]) });
        }
      }
    }
    for (const d of ['prone', 'sup']) combos[d] = (rider.foils || []).filter((f) => (f.use || []).includes(d) && f.area);
    return combos;
  }

  /** Best-fitting gear for a wind speed. Ties go to the combo nearest its sweet-spot middle. */
  function bestCombo(w, combos) {
    let best = [0, null], bestKey = null;
    for (const c of combos) {
      const s = windFit(w, c.range);
      if (s <= 0) continue;
      const key = [s, -Math.abs(w - (c.range.ideal[0] + c.range.ideal[1]) / 2)];
      if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
        best = [s, c.label]; bestKey = key;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ scoring
  /** Forecast gusts near the coast often run far above what you feel on the water,
   *  so the penalty is based on the gust-to-average ratio and capped at 2 points. */
  function gustPenalty(w, g, warn) {
    if (!g || w < 5) return 0;
    const ratio = g / w;
    if (ratio > 1.7) warn.push('gusty');
    return Math.min(2, Math.max(0, (ratio - 1.5) * 4));
  }

  function blockedCheck(d, spot, why, warn) {
    const b = spot.blocked_wind;
    if (hasWindow(b) && inWindow(d, Number(b[0]), Number(b[1]))) {
      warn.push('hill shadow, patchy wind');
      return 0.4;
    }
    return 1;
  }

  function scoreWing(h, spot, combos) {
    const w = h.wind, g = h.gust, d = h.wdir;
    if (w === null || w === undefined || d === null || d === undefined) return null;
    let [s, kit] = bestCombo(w, combos);
    s *= 0.9; // headroom for the swell bonus
    const why = [], warn = [];
    s -= gustPenalty(w, g, warn);
    const rel = angdiff(d, spot.faces);
    if (rel <= 30) { s *= spot.onshore_ok ? 1 : 0.9; why.push('onshore'); }
    else if (rel <= 120) why.push('cross-shore');
    else if (rel <= 150) { s *= 0.6; why.push('cross-offshore'); warn.push('cross-offshore'); }
    else { s *= spot.offshore_ok ? 0.6 : 0.15; why.push('offshore'); warn.push('offshore wind, drift risk'); }
    s *= blockedCheck(d, spot, why, warn);
    const hgt = first(h.swell_wave_height, h.wave_height);
    if (hgt !== null) {
      if (hgt >= 0.4 && hgt <= 3.0) { s += 1; why.push('swell to ride'); }
      else if (hgt > 3.5) { s -= 1.5; warn.push('big swell'); }
    }
    if (kit === null) why.unshift(w < 12 ? 'too light' : 'too strong for your gear');
    return [clamp(s), why, warn, kit];
  }

  function scoreDownwind(h, spot, combos) {
    const dw = spot.downwind;
    const w = h.wind, g = h.gust, d = h.wdir;
    if (!dw || w === null || w === undefined || d === null || d === undefined) return null;
    let [s, kit] = bestCombo(w, combos);
    const why = [], warn = [];
    const tol = dw.tolerance || 30;
    const diff = angdiff(d, dw.wind_from);
    if (diff <= tol * 0.6) why.push('wind lined up with the run');
    else if (diff <= tol) { s *= 0.75; why.push('wind slightly off the run'); }
    else if (diff <= tol * 1.7) { s *= 0.4; why.push('wind well off the run'); }
    else { s *= 0.05; why.push('wrong direction for the run'); }
    const bumps = first(h.wind_wave_height, h.wave_height);
    if (bumps === null) s *= 0.85;
    else if (bumps < 0.3) { s *= 0.55; why.push('small bumps'); }
    else if (bumps < 0.6) s *= 0.85;
    else why.push('good bumps');
    s -= gustPenalty(w, g, warn);
    if (kit === null) why.unshift(w < 14 ? 'too light' : 'too strong for your gear');
    return [clamp(s), why, warn, kit];
  }

  function scoreSurf(h, spot, p, foils) {
    const hgt = first(h.swell_wave_height, h.wave_height);
    const per = first(h.swell_wave_period, h.wave_period);
    const sd = first(h.swell_wave_direction, h.wave_direction);
    const w = h.wind, d = h.wdir;
    if (hgt === null || w === null || w === undefined) return null;
    const why = [], warn = [];
    const [lo, hi] = p.ideal_height;
    let s;
    if (hgt < p.min_height) { s = 0; why.push('too small'); }
    else if (hgt < lo) s = ramp(hgt, p.min_height, lo, 4, 10);
    else if (hgt <= hi) s = 10;
    else if (hgt <= p.max_height) { s = ramp(hgt, hi, p.max_height, 10, 4); warn.push('solid size'); }
    else { s = 2; warn.push('big swell'); }
    if (per !== null) {
      if (per < 6) { s *= 0.5; why.push('short, weak period'); }
      else if (per < 8) s *= 0.75;
      else if (per < 11) s *= 0.9;
      else why.push('long-period swell');
    }
    if (sd !== null && hasWindow(spot.swell_window)) {
      const [a, b] = spot.swell_window.map(Number);
      if (!inWindow(sd, a, b)) {
        if (Math.min(angdiff(sd, a), angdiff(sd, b)) <= 20) { s *= 0.6; why.push('swell direction marginal'); }
        else { s *= 0.2; why.push('swell direction misses the break'); }
      }
    }
    const rel = d !== null && d !== undefined ? angdiff(d, spot.faces) : 90;
    if (w <= p.glassy_wind) why.push('light wind');
    else if (rel > 120 && w <= 15) { if (w > 10) s *= 0.85; why.push('offshore, groomed'); }
    else if (w <= p.calm_wind) s *= 0.75;
    else if (w <= p.calm_wind + 6) { s *= 0.45; why.push('wind chop'); }
    else { s *= 0.2; why.push('blown out'); }
    // Bigger front wing for small, weak waves; smaller for punchy ones.
    let kit = null;
    if (foils && foils.length) {
      const ordered = [...foils].sort((x, y) => x.area - y.area);
      kit = (hgt < 0.8 ? ordered[ordered.length - 1] : ordered[0]).name;
    }
    return [clamp(s), why, warn, kit];
  }

  function surfParams(cfg, disc) {
    return Object.assign({}, SURF_DEFAULTS[disc], (cfg && cfg[disc]) || {});
  }

  function scoreHour(disc, h, spot, cfg, combos) {
    if (disc === 'wing') return scoreWing(h, spot, combos.wing);
    if (disc === 'downwind') return scoreDownwind(h, spot, combos.downwind);
    return scoreSurf(h, spot, surfParams(cfg, disc), combos[disc]);
  }

  // ------------------------------------------------------------ windows
  function isDaylight(t, daylight) {
    const dl = daylight[t.slice(0, 10)];
    if (!dl) return false;
    const [sunrise, sunset] = dl;
    // Hour t covers t..t+1h; daylight if it overlaps sunrise..sunset.
    const plusHour = shiftHour(t, 1);
    return plusHour > sunrise && t < sunset;
  }
  function shiftHour(t, n) {
    const d = new Date(t + ':00Z');
    d.setUTCHours(d.getUTCHours() + n);
    return d.toISOString().slice(0, 16);
  }

  /** Consecutive hours around the best pair of hours. Returns [start, end, peak]. */
  function bestWindow(rows) {
    const sc = rows.map((r) => r.score);
    if (!sc.length || Math.max(...sc) <= 0) return null;
    const pair = sc.length > 1 ? sc.slice(0, -1).map((v, i) => (v + sc[i + 1]) / 2) : sc;
    let i = 0;
    for (let k = 1; k < pair.length; k++) if (pair[k] > pair[i]) i = k;
    const peak = (pair.length === sc.length || sc[i] >= sc[i + 1]) ? i : i + 1;
    const floor = Math.max(sc[peak] - 1.5, 3);
    let start = peak, end = peak;
    while (start > 0 && sc[start - 1] >= floor) start--;
    while (end < sc.length - 1 && sc[end + 1] >= floor) end++;
    return [start, end, peak];
  }
  function winScore(r) {
    if (!r.window) return 0;
    const [s, e] = r.window;
    const vals = r.rows.slice(s, e + 1).map((h) => h.score);
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
  }
  const riderHasGear = (disc, combos) => (disc === 'wing' || disc === 'downwind') ? combos[disc].length > 0 : true;

  /** Score every daylight hour from `fromTime` onward for one rider at every spot. */
  function buildResults(cfg, rider, weather, fromTime) {
    const combos = buildCombos(rider);
    const results = [];
    for (const spot of cfg.spots || []) {
      const wx = weather[spotKey(spot)];
      if (!wx) continue;
      for (const disc of spot.disciplines || []) {
        if (!(rider.sports || []).includes(disc) || !riderHasGear(disc, combos)) continue;
        if (disc === 'downwind' && !spot.downwind) continue;
        const byDay = {};
        for (const h of wx.hours) {
          if (fromTime && shiftHour(h.time, 1) <= fromTime) continue;
          if (!isDaylight(h.time, wx.daylight)) continue;
          const res = scoreHour(disc, h, spot, cfg, combos);
          if (!res) continue;
          const [score, why, warn, kit] = res;
          (byDay[h.time.slice(0, 10)] ||= []).push(Object.assign({}, h, { score: Math.round(score * 10) / 10, why, warn, kit }));
        }
        for (const day of Object.keys(byDay).sort()) {
          const rows = byDay[day];
          results.push({ spot, disc, day, rows, window: bestWindow(rows) });
        }
      }
    }
    return { results, combos };
  }

  /** Score for one hour, used to compare logged sessions with what was forecast. */
  function scoreAt(cfg, rider, spot, disc, time, weather) {
    const wx = weather[spotKey(spot)];
    if (!wx) return null;
    const h = wx.hours.find((x) => x.time === time);
    if (!h) return null;
    const res = scoreHour(disc, h, spot, cfg, buildCombos(rider));
    return res ? Math.round(res[0] * 10) / 10 : null;
  }

  function bestBets(results, n = 5, filter) {
    const picks = results.filter((r) => r.window && winScore(r) >= 4 && (!filter || filter(r)));
    picks.sort((a, b) => (winScore(b) + 0.15 * Math.min(b.window[1] - b.window[0] + 1, 4)) -
      (winScore(a) + 0.15 * Math.min(a.window[1] - a.window[0] + 1, 4)));
    return picks.slice(0, n);
  }

  /** High and low tides for one day from an hourly sea-level series. */
  function tideTurns(hours, day) {
    const out = [];
    const idx = hours.map((h, i) => i).filter((i) => hours[i].time.startsWith(day));
    for (const i of idx) {
      if (i === 0 || i === hours.length - 1) continue;
      const a = hours[i - 1].tide, b = hours[i].tide, c = hours[i + 1].tide;
      if (a === null || b === null || c === null || a === undefined || b === undefined || c === undefined) continue;
      if (b > a && b >= c) out.push({ type: 'High', time: hours[i].time, h: b });
      else if (b < a && b <= c) out.push({ type: 'Low', time: hours[i].time, h: b });
    }
    return out;
  }

  const spotKey = (spot) => `${spot.name}|${spot.lat}|${spot.lon}|${spot.marine_lat ?? ''}|${spot.marine_lon ?? ''}`;

  const api = {
    DISC_NAMES, DISC_ORDER, COMPASS, SURF_DEFAULTS,
    first, compass, angdiff, inWindow, ramp, clamp, slug, hasWindow, swellText,
    wingRange, downwindRange, windFit, buildCombos, bestCombo, wingLabel,
    gustPenalty, scoreWing, scoreDownwind, scoreSurf, scoreHour, surfParams,
    isDaylight, shiftHour, bestWindow, winScore, buildResults, scoreAt, bestBets, tideTurns, spotKey,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Foil = api;
})(typeof self !== 'undefined' ? self : this);
