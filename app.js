/* Foil Forecast app: live forecast fetch, rendering and in-app settings.
 * Scoring lives in scoring.js (window.Foil). */
(function () {
  'use strict';
  const F = window.Foil;
  const TZ_DEFAULT = 'Pacific/Auckland';
  const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
  const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
  const WIND_VARS = ['wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'temperature_2m'];
  const MARINE_VARS = ['wave_height', 'wave_direction', 'wave_period', 'wind_wave_height', 'wind_wave_direction',
    'wind_wave_period', 'swell_wave_height', 'swell_wave_direction', 'swell_wave_period',
    'sea_level_height_msl', 'sea_surface_temperature'];
  const STALE_MIN = 60;
  const K = { settings: 'foil.settings.v2', base: 'foil.base.v2', wx: 'foil.forecast.v2', rider: 'foil.rider', ui: 'foil.ui.v1', log: 'foil.sessions.v1' };
  const SPORTS = ['wing', 'downwind', 'prone', 'sup'];
  const RATING_WORDS = ['', 'Poor', 'Meh', 'OK', 'Good', 'Epic'];

  // ============================================================ storage
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  // ============================================================ state
  const S = {
    base: null, baseHash: null, cfg: null, local: false, baseChanged: false,
    riderId: null, weather: null, fetchedAt: null, wxSig: null, error: null, loading: false,
    view: 'forecast', demo: /[?&]demo\b/.test(location.search), installEvt: null,
    ui: Object.assign({ sport: 'all', spot: 'all', hideNogo: false }, store.get(K.ui, {})),
    open: new Set(), logDraft: { rating: 0 }, importOpen: false,
  };

  // ============================================================ small helpers
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function hash(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  const tz = () => (S.cfg && S.cfg.timezone) || TZ_DEFAULT;

  function nowLocal() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }
  const today = () => nowLocal().slice(0, 10);
  function addDays(day, n) { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function hourLabel(t) { const h = Number(t.slice(11, 13)); return `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`; }
  function clockLabel(t) { const h = Number(t.slice(11, 13)), m = t.slice(14, 16); return `${h % 12 || 12}:${m}${h < 12 ? 'am' : 'pm'}`; }
  function dayLabel(day, long = true) {
    const d = new Date(day + 'T12:00:00Z');
    const t = today();
    if (day === t) return long ? 'Today' : 'Today';
    if (day === addDays(t, 1)) return 'Tomorrow';
    if (day === addDays(t, -1)) return 'Yesterday';
    return d.toLocaleDateString('en-NZ', long ? { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' } : { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  function rating(score) {
    if (score >= 8) return ['epic', 'Epic'];
    if (score >= 6) return ['good', 'Good'];
    if (score >= 4) return ['fair', 'Fair'];
    if (score >= 2) return ['marginal', 'Marginal'];
    return ['nogo', 'No go'];
  }
  function ago(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  }
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 2600);
  }

  // ============================================================ settings
  function riderIds() {
    const ids = [];
    for (const r of S.cfg.riders || []) { let id = F.slug(r.name); while (ids.includes(id)) id += '-2'; ids.push(id); }
    return ids;
  }
  function riderIndex() { const ids = riderIds(); const i = ids.indexOf(S.riderId); return i < 0 ? 0 : i; }
  function currentRider() { return (S.cfg.riders || [])[riderIndex()] || null; }

  function persist() {
    store.set(K.settings, { cfg: S.cfg, baseHash: S.baseHash, savedAt: Date.now() });
    S.local = true;
  }

  async function loadBase() {
    try {
      const res = await fetch('config.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      const base = await res.json();
      store.set(K.base, base);
      return base;
    } catch (e) {
      return store.get(K.base);
    }
  }

  async function initSettings() {
    S.base = await loadBase();
    if (!S.base) S.base = { timezone: TZ_DEFAULT, days: 7, riders: [], spots: [] };
    S.baseHash = hash(JSON.stringify(S.base));
    const local = store.get(K.settings);
    if (local && local.cfg && Array.isArray(local.cfg.riders) && Array.isArray(local.cfg.spots)) {
      S.cfg = local.cfg; S.local = true;
      S.baseChanged = local.baseHash && local.baseHash !== S.baseHash;
    } else {
      S.cfg = clone(S.base);
    }
    S.cfg.riders ||= []; S.cfg.spots ||= [];
    const fromHash = decodeURIComponent(location.hash.slice(1));
    const ids = riderIds();
    S.riderId = ids.includes(fromHash) ? fromHash : (ids.includes(store.get(K.rider)) ? store.get(K.rider) : ids[0]);
  }

  // ============================================================ weather
  const validSpot = (s) => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon));
  const wxSignature = () => hash((S.cfg.spots || []).filter(validSpot).map(F.spotKey).join(';') + '|' + (S.cfg.days || 7) + '|' + tz());

  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j && j.reason) msg = j.reason; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return res.json();
  }
  function qs(o) { return Object.entries(o).map(([k, v]) => `${k}=${String(v).split(',').map(encodeURIComponent).join(',')}`).join('&'); }

  function mergeSpot(wind, marine) {
    const wh = wind.hourly;
    const mh = (marine && marine.hourly) || {};
    const mIndex = {};
    (mh.time || []).forEach((t, i) => { mIndex[t] = i; });
    const pick = (k, i) => (mh[k] && i !== undefined ? mh[k][i] : null);
    const hours = wh.time.map((t, i) => {
      const m = mIndex[t];
      return {
        time: t,
        wind: wh.wind_speed_10m[i],
        gust: F.first(wh.wind_gusts_10m[i], wh.wind_speed_10m[i]),
        wdir: wh.wind_direction_10m[i],
        temp: wh.temperature_2m ? wh.temperature_2m[i] : null,
        wave_height: pick('wave_height', m), wave_direction: pick('wave_direction', m), wave_period: pick('wave_period', m),
        wind_wave_height: pick('wind_wave_height', m), wind_wave_direction: pick('wind_wave_direction', m), wind_wave_period: pick('wind_wave_period', m),
        swell_wave_height: pick('swell_wave_height', m), swell_wave_direction: pick('swell_wave_direction', m), swell_wave_period: pick('swell_wave_period', m),
        tide: pick('sea_level_height_msl', m), sst: pick('sea_surface_temperature', m),
      };
    }).filter((h) => h.wind !== null && h.wind !== undefined);
    const d = wind.daily || { time: [] };
    const daylight = {};
    d.time.forEach((day, i) => { daylight[day] = [d.sunrise[i], d.sunset[i]]; });
    return { hours, daylight };
  }

  async function fetchWeather() {
    const spots = (S.cfg.spots || []).filter(validSpot);
    if (!spots.length) return {};
    const common = { timezone: tz(), forecast_days: S.cfg.days || 7, past_days: 1 };
    let wind = await getJSON(`${FORECAST_URL}?${qs(Object.assign({
      latitude: spots.map((s) => s.lat).join(','), longitude: spots.map((s) => s.lon).join(','),
      hourly: WIND_VARS.join(','), daily: 'sunrise,sunset', wind_speed_unit: 'kn',
    }, common))}`);
    if (!Array.isArray(wind)) wind = [wind];
    const mlat = (s) => s.marine_lat ?? s.lat, mlon = (s) => s.marine_lon ?? s.lon;
    let marine;
    try {
      marine = await getJSON(`${MARINE_URL}?${qs(Object.assign({
        latitude: spots.map(mlat).join(','), longitude: spots.map(mlon).join(','), hourly: MARINE_VARS.join(','),
      }, common))}`);
      if (!Array.isArray(marine)) marine = [marine];
    } catch (e) {
      // One point outside the wave model can fail the batch; fall back to one request per spot.
      marine = await Promise.all(spots.map((s) => getJSON(`${MARINE_URL}?${qs(Object.assign({
        latitude: mlat(s), longitude: mlon(s), hourly: MARINE_VARS.join(','),
      }, common))}`).catch(() => null)));
    }
    const out = {};
    spots.forEach((s, i) => { out[F.spotKey(s)] = mergeSpot(wind[i], marine[i]); });
    return out;
  }

  function demoWeather() {
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const uni = (a, b) => a + (b - a) * rnd();
    const out = {};
    const start = addDays(today(), -1);
    for (const spot of (S.cfg.spots || []).filter(validSpot)) {
      const hours = [], daylight = {};
      const baseDir = [170, 200, 330, 350][Math.floor(rnd() * 4)];
      for (let d = 0; d < (S.cfg.days || 7) + 1; d++) {
        const day = addDays(start, d);
        daylight[day] = [`${day}T05:52`, `${day}T20:31`];
        const dayWind = uni(5, 26), dayDir = (baseDir + uni(-60, 60) + 360) % 360, swell = uni(0.3, 2.4);
        for (let h = 0; h < 24; h++) {
          const w = Math.max(1, dayWind * (1 + 0.25 * Math.sin((h - 9) / 24 * 2 * Math.PI)) + uni(-2, 2));
          const t = (d * 24 + h);
          hours.push({
            time: `${day}T${String(h).padStart(2, '0')}:00`,
            wind: +w.toFixed(1), gust: +(w * uni(1.15, 1.5)).toFixed(1), wdir: Math.round((dayDir + uni(-15, 15) + 360) % 360), temp: +uni(13, 19).toFixed(1),
            wave_height: +(swell + w / 30).toFixed(2), wave_direction: Math.round((spot.faces + uni(-40, 40) + 360) % 360), wave_period: +uni(6, 13).toFixed(1),
            wind_wave_height: +(w / 25).toFixed(2), wind_wave_direction: Math.round(dayDir), wind_wave_period: +uni(3, 6).toFixed(1),
            swell_wave_height: +swell.toFixed(2), swell_wave_direction: Math.round((spot.faces + uni(-45, 45) + 360) % 360), swell_wave_period: +uni(7, 14).toFixed(1),
            tide: +(0.7 * Math.sin((t / 12.42) * 2 * Math.PI)).toFixed(2), sst: 14.2,
          });
        }
      }
      out[F.spotKey(spot)] = { hours, daylight };
    }
    return out;
  }

  /** Apply each spot's wave_factor (beach gets less than the offshore model point). */
  function scaledWeather() {
    if (!S.weather) return {};
    const out = Object.assign({}, S.weather);
    for (const spot of S.cfg.spots || []) {
      const f = Number(spot.wave_factor);
      const key = F.spotKey(spot);
      if (!out[key] || !f || f === 1) continue;
      out[key] = Object.assign({}, out[key], {
        hours: out[key].hours.map((h) => Object.assign({}, h, {
          wave_height: h.wave_height === null ? null : h.wave_height * f,
          wind_wave_height: h.wind_wave_height === null ? null : h.wind_wave_height * f,
          swell_wave_height: h.swell_wave_height === null ? null : h.swell_wave_height * f,
        })),
      });
    }
    return out;
  }

  async function refresh(force) {
    const sig = wxSignature();
    if (S.demo) { S.weather = demoWeather(); S.fetchedAt = Date.now(); S.wxSig = sig; render(); return; }
    const cached = store.get(K.wx);
    if (!S.weather && cached && cached.sig === sig) { S.weather = cached.data; S.fetchedAt = cached.at; S.wxSig = sig; render(); }
    const fresh = S.weather && S.wxSig === sig && S.fetchedAt && Date.now() - S.fetchedAt < STALE_MIN * 60000;
    if (fresh && !force) return;
    if (S.loading) return;
    S.loading = true; S.error = null; render();
    try {
      const data = await fetchWeather();
      S.weather = data; S.fetchedAt = Date.now(); S.wxSig = sig;
      store.set(K.wx, { sig, at: S.fetchedAt, data });
    } catch (e) {
      S.error = navigator.onLine === false ? 'You are offline.' : `Couldn't reach the forecast service (${e.message}).`;
      if (S.wxSig !== sig) { S.weather = null; }
    } finally {
      S.loading = false; render();
    }
  }

  // ============================================================ rendering: shell
  function renderRiders() {
    const ids = riderIds();
    const box = $('#riders');
    box.innerHTML = (S.cfg.riders || []).length > 1 ? S.cfg.riders.map((r, i) =>
      `<button type="button" class="rider-btn" data-rider="${esc(ids[i])}" aria-pressed="${ids[i] === S.riderId}">${esc(r.name || 'Rider')}</button>`).join('') : '';
  }
  function render() {
    renderRiders();
    document.querySelectorAll('.tabs button').forEach((b) => {
      if (b.dataset.view === S.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const v = $('#view');
    if (S.view === 'gear') v.innerHTML = viewGear();
    else if (S.view === 'spots') v.innerHTML = viewSpots();
    else if (S.view === 'log') v.innerHTML = viewLog();
    else v.innerHTML = viewForecast();
    const top = $('.top');
    if (top) document.documentElement.style.setProperty('--top-h', top.offsetHeight + 'px');
  }

  function settingsBanner() {
    if (!S.baseChanged) return '';
    return `<div class="banner"><span class="grow">The shared settings on GitHub have changed since you edited yours on this phone.</span>
      <button class="btn" type="button" data-act="use-shared">Use shared</button>
      <button class="btn ghost" type="button" data-act="keep-local">Keep mine</button></div>`;
  }

  // ============================================================ forecast view
  function viewForecast() {
    const rider = currentRider();
    const demo = S.demo ? '<div class="banner"><span class="grow">Sample data for preview only. This is not a real forecast.</span></div>' : '';
    const status = `<div class="status"><span class="grow">${S.loading ? 'Updating forecast…' : S.fetchedAt ? `Updated ${ago(S.fetchedAt)}` : ''}</span>
      <button class="btn" type="button" data-act="refresh" ${S.loading ? 'disabled' : ''}>Refresh</button></div>`;
    const err = S.error ? `<div class="banner error"><span class="grow">${esc(S.error)} ${S.weather ? 'Showing the last forecast you loaded.' : ''}</span></div>` : '';
    if (!rider) return demo + settingsBanner() + `<div class="card"><h3>Add yourself first</h3><p class="hint">Go to Gear and add a rider with your weight, boards, wings and front wings.</p><button class="btn primary" type="button" data-go="gear">Set up gear</button></div>`;
    if (!S.weather) return demo + settingsBanner() + status + err + (S.loading || !S.error ? '<p class="loading">Loading the forecast…</p>' : '');

    const { results } = F.buildResults(S.cfg, rider, scaledWeather(), nowLocal());
    const horizon = addDays(today(), 1);
    const soon = F.bestBets(results, 1, (r) => r.day <= horizon);
    const week = F.bestBets(results, 6);
    let hero;
    if (soon.length) hero = heroCard(soon[0], 'Next good session');
    else if (week.length) hero = heroCard(week[0], 'Nothing good in the next two days. Best this week');
    else hero = '<div class="hero quiet"><div><div class="eyebrow">This week</div><h3>Nothing worth rigging for</h3><p>Check back after the next forecast update.</p></div></div>';
    const rest = week.filter((r) => !soon.length || r !== soon[0]).slice(0, 4);
    const restHtml = rest.length ? `<h2>Also this week</h2><ul class="bets">${rest.map(betItem).join('')}</ul>` : '';

    const sports = SPORTS.filter((d) => results.some((r) => r.disc === d));
    const spots = [...new Set(results.map((r) => r.spot.name))];
    if (S.ui.sport !== 'all' && !sports.includes(S.ui.sport)) S.ui.sport = 'all';
    if (S.ui.spot !== 'all' && !spots.includes(S.ui.spot)) S.ui.spot = 'all';
    const chip = (kind, val, label) => `<button type="button" class="chip" data-filter="${kind}" data-val="${esc(val)}" aria-pressed="${S.ui[kind] === val}">${esc(label)}</button>`;
    const filters = `<div class="filters">
      <div class="chips" role="group" aria-label="Sport">${chip('sport', 'all', 'All sports')}${sports.map((d) => chip('sport', d, F.DISC_NAMES[d])).join('')}
        <label class="toggle"><input type="checkbox" id="hide-nogo" data-act="hide-nogo" ${S.ui.hideNogo ? 'checked' : ''}> Hide no-go</label></div>
      ${spots.length > 1 ? `<div class="chips" role="group" aria-label="Spot">${chip('spot', 'all', 'All spots')}${spots.map((s) => chip('spot', s, s)).join('')}</div>` : ''}
    </div>`;

    const shown = results.filter((r) => (S.ui.sport === 'all' || r.disc === S.ui.sport) && (S.ui.spot === 'all' || r.spot.name === S.ui.spot));
    const days = {};
    for (const r of shown) (days[r.day] ||= []).push(r);
    const wx = scaledWeather();
    let dayHtml = '';
    for (const day of Object.keys(days).sort()) {
      const rows = days[day].sort((a, b) => F.DISC_ORDER[a.disc] - F.DISC_ORDER[b.disc] || a.spot.name.localeCompare(b.spot.name));
      const visible = rows.filter((r) => !(S.ui.hideNogo && F.winScore(r) < 2));
      if (!visible.length) continue;
      const dl = (wx[F.spotKey(rows[0].spot)] || {}).daylight?.[day];
      dayHtml += `<section class="day"><h2>${esc(dayLabel(day))}${dl ? `<small>${clockLabel(dl[0])} to ${clockLabel(dl[1])}</small>` : ''}</h2>${visible.map((r) => rowHtml(r, wx)).join('')}</section>`;
    }
    if (!dayHtml) dayHtml = '<p class="muted">No sessions match these filters.</p>';

    return demo + settingsBanner() + status + err + hero + restHtml + filters + dayHtml + footer();
  }

  function gearPhrase(kit, disc) { return kit ? (disc === 'prone' || disc === 'sup' ? `With the ${kit}` : `On ${kit}`) : ''; }
  function windowLabel(r) {
    const [s, e] = r.window;
    const start = r.rows[s].time, end = F.shiftHour(r.rows[e].time, 1);
    const dl = (S.weather && S.weather[F.spotKey(r.spot)] || {}).daylight?.[r.day];
    const sunrise = dl && start < dl[0] ? clockLabel(dl[0]) : hourLabel(start);
    const sunset = dl && end > dl[1] ? clockLabel(dl[1]) : hourLabel(end);
    return `${sunrise} to ${sunset}`;
  }
  function summary(row, disc) {
    const parts = [`${Math.round(row.wind)} kn ${F.compass(row.wdir)}, gusting ${Math.round(row.gust)}`];
    if (disc === 'wing') parts.push(F.swellText(row, true));
    else if (disc === 'prone' || disc === 'sup') parts.push(F.swellText(row));
    else { const b = F.first(row.wind_wave_height, row.wave_height); if (b !== null) parts.push(`${b.toFixed(1)} m wind swell`); }
    let t = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('. ') + '.';
    if (row.why.length) { const w = row.why.join(', '); t += ` ${w[0].toUpperCase()}${w.slice(1)}.`; }
    return t;
  }
  function heroCard(r, eyebrow) {
    const peak = r.rows[r.window[2]];
    const sc = F.winScore(r);
    const [cls] = rating(sc);
    const warn = peak.warn.length ? ` <span class="warn">Watch for ${esc(peak.warn.join(', '))}.</span>` : '';
    return `<div class="hero"><span class="big s-${cls} num">${sc.toFixed(1)}</span><div>
      <div class="eyebrow">${esc(eyebrow)}</div>
      <h3>${F.DISC_NAMES[r.disc]} at ${esc(r.spot.name)}</h3>
      <div class="when">${esc(dayLabel(r.day))}, ${windowLabel(r)}</div>
      ${peak.kit ? `<div class="gear">${esc(gearPhrase(peak.kit, r.disc))}</div>` : ''}
      <p>${esc(summary(peak, r.disc))}${warn}</p></div></div>`;
  }
  function betItem(r) {
    const peak = r.rows[r.window[2]];
    const sc = F.winScore(r);
    return `<li class="bet"><span class="pill s-${rating(sc)[0]} num">${sc.toFixed(1)}</span><div>
      <b>${F.DISC_NAMES[r.disc]} at ${esc(r.spot.name)}</b>
      <div class="sub">${esc(dayLabel(r.day, false))}, ${windowLabel(r)}${peak.kit ? ` · ${esc(peak.kit)}` : ''}</div></div></li>`;
  }

  function rowHtml(r, wx) {
    const id = `${r.disc}|${r.spot.name}|${r.day}`;
    const win = r.window;
    const peak = win ? r.rows[win[2]] : null;
    const sc = F.winScore(r);
    const [cls, word] = rating(sc);
    const cells = r.rows.map((h, i) => {
      const [c] = rating(h.score);
      const inwin = win && i >= win[0] && i <= win[1];
      const lbl = Number(h.time.slice(11, 13)) % 3 === 0 ? hourLabel(h.time) : '';
      return `<span class="cell s-${c}${inwin ? ' inwin' : ''}"><i class="arrow" style="transform:rotate(${Math.round(h.wdir)}deg)" aria-hidden="true">↓</i><b class="hr">${lbl}</b></span>`;
    }).join('');
    let best;
    if (win && sc >= 2) {
      const warn = peak.warn.length ? ` <span class="warn">Watch for ${esc(peak.warn.join(', '))}.</span>` : '';
      const g = gearPhrase(peak.kit, r.disc);
      best = `Best ${windowLabel(r)}.${g ? ` ${esc(g)}.` : ''}${warn}`;
    } else {
      const reason = r.rows.find((h) => h.why.length)?.why[0];
      best = `Nothing worth rigging for${reason ? ` (${esc(reason)})` : ''}.`;
    }
    const spotWx = wx[F.spotKey(r.spot)];
    const facts = [];
    if (spotWx && (r.disc === 'prone' || r.disc === 'sup' || r.spot.disciplines.includes('prone'))) {
      const turns = F.tideTurns(spotWx.hours, r.day);
      if (turns.length) facts.push(`Tide (model, approx): ${turns.map((t) => `${t.type} ${hourLabel(t.time)}`).join(' · ')}`);
    }
    const sst = r.rows.find((h) => h.sst !== null && h.sst !== undefined)?.sst;
    if (sst !== undefined) facts.push(`Water ${sst.toFixed(1)}°C`);
    const air = r.rows.find((h) => h.temp !== null && h.temp !== undefined)?.temp;
    if (air !== undefined) facts.push(`Air ${Math.round(air)}°C`);
    const tideAt = (h) => {
      if (h.tide === null || h.tide === undefined || !spotWx) return '';
      const i = spotWx.hours.findIndex((x) => x.time === h.time);
      const nxt = spotWx.hours[i + 1];
      const dir = nxt && nxt.tide !== null && nxt.tide !== undefined ? (nxt.tide > h.tide ? '↑' : '↓') : '';
      return `${h.tide.toFixed(1)} m ${dir}`;
    };
    const detail = r.rows.map((h) => `<tr><td>${hourLabel(h.time)}</td>
      <td><span class="pill s-${rating(h.score)[0]} num">${h.score.toFixed(1)}</span></td>
      <td class="num">${Math.round(h.wind)} / ${Math.round(h.gust)} kn ${F.compass(h.wdir)}</td>
      <td class="num">${esc(F.swellText(h))}</td>
      <td class="num">${tideAt(h)}</td>
      <td>${esc(h.kit || '')}</td>
      <td>${esc([...h.why, ...h.warn].join(', '))}</td></tr>`).join('');
    return `<details class="row" data-id="${esc(id)}" ${S.open.has(id) ? 'open' : ''}>
      <summary>
        <span class="who"><span class="disc">${F.DISC_NAMES[r.disc]}</span><span class="where">${esc(r.spot.name)}</span></span>
        <span class="ribbon" aria-hidden="true">${cells}</span>
        <span class="score s-${cls}"><b class="num">${sc.toFixed(1)}</b><small>${word}</small></span>
        <span class="best">${best}</span>
      </summary>
      <div class="detail">
        ${facts.length ? `<p class="facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</p>` : ''}
        <div class="tablewrap"><table>
          <thead><tr><th>Hour</th><th>Score</th><th>Wind / gust</th><th>Swell</th><th>Tide</th><th>Gear</th><th>Notes</th></tr></thead>
          <tbody>${detail}</tbody></table></div>
      </div></details>`;
  }

  function footer() {
    const install = S.installEvt ? '<p><button class="btn primary" type="button" data-act="install">Install app</button></p>' : '';
    return `<footer class="foot">${install}
      <p>Scores run from 0 to 10 for each daylight hour. Conditions (direction, gusts, swell) are the same for everyone; gear fit uses each rider's weight, boards, wings and front wings. Arrows show which way the wind is blowing. Tap a row for hour-by-hour numbers.</p>
      <p>On iPhone, use Share then Add to Home Screen to install. Forecast data from <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a>. Tide is a model estimate, not for navigation. Always check conditions on the beach before going out.</p>
    </footer>`;
  }

  // ============================================================ gear view
  const sportChecks = (path, list, only) => `<div class="checks">${(only || SPORTS).map((d) =>
    `<label class="check"><input type="checkbox" data-list="${path}" value="${d}" ${(list || []).includes(d) ? 'checked' : ''}> ${F.DISC_NAMES[d]}</label>`).join('')}</div>`;
  const num = (path, val, attrs = '') => `<input type="number" inputmode="decimal" id="${path}" data-path="${path}" data-type="num" value="${val ?? ''}" ${attrs}>`;
  const txt = (path, val, attrs = '') => `<input type="text" id="${path}" data-path="${path}" value="${esc(val ?? '')}" ${attrs}>`;
  const field = (label, control, hint) => `<label class="field"><span>${label}</span>${control}${hint ? `<small>${hint}</small>` : ''}</label>`;

  function viewGear() {
    const i = riderIndex();
    const r = (S.cfg.riders || [])[i];
    let html = settingsBanner() + `<h2>Riders and gear</h2><p class="hint">Changes save on this phone straight away. Each rider's scores use their own weight, boards, wings and front wings.</p>`;
    if (!r) return html + '<div class="section-actions"><button class="btn primary" type="button" data-act="add-rider">Add rider</button></div>' + gearFooter();
    const p = `riders.${i}`;
    html += `<div class="card">
      <div class="grid">
        ${field('Name', txt(`${p}.name`, r.name))}
        ${field('Weight (kg)', num(`${p}.weight`, r.weight, 'min="30" max="150" step="1"'))}
        ${field('Downwind level', `<select id="${p}.downwind_level" data-path="${p}.downwind_level">${['beginner', 'intermediate', 'advanced'].map((l) => `<option ${r.downwind_level === l ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
      </div>
      <div class="field" style="margin-top:10px"><span>Sports</span>${sportChecks(`${p}.sports`, r.sports)}</div>
    </div>`;

    // boards
    html += `<details class="card" open><summary><h3>Boards</h3><span class="chev">›</span></summary>
      ${(r.boards || []).map((b, j) => `<div class="item"><div class="item-head"><strong>${esc(b.name || 'Board')}</strong>
        <button class="btn ghost danger" type="button" data-act="del" data-path="${p}.boards.${j}" data-confirm>Remove</button></div>
        <div class="grid">${field('Name', txt(`${p}.boards.${j}.name`, b.name))}${field('Volume (L)', num(`${p}.boards.${j}.volume`, b.volume, 'min="10" max="250" step="1"'))}</div>
        <div class="field"><span>Used for</span>${sportChecks(`${p}.boards.${j}.use`, b.use)}</div></div>`).join('')}
      <div class="section-actions"><button class="btn" type="button" data-act="add-board">Add board</button></div></details>`;

    // wings
    html += `<details class="card" open><summary><h3>Hand wings</h3><span class="chev">›</span></summary>
      <div class="wing-sizes">${(r.wings || []).map((w, j) => `<span class="w">${num(`${p}.wings.${j}`, w, 'min="1" max="9" step="0.1" aria-label="Wing size in square metres"')}<span class="muted">m²</span>
        <button class="x" type="button" data-act="del" data-path="${p}.wings.${j}" aria-label="Remove wing">×</button></span>`).join('')}
        <button class="btn" type="button" data-act="add-wing">Add wing</button></div></details>`;

    // foils
    html += `<details class="card" open><summary><h3>Front wings</h3><span class="chev">›</span></summary>
      <p class="hint">Area is in cm², usually printed on the wing. Type: low aspect is surfy (Spitfire), mid is ART v2 or Surge, high is ART Pro or Fireball.</p>
      ${(r.foils || []).map((f, j) => `<div class="item"><div class="item-head"><strong>${esc(f.name || 'Front wing')}</strong>
        <button class="btn ghost danger" type="button" data-act="del" data-path="${p}.foils.${j}" data-confirm>Remove</button></div>
        <div class="grid">${field('Name', txt(`${p}.foils.${j}.name`, f.name))}${field('Area (cm²)', num(`${p}.foils.${j}.area`, f.area, 'min="300" max="2500" step="5"'))}
        ${field('Type', `<select id="${p}.foils.${j}.type" data-path="${p}.foils.${j}.type">${['low', 'mid', 'high'].map((t) => `<option value="${t}" ${f.type === t ? 'selected' : ''}>${t} aspect</option>`).join('')}</select>`)}</div>
        <div class="field"><span>Used for</span>${sportChecks(`${p}.foils.${j}.use`, f.use)}</div></div>`).join('')}
      <div class="section-actions"><button class="btn" type="button" data-act="add-foil">Add front wing</button></div></details>`;

    html += `<div class="card ranges"><h3>Wind ranges</h3>
      <p class="hint">Estimated from weight, board volume, wing size and front wing. If a combo doesn't match how it rides, type your own numbers. Clear all four to go back to the estimate.</p>
      <div id="ranges">${rangesTable(r)}</div></div>`;

    html += `<div class="section-actions">
      <button class="btn" type="button" data-act="add-rider">Add rider</button>
      ${(S.cfg.riders || []).length > 1 ? `<button class="btn ghost danger" type="button" data-act="del" data-path="riders.${i}" data-confirm>Remove ${esc(r.name || 'rider')}</button>` : ''}
    </div>`;
    return html + gearFooter();
  }

  function rangesTable(r) {
    const combos = F.buildCombos(r);
    const rows = [];
    for (const disc of ['wing', 'downwind']) {
      for (const c of combos[disc]) {
        const o = (r.overrides || {})[c.label] || {};
        const a = c.auto;
        const inp = (f, val, ph) => `<input type="number" inputmode="decimal" step="1" data-ov="${esc(c.label)}" data-f="${f}" value="${val ?? ''}" placeholder="${Math.round(ph)}" aria-label="${esc(c.label)} ${f}">`;
        rows.push(`<tr><td>${F.DISC_NAMES[disc]}</td><td>${esc(c.label)}${c.overridden ? '' : ' <span class="auto">(estimate)</span>'}</td>
          <td>${inp('min', o.min, a.min)}</td><td>${inp('lo', o.ideal?.[0], a.ideal[0])}</td><td>${inp('hi', o.ideal?.[1], a.ideal[1])}</td><td>${inp('max', o.max, a.max)}</td></tr>`);
      }
    }
    if (!rows.length) return '<p class="muted small">No wing or downwind combos yet. Tick Wing or Downwind on at least one board and one front wing.</p>';
    return `<div class="tablewrap"><table><thead><tr><th>Sport</th><th>Gear</th><th>Gets going</th><th>Sweet spot from</th><th>to</th><th>Overpowered</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div><p class="hint small">All in knots.</p>`;
  }

  function gearFooter() {
    return `<div class="card"><h3>Share or back up settings</h3>
      <p class="hint">Copy your settings to paste into another phone, or into config.yaml on GitHub to make them the shared defaults everyone gets.</p>
      <div class="section-actions">
        <button class="btn" type="button" data-act="export">Copy settings</button>
        <button class="btn" type="button" data-act="import-open">Paste settings</button>
        ${S.local ? '<button class="btn ghost danger" type="button" data-act="reset-shared" data-confirm>Reset to shared settings</button>' : ''}
      </div>
      <div ${S.importOpen ? '' : 'hidden'} id="import-box" style="margin-top:10px">
        <textarea id="import-text" placeholder="Paste settings here" aria-label="Settings to import"></textarea>
        <div class="section-actions"><button class="btn primary" type="button" data-act="import-apply">Use these settings</button></div>
      </div>
      <p class="hint small"><a href="classic.html">Classic dashboard</a> (built twice a day on GitHub, used for phone alerts).</p>
    </div>`;
  }

  // ============================================================ spots view
  function viewSpots() {
    const spots = S.cfg.spots || [];
    let html = settingsBanner() + `<h2>Spots</h2><p class="hint">Directions are compass degrees: N 0, E 90, S 180, W 270. Wind directions are where the wind blows from, the same as Windy.</p>`;
    html += spots.map((s, i) => {
      const p = `spots.${i}`;
      const dl = (s.disciplines || []).includes('downwind');
      return `<details class="card" data-spot="${i}"><summary><h3 data-name-for="${i}">${esc(s.name || 'New spot')}</h3><span class="chev">›</span></summary>
        <div class="grid">
          ${field('Name', txt(`${p}.name`, s.name))}
          ${field('Latitude', num(`${p}.lat`, s.lat, 'step="any"'))}
          ${field('Longitude', num(`${p}.lon`, s.lon, 'step="any"'))}
        </div>
        <div class="section-actions"><button class="btn" type="button" data-act="locate" data-i="${i}">Use my current location</button></div>
        <div class="grid" style="margin-top:12px">
          ${field('Beach faces', num(`${p}.faces`, s.faces, 'min="0" max="359" step="1"'), `Looking out to sea: <span data-compass-for="${p}.faces">${Number.isFinite(Number(s.faces)) ? F.compass(Number(s.faces)) : ''}</span>`)}
          ${field('Swell window from', num(`${p}.swell_window.0`, s.swell_window?.[0], 'min="0" max="359"'))}
          ${field('Swell window to', num(`${p}.swell_window.1`, s.swell_window?.[1], 'min="0" max="359"'), 'Clockwise. 0 and 0 for flat water.')}
          ${field('Hill-shadow wind from', num(`${p}.blocked_wind.0`, s.blocked_wind?.[0], 'min="0" max="359"'))}
          ${field('Hill-shadow wind to', num(`${p}.blocked_wind.1`, s.blocked_wind?.[1], 'min="0" max="359"'), 'Wind directions blocked by land. Leave blank if none.')}
          ${field('Wave factor', num(`${p}.wave_factor`, s.wave_factor, 'min="0.1" max="1.5" step="0.05" placeholder="1"'), 'e.g. 0.8 if the beach gets less swell than forecast.')}
        </div>
        <div class="checks" style="margin-top:12px">
          <label class="check"><input type="checkbox" data-bool="${p}.onshore_ok" ${s.onshore_ok ? 'checked' : ''}> Onshore wind is fine here</label>
          <label class="check"><input type="checkbox" data-bool="${p}.offshore_ok" ${s.offshore_ok ? 'checked' : ''}> Offshore wind is safe here</label>
        </div>
        <details class="card" style="background:var(--sunk)"><summary><span class="small">Forecast point offshore (optional)</span><span class="chev">›</span></summary>
          <div class="grid">${field('Wave latitude', num(`${p}.marine_lat`, s.marine_lat, 'step="any"'))}${field('Wave longitude', num(`${p}.marine_lon`, s.marine_lon, 'step="any"'))}</div>
          <p class="hint small">Used for swell when the wave model has no data right at the beach.</p></details>
        <div class="field" style="margin-top:12px"><span>Score here for</span>${sportChecks(`${p}.disciplines`, s.disciplines)}</div>
        ${dl ? `<div class="grid" style="margin-top:12px">
          ${field('Downwind run', txt(`${p}.downwind.run`, s.downwind?.run))}
          ${field('Best wind from', num(`${p}.downwind.wind_from`, s.downwind?.wind_from, 'min="0" max="359"'), `<span data-compass-for="${p}.downwind.wind_from">${Number.isFinite(Number(s.downwind?.wind_from)) ? F.compass(Number(s.downwind.wind_from)) : ''}</span>`)}
          ${field('Tolerance (°)', num(`${p}.downwind.tolerance`, s.downwind?.tolerance, 'min="5" max="90"'))}</div>` : ''}
        <div class="section-actions"><button class="btn ghost danger" type="button" data-act="del" data-path="${p}" data-confirm>Remove spot</button></div>
      </details>`;
    }).join('');
    html += '<div class="section-actions"><button class="btn primary" type="button" data-act="add-spot">Add spot</button></div>';
    return html;
  }

  // ============================================================ sessions view
  function viewLog() {
    const rider = currentRider();
    if (!rider) return '<p class="muted">Add a rider in Gear first.</p>';
    const rid = S.riderId;
    const spots = (S.cfg.spots || []);
    const d = S.logDraft;
    const nowH = Number(nowLocal().slice(11, 13));
    d.date ||= today(); d.hour ??= Math.max(6, Math.min(20, nowH - 2)); d.spot ??= 0;
    const sp = spots[d.spot] || spots[0];
    const sportsHere = sp ? SPORTS.filter((x) => (sp.disciplines || []).includes(x) && (rider.sports || []).includes(x)) : [];
    if (!sportsHere.includes(d.disc)) d.disc = sportsHere[0];
    const all = store.get(K.log, []).filter((e) => e.rider === rid).sort((a, b) => (b.time > a.time ? 1 : -1));

    let html = `<h2>Log a session</h2>
      <p class="hint">Rate how a session actually felt. Over time this shows where the forecast reads high or low, so you know which wind ranges or spot settings to adjust.</p>
      <div class="card"><div class="grid">
        ${field('Spot', `<select id="log-spot" data-log="spot">${spots.map((s, i) => `<option value="${i}" ${i === d.spot ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`)}
        ${field('Sport', `<select id="log-disc" data-log="disc">${sportsHere.map((x) => `<option value="${x}" ${x === d.disc ? 'selected' : ''}>${F.DISC_NAMES[x]}</option>`).join('')}</select>`)}
        ${field('Date', `<input type="date" id="log-date" data-log="date" value="${d.date}" max="${today()}">`)}
        ${field('Time', `<select id="log-hour" data-log="hour">${Array.from({ length: 17 }, (_, k) => k + 5).map((h) => `<option value="${h}" ${h === Number(d.hour) ? 'selected' : ''}>${hourLabel(`2000-01-01T${String(h).padStart(2, '0')}:00`)}</option>`).join('')}</select>`)}
      </div>
      <div class="field" style="margin-top:12px"><span>How was it?</span><div class="ratings" role="group" aria-label="Rating">${[1, 2, 3, 4, 5].map((v) =>
        `<button type="button" data-act="rate" data-v="${v}" aria-pressed="${d.rating === v}" title="${RATING_WORDS[v]}">${v}</button>`).join('')}</div>
        <small>${d.rating ? RATING_WORDS[d.rating] : '1 poor, 3 OK, 5 epic'}</small></div>
      <div class="grid" style="margin-top:12px">
        ${field('Gear used', `<input type="text" id="log-gear" data-log="gear" value="${esc(d.gear || '')}" placeholder="e.g. 4.5m + Spitfire 900">`)}
        ${field('Notes', `<input type="text" id="log-notes" data-log="notes" value="${esc(d.notes || '')}" placeholder="Gusty in the corner, good swell">`)}
      </div>
      <div class="section-actions"><button class="btn primary" type="button" data-act="log-save" ${d.rating && d.disc ? '' : 'disabled'}>Save session</button></div>
      </div>`;

    // calibration summary
    const groups = {};
    for (const e of all) if (e.predicted !== null && e.predicted !== undefined) (groups[`${e.spot} · ${F.DISC_NAMES[e.disc] || e.disc}`] ||= []).push(e.rating * 2 - e.predicted);
    const summ = Object.entries(groups).filter(([, v]) => v.length >= 2).map(([k, v]) => {
      const g = v.reduce((a, b) => a + b, 0) / v.length;
      const dir = Math.abs(g) < 1 ? 'about right' : g > 0 ? `felt ${g.toFixed(1)} better than forecast` : `felt ${Math.abs(g).toFixed(1)} worse than forecast`;
      return `<li><b>${esc(k)}</b>: ${dir} on average (${v.length} sessions)${Math.abs(g) >= 1.5 ? '. Worth adjusting your wind ranges or this spot\'s settings.' : '.'}</li>`;
    });
    if (summ.length) html += `<h2>How the forecast is doing</h2><ul class="hint">${summ.join('')}</ul>`;

    html += `<h2>Your sessions</h2>`;
    html += all.length ? all.map((e) => {
      const felt = e.rating * 2;
      const gap = e.predicted === null || e.predicted === undefined ? null : felt - e.predicted;
      return `<div class="log-entry"><div><b>${F.DISC_NAMES[e.disc] || esc(e.disc)} at ${esc(e.spot)}</b>
        <div class="muted small">${esc(dayLabel(e.time.slice(0, 10), false))}, ${hourLabel(e.time)}${e.gear ? ` · ${esc(e.gear)}` : ''}${e.notes ? ` · ${esc(e.notes)}` : ''}</div>
        <div class="cmp">${e.predicted === null || e.predicted === undefined ? '<span class="muted">No forecast saved for that time</span>' :
          `<span>Forecast</span><span class="pill s-${rating(e.predicted)[0]} num">${e.predicted.toFixed(1)}</span>`}
          <span>Felt</span><span class="pill s-${rating(felt)[0]} num">${felt}</span>
          ${gap !== null && Math.abs(gap) >= 1 ? `<span class="${gap > 0 ? 'gap-up' : 'gap-down'}">${gap > 0 ? '+' : ''}${gap.toFixed(1)}</span>` : ''}</div></div>
        <button class="x" type="button" data-act="log-del" data-id="${esc(e.id)}" data-confirm aria-label="Delete session">×</button></div>`;
    }).join('') : '<p class="muted">No sessions logged yet. Your first one shows up here with the forecast it had.</p>';
    return html;
  }

  // ============================================================ editing
  function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
  function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    keys.slice(0, -1).forEach((k, i) => {
      if (o[k] === undefined || o[k] === null) o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
      o = o[k];
    });
    const last = keys[keys.length - 1];
    if (value === undefined) { if (Array.isArray(o)) o[last] = null; else delete o[last]; }
    else o[last] = value;
  }
  function deletePath(obj, path) {
    const keys = path.split('.');
    const parent = getPath(obj, keys.slice(0, -1).join('.'));
    const last = keys[keys.length - 1];
    if (Array.isArray(parent)) parent.splice(Number(last), 1); else if (parent) delete parent[last];
  }
  function normalise() {
    for (const s of S.cfg.spots || []) {
      if (Array.isArray(s.blocked_wind) && !s.blocked_wind.every((x) => Number.isFinite(x))) {
        if (s.blocked_wind.every((x) => x === null || x === undefined)) delete s.blocked_wind;
      }
      if (Array.isArray(s.swell_window)) s.swell_window = s.swell_window.map((x) => (Number.isFinite(x) ? x : 0));
      if ((s.disciplines || []).includes('downwind') && !s.downwind) s.downwind = { run: '', wind_from: Number(s.faces) || 0, tolerance: 30 };
      if (s.wave_factor === null) delete s.wave_factor;
    }
    for (const r of S.cfg.riders || []) if (Array.isArray(r.wings)) r.wings = r.wings.filter((w) => w !== null && w !== undefined);
  }
  function afterEdit(path) {
    normalise(); persist();
    if (/^riders\.\d+\.name$/.test(path)) {
      const r = currentRider();
      S.riderId = riderIds()[riderIndex()] ?? F.slug(r?.name || '');
      renderRiders();
    }
    if (/^riders\.\d+\.(weight|boards|wings|foils|downwind_level|overrides)/.test(path)) {
      const box = $('#ranges'); if (box) box.innerHTML = rangesTable(currentRider());
    }
    const cmp = document.querySelector(`[data-compass-for="${CSS.escape(path)}"]`);
    if (cmp) { const v = Number(getPath(S.cfg, path)); cmp.textContent = Number.isFinite(v) ? F.compass(v) : ''; }
    const nm = path.match(/^spots\.(\d+)\.name$/);
    if (nm) { const h = document.querySelector(`[data-name-for="${nm[1]}"]`); if (h) h.textContent = S.cfg.spots[nm[1]].name || 'New spot'; }
  }

  function onFieldChange(el) {
    if (el.dataset.path) {
      let v = el.value;
      if (el.dataset.type === 'num') v = v === '' ? undefined : Number(v);
      if (el.dataset.type === 'num' && v !== undefined && !Number.isFinite(v)) return;
      setPath(S.cfg, el.dataset.path, v);
      afterEdit(el.dataset.path);
    } else if (el.dataset.list) {
      const arr = getPath(S.cfg, el.dataset.list) || [];
      const next = el.checked ? [...new Set([...arr, el.value])] : arr.filter((x) => x !== el.value);
      setPath(S.cfg, el.dataset.list, SPORTS.filter((d) => next.includes(d)));
      afterEdit(el.dataset.list);
      if (/^spots\.\d+\.disciplines$/.test(el.dataset.list) && el.value === 'downwind') render();
      if (/^riders\.\d+\.(boards|foils)\.\d+\.use$/.test(el.dataset.list)) { const box = $('#ranges'); if (box) box.innerHTML = rangesTable(currentRider()); }
    } else if (el.dataset.bool) {
      setPath(S.cfg, el.dataset.bool, el.checked);
      afterEdit(el.dataset.bool);
    } else if (el.dataset.ov) {
      const r = currentRider();
      const label = el.dataset.ov;
      const vals = {};
      document.querySelectorAll(`[data-ov="${CSS.escape(label)}"]`).forEach((x) => { vals[x.dataset.f] = x.value === '' ? null : Number(x.value); });
      r.overrides ||= {};
      if (Object.values(vals).every((x) => x === null)) delete r.overrides[label];
      else if (Object.values(vals).every((x) => Number.isFinite(x))) {
        if (!(vals.min < vals.lo && vals.lo <= vals.hi && vals.hi < vals.max)) { toast('Numbers need to go up from left to right.'); return; }
        r.overrides[label] = { min: vals.min, ideal: [vals.lo, vals.hi], max: vals.max };
      } else { return; }
      persist();
      const box = $('#ranges'); if (box) box.innerHTML = rangesTable(r);
    } else if (el.dataset.log) {
      const k = el.dataset.log;
      S.logDraft[k] = k === 'spot' || k === 'hour' ? Number(el.value) : el.value;
      if (k === 'spot' || k === 'disc') render();
    }
  }

  function armed(btn) {
    if (!btn.hasAttribute('data-confirm')) return true;
    if (btn.dataset.armed) return true;
    btn.dataset.armed = '1';
    const old = btn.textContent;
    btn.textContent = btn.classList.contains('x') ? 'Delete?' : 'Tap again to confirm';
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = old; } }, 4000);
    return false;
  }

  async function onAction(btn) {
    const act = btn.dataset.act;
    const r = currentRider();
    const ri = riderIndex();
    switch (act) {
      case 'refresh': refresh(true); break;
      case 'use-shared': S.cfg = clone(S.base); store.del(K.settings); S.local = false; S.baseChanged = false; refresh(); render(); toast('Using the shared settings'); break;
      case 'keep-local': S.baseChanged = false; persist(); render(); break;
      case 'add-rider': {
        S.cfg.riders.push({ name: `Rider ${S.cfg.riders.length + 1}`, weight: 80, sports: ['wing'], downwind_level: 'beginner',
          boards: [{ name: 'Wing board', volume: 60, use: ['wing'] }], wings: [4.5], foils: [{ name: 'Front wing', area: 1000, type: 'mid', use: ['wing'] }] });
        persist(); S.riderId = riderIds()[S.cfg.riders.length - 1]; store.set(K.rider, S.riderId); render(); break;
      }
      case 'add-board': r.boards ||= []; r.boards.push({ name: 'New board', volume: 60, use: ['wing'] }); persist(); render(); break;
      case 'add-wing': r.wings ||= []; r.wings.push(5); persist(); render(); break;
      case 'add-foil': r.foils ||= []; r.foils.push({ name: 'New front wing', area: 1000, type: 'mid', use: ['wing'] }); persist(); render(); break;
      case 'add-spot': {
        S.cfg.spots.push({ name: 'New spot', lat: -41.29, lon: 174.78, faces: 180, swell_window: [0, 0], offshore_ok: false, disciplines: ['wing'] });
        persist(); render();
        const last = document.querySelector(`[data-spot="${S.cfg.spots.length - 1}"]`); if (last) { last.open = true; last.scrollIntoView({ block: 'start' }); }
        break;
      }
      case 'del': {
        if (!armed(btn)) return;
        deletePath(S.cfg, btn.dataset.path);
        if (/^riders\.\d+$/.test(btn.dataset.path)) S.riderId = riderIds()[0];
        normalise(); persist(); render(); break;
      }
      case 'locate': {
        if (!navigator.geolocation) { toast('Location is not available here.'); return; }
        const i = Number(btn.dataset.i);
        btn.disabled = true; btn.textContent = 'Finding you…';
        navigator.geolocation.getCurrentPosition((pos) => {
          S.cfg.spots[i].lat = +pos.coords.latitude.toFixed(4); S.cfg.spots[i].lon = +pos.coords.longitude.toFixed(4);
          persist(); render(); const c = document.querySelector(`[data-spot="${i}"]`); if (c) c.open = true; toast('Location set');
        }, () => { btn.disabled = false; btn.textContent = 'Use my current location'; toast("Couldn't get your location."); }, { enableHighAccuracy: true, timeout: 15000 });
        break;
      }
      case 'export': {
        const text = JSON.stringify(S.cfg, null, 2);
        try { await navigator.clipboard.writeText(text); toast('Settings copied'); }
        catch (e) { S.importOpen = true; render(); const t = $('#import-text'); t.value = text; t.select(); toast('Select all and copy'); }
        break;
      }
      case 'import-open': S.importOpen = !S.importOpen; render(); if (S.importOpen) $('#import-text')?.focus(); break;
      case 'import-apply': {
        try {
          const cfg = JSON.parse($('#import-text').value);
          if (!Array.isArray(cfg.riders) || !Array.isArray(cfg.spots)) throw new Error('shape');
          S.cfg = cfg; S.importOpen = false; normalise(); persist(); S.riderId = riderIds()[0]; refresh(); render(); toast('Settings loaded');
        } catch (e) { toast("That doesn't look like Foil Forecast settings."); }
        break;
      }
      case 'reset-shared': if (!armed(btn)) return; S.cfg = clone(S.base); store.del(K.settings); S.local = false; S.baseChanged = false; S.riderId = riderIds()[0]; refresh(); render(); toast('Back to shared settings'); break;
      case 'hide-nogo': S.ui.hideNogo = btn.checked; store.set(K.ui, S.ui); render(); break;
      case 'install': if (S.installEvt) { S.installEvt.prompt(); S.installEvt = null; render(); } break;
      case 'rate': S.logDraft.rating = Number(btn.dataset.v); render(); break;
      case 'log-save': {
        const d = S.logDraft; const spot = S.cfg.spots[d.spot];
        if (!spot || !d.rating || !d.disc) return;
        const time = `${d.date}T${String(d.hour).padStart(2, '0')}:00`;
        const predicted = S.weather ? F.scoreAt(S.cfg, r, spot, d.disc, time, scaledWeather()) : null;
        const log = store.get(K.log, []);
        log.push({ id: Date.now().toString(36), rider: S.riderId, spot: spot.name, disc: d.disc, time, rating: d.rating,
          gear: d.gear || '', notes: d.notes || '', predicted, loggedAt: Date.now() });
        store.set(K.log, log);
        S.logDraft = { rating: 0, spot: d.spot, date: d.date };
        render(); toast(predicted === null ? 'Saved. No forecast was available for that time.' : 'Session saved');
        break;
      }
      case 'log-del': {
        if (!armed(btn)) return;
        store.set(K.log, store.get(K.log, []).filter((e) => e.id !== btn.dataset.id)); render(); break;
      }
      default: break;
    }
    void ri;
  }

  // ============================================================ events
  function bind() {
    document.addEventListener('click', (e) => {
      const rb = e.target.closest('[data-rider]');
      if (rb) {
        S.riderId = rb.dataset.rider; store.set(K.rider, S.riderId);
        try { history.replaceState(null, '', '#' + S.riderId); } catch (err) { /* ignore */ }
        S.logDraft = { rating: 0 }; render(); return;
      }
      const tab = e.target.closest('.tabs [data-view]') || e.target.closest('[data-go]');
      if (tab) {
        S.view = tab.dataset.view || tab.dataset.go; render(); window.scrollTo(0, 0);
        if (S.view === 'forecast' && S.wxSig !== wxSignature()) refresh(true);
        return;
      }
      const chip = e.target.closest('[data-filter]');
      if (chip) { S.ui[chip.dataset.filter] = chip.dataset.val; store.set(K.ui, S.ui); render(); return; }
      const btn = e.target.closest('button[data-act]');
      if (btn) { onAction(btn); }
    });
    document.addEventListener('change', (e) => {
      const el = e.target;
      if (el.dataset.act === 'hide-nogo') { onAction(el); return; }
      if (el.matches('[data-path],[data-list],[data-bool],[data-ov],[data-log]')) onFieldChange(el);
    });
    document.addEventListener('input', (e) => {
      const el = e.target;
      if (el.dataset.log === 'gear' || el.dataset.log === 'notes') S.logDraft[el.dataset.log] = el.value;
    });
    document.addEventListener('toggle', (e) => {
      const d = e.target;
      if (d.matches && d.matches('details.row')) { if (d.open) S.open.add(d.dataset.id); else S.open.delete(d.dataset.id); }
    }, true);
    window.addEventListener('hashchange', () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (riderIds().includes(id) && id !== S.riderId) { S.riderId = id; render(); }
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
    window.addEventListener('online', () => refresh(true));
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; if (S.view === 'forecast') render(); });
    window.addEventListener('resize', () => { const top = $('.top'); if (top) document.documentElement.style.setProperty('--top-h', top.offsetHeight + 'px'); });
  }

  async function start() {
    bind();
    await initSettings();
    render();
    refresh();
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => { /* app still works without it */ });
    }
  }
  start();
})();
