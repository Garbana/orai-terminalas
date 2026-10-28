// Renka naujausius LHMT stočių matavimus iš api.meteo.lt ir kaupia juos data/live/ aplanke.
// Paleidžia GitHub Actions kas 10 min. (žr. .github/workflows/collect.yml). Priklausomybių nėra – Node 20+.
//
// data/live/<stotis>.json: { updated, rows: [[t, T, F, W, G, D, C, P, H, R, S, sąlygos], ...] }
//   t – valandos pradžia, UNIX sekundės (UTC); reikšmės – tikri vienetai (°C, m/s, hPa, mm).
//   Eilutės tik po archyvo (data/st/<stotis>.json) pabaigos – puslapis jas prideda prie archyvo.
// data/live/snapshot.json: { <stotis>: [t, temperatūra, sąlygos] } – stočių sąrašui.
// data/forecast/<stotis>.json: { created, fetched, place, rows: [[t, T, F, W, G, D, C, P, H, R, sąlygos], ...] } –
//   oficiali LHMT prognozė (long-term) artimiausiai vietovei; atnaujinama ne dažniau kaip kas 50 min.
// data/fcarchive/<stotis>/<YYYY-MM>.json: { "<t>": { "<L>": [T, R, W] } } – prognozių archyvas tikslumui tikrinti:
//   kiekvienai valandai t ir pastovumui L (1, 3, 6, 12, 24, 48, 72, 120 val.) – vėliausia prognozė, sudaryta bent L val. prieš t.
//   data/fcarchive/index.json: { <stotis>: { last: <paskutinės archyvuotos prognozės sudarymo laikas>, months: [...] } }

import { readFile, writeFile, mkdir } from "node:fs/promises";

