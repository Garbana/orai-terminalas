# Orų terminalas

LHMT automatinių meteorologijos stočių temperatūros grafikai biržos terminalo stiliumi.
Svetainė: https://garbana.github.io/orai-terminalas/

## Kaip veikia

- `index.html` – visas puslapis (grafikai – lightweight-charts).
- `data/stations.json` – 52 LHMT stotys.
- `data/st/<stotis>.json` – valandinis archyvas iki 2026-10-26 23:00 UTC.
- `data/live/<stotis>.json`, `data/live/snapshot.json` – nauji matavimai po archyvo pabaigos.
  Juos kas 10 min. tikrina ir papildo GitHub Actions (vienas paleidimas veikia ~5,5 val. ir paleidžia kitą) (`.github/workflows/collect.yml` → `scripts/collect.mjs`) iš https://api.meteo.lt.
  Jei Actions atsilieka daugiau nei parą, praleistos dienos pasivejamos automatiškai.

Rankinis paleidimas: GitHub → Actions → „Rinkti matavimus“ → Run workflow.

Duomenų šaltinis – Lietuvos hidrometeorologijos tarnyba (LHMT), api.meteo.lt.
