// Renka naujausius LHMT stočių matavimus iš api.meteo.lt ir kaupia juos data/live/ aplanke.
// Paleidžia GitHub Actions kas 15 min. (žr. .github/workflows/collect.yml). Priklausomybių nėra – Node 20+.
//
// data/live/<stotis>.json: { updated, rows: [[t, T, F, W, G, D, C, P, H, R, S, sąlygos], ...] }
//   t – valandos pradžia, UNIX sekundės (UTC); reikšmės – tikri vienetai (°C, m/s, hPa, mm).
//   Eilutės tik po archyvo (data/st/<stotis>.json) pabaigos – puslapis jas prideda prie archyvo.
// data/live/snapshot.json: { <stotis>: [t, temperatūra, sąlygos] } – stočių sąrašui.

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
let ok = 0, fail = 0, budget = MAX_CATCHUP_REQUESTS;

async function fetchObs(code, date) {
  const res = await fetch(API + code + "/observations/" + date, { headers: { accept: "application/json", "user-agent": "orai-terminalas (GitHub Actions)" } });
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
      if (!(t > archEnd)) continue;
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
  }
}

await writeFile(new URL("live/snapshot.json", ROOT), JSON.stringify(snapshot));
console.log(`Atnaujinta ${ok} stočių, nepavyko ${fail}.`);
if (!ok) process.exit(1);