const API = "https://api.meteo.lt/v1/stations/";
const ROOT = new URL("../data/", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = async (u, dflt) => { try { return JSON.parse(await readFile(u, "utf8")); } catch { return dflt; } };
const MAX_CATCHUP_REQUESTS = 60; // dienų užklausų per paleidimą, kai reikia pasivyti
const num = (v) => (v == null || v === "" || Number.isNaN(+v) ? null : +v);

const stations = await readJson(new URL("stations.json", ROOT), []);
await mkdir(new URL("live/", ROOT), { recursive: true });
const snapshot = await readJson(new URL("live/snapshot.json", ROOT), {});
const updated = new Date().toISOString();
let ok = 0, fail = 0, added = 0, newestObs = 0, budget = MAX_CATCHUP_REQUESTS;

async function fetchObs(code, date) {
  const res = await fetch(API + code + "/observations/" + date, { headers: { accept: "application/json", "user-agent": "orai-terminalas (GitHub Actions)" }, signal: AbortSignal.timeout(15000) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(date + ": HTTP " + res.status);
  await sleep(400); // api.meteo.lt riba – 180 užklausų per minutę
  const j = await res.json();
  return Array.isArray(j.observations) ? j.observations : [];
}

for (const st of stations) {
  try {
    const arch = await readJson(new URL("st/" + st.code + ".json", ROOT), null);
    const archEnd = arch ? arch.t0 + (arch.n - 1) * 3600 : 0;
    const file = new URL("live/" + st.code + ".json", ROOT);
    const prev = await readJson(file, { rows: [] });
    const byT = new Map(prev.rows.filter((r) => r[0] > archEnd).map((r) => [r[0], r]));
    const last = Math.max(archEnd, ...byT.keys());

    const obs = [];
    const now = Date.now() / 1000;
    if (now - last > 20 * 3600) {
      // atsilikta daugiau nei parą – papildo dienomis (ribotai per vieną paleidimą)
      const d = new Date(last * 1000);
      d.setUTCHours(0, 0, 0, 0);
      while (d.getTime() / 1000 <= now && budget > 0) {
        budget--;
        obs.push(...(await fetchObs(st.code, d.toISOString().slice(0, 10))));
        d.setUTCDate(d.getUTCDate() + 1);
      }
    } else {
      obs.push(...(await fetchObs(st.code, "latest")));
    }

    for (const o of obs) {
      const t = Date.parse(o.observationTimeUtc.replace(" ", "T") + "Z") / 1000;
      if (t > newestObs) newestObs = t;
      if (!(t > archEnd)) continue;
      if (!byT.has(t)) added++;
      byT.set(t, [t, num(o.airTemperature), num(o.feelsLikeTemperature), num(o.windSpeed), num(o.windGust),
        num(o.windDirection), num(o.cloudCover), num(o.seaLevelPressure), num(o.relativeHumidity),
        num(o.precipitation), num(o.snowDepth), o.conditionCode || null]);
    }
    const rows = [...byT.values()].sort((a, b) => a[0] - b[0]);
    // rašo tik kai yra naujų ar pataisytų matavimų – kitaip nebūtų ką įrašyti į git
    if (JSON.stringify(rows) !== JSON.stringify(prev.rows)) await writeFile(file, JSON.stringify({ updated, rows }));

    const newest = rows[rows.length - 1];
    if (newest) snapshot[st.code] = [newest[0], newest[1], newest[11]];
    ok++;
  } catch (e) {
    console.warn(st.code + ": " + e.message);
    fail++;
    // kai kurie GitHub serveriai api.meteo.lt nepasiekia – tada neverta tikrinti visų stočių
    if (!ok && fail >= 3) { console.log("api.meteo.lt nepasiekiamas iš šio serverio."); process.exit(2); }
  }
}

await writeFile(new URL("live/snapshot.json", ROOT), JSON.stringify(snapshot));
await forecasts().catch((e) => console.warn("prognozės: " + e.message));
const iso = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "–");
console.log(`Stočių: ${ok} gerai, ${fail} nepavyko. Naujų valandų: ${added}. Naujausias LHMT matavimas: ${iso(newestObs)}.`);
if (!ok) process.exit(1);

// ---------- oficialios prognozės ----------
async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "orai-terminalas (GitHub Actions)" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(url + ": HTTP " + res.status);
  await sleep(400);
  return res.json();
}
async function forecasts() {
  const dir = new URL("forecast/", ROOT);
  await mkdir(dir, { recursive: true });
  // stotis → artimiausia prognozių vietovė (skaičiuojama vieną kartą)
  const mapFile = new URL("places.json", dir);
  let map = await readJson(mapFile, null);
  if (!map || stations.some((st) => !map[st.code])) {
    const places = await getJson(API.replace("stations/", "places"));
    const rad = Math.PI / 180, km = (a, b, c, d) => 6371 * Math.acos(Math.min(1, Math.sin(a * rad) * Math.sin(c * rad) + Math.cos(a * rad) * Math.cos(c * rad) * Math.cos((d - b) * rad)));
    map = {};
    for (const st of stations) {
      let best = null;
      for (const p of places) { if (p.countryCode && p.countryCode !== "LT") continue; const k = km(st.lat, st.lon, p.coordinates.latitude, p.coordinates.longitude); if (!best || k < best.km) best = { code: p.code, name: p.name, km: Math.round(k * 10) / 10 }; }
      map[st.code] = best;
    }
    await writeFile(mapFile, JSON.stringify(map));
  }
  let ok = 0, skip = 0, arch = 0;
  const idxFile = new URL("../fcarchive/index.json", dir), idx = await readJson(idxFile, {});
  for (const st of stations) {
    const place = map[st.code]; if (!place) continue;
    const file = new URL(st.code + ".json", dir), prev = await readJson(file, null);
    let cur = prev;
    if (prev && Date.now() - Date.parse(prev.fetched) < 50 * 60 * 1000) skip++;
    else try {
      const j = await getJson(API.replace("stations/", "places/") + place.code + "/forecasts/long-term");
      if (prev && prev.created === j.forecastCreationTimeUtc) skip++; // nauja prognozė dar neišleista – nėra ką rašyti
      else {
        const rows = (j.forecastTimestamps || []).map((o) => [Date.parse(o.forecastTimeUtc.replace(" ", "T") + "Z") / 1000, num(o.airTemperature), num(o.feelsLikeTemperature),
          num(o.windSpeed), num(o.windGust), num(o.windDirection), num(o.cloudCover), num(o.seaLevelPressure), num(o.relativeHumidity), num(o.totalPrecipitation), o.conditionCode || null]);
        cur = { created: j.forecastCreationTimeUtc, fetched: new Date().toISOString(), place, rows };
        await writeFile(file, JSON.stringify(cur));
        ok++;
      }
    } catch (e) { console.warn("prognozė " + st.code + ": " + e.message); }
    if (cur && (!idx[st.code] || idx[st.code].last !== cur.created)) { await archive(st.code, cur, idx); arch++; }
  }
  await writeFile(idxFile, JSON.stringify(idx));
  console.log(`Prognozės: atnaujinta ${ok}, praleista ${skip}, archyvuota ${arch}.`);
}

// ---------- prognozių archyvas tikslumui tikrinti ----------
async function archive(code, fc, idx) {
  const LEADS = [1, 3, 6, 12, 24, 48, 72, 120];
  const c = Date.parse(fc.created.replace(" ", "T") + "Z") / 1000, dir = new URL("../fcarchive/" + code + "/", new URL("forecast/", ROOT));
  await mkdir(dir, { recursive: true });
  const byMonth = new Map();
  for (const r of fc.rows) {
    const lead = (r[0] - c) / 3600; if (!(lead >= 1) || r[1] == null) continue;
    const m = new Date(r[0] * 1000).toISOString().slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, await readJson(new URL(m + ".json", dir), {}));
    const o = byMonth.get(m), e = o[r[0]] || (o[r[0]] = {});
    // vėlesnė prognozė (mažesnis, bet vis dar ≥ L pastovumas) pakeičia ankstesnę
    const rd = (v) => (v == null ? null : Math.round(v * 10) / 10);
    for (const L of LEADS) if (lead >= L) e[L] = [rd(r[1]), rd(r[9]), rd(r[3])];
  }
  const ix = idx[code] || (idx[code] = { last: null, months: [] });
  for (const [m, o] of byMonth) { await writeFile(new URL(m + ".json", dir), JSON.stringify(o)); if (!ix.months.includes(m)) ix.months.push(m); }
  ix.months.sort(); ix.last = fc.created;
}
