# LCD Štatistiky – modul

Lokálny štatistický dashboard pre Luxury Car Design (modul do LCD Mega App, Electron).
Zlučuje **Meta (FB/IG + Ads), Google Ads, GA4, Search Console, YouTube** do jedného prehľadu.

## Funkcie
- **7-dňová zmena** (% nárast/pokles) pri každej metrike: web/PPC z natívnych denných sérií, sociálne siete z dennej histórie.
- **Kliknutie na kartu → detail s grafom** (Chart.js): porovnávacia čiara predošlého obdobia, trendline, priemer, datalabels, zoom.
- **North-star prehľad** hore + štatistiky v detaile (priemer/min/max/najlepší deň).
- **História** cez `store.js` – `better-sqlite3` ak je nainštalovaný, inak JSON fallback (idempotentný upsert podľa dátumu).
- **YouTube reálna história** odberateľov cez YouTube Analytics API (OAuth) – voliteľné.
- Provizórne dni (dnes/včera) označené; ľahká cache.

## Spustenie
Modul je súčasťou Electron appky (`server.js` štartuje lokálny HTTP server na porte **4787**, `index.html` je dashboard).
Štandalone test:
```
node server.js
# otvor http://localhost:4787
```

## Konfigurácia
1. Skopíruj `config.local.example.json` → `config.local.json` a vyplň tokeny (NEpushuje sa, je v `.gitignore`).
2. Verejné ID trhov (SK/CZ) sú v `markets.json`.

### Voliteľné: presnejšia história (SQLite)
```
npm i better-sqlite3
npx @electron/rebuild   # natívny modul treba zostaviť pre Electron
```
Bez toho beží JSON úložisko (funguje rovnako, menej robustné pri veľkej histórii).

### Voliteľné: reálna YouTube história
Do `config.local.json` → `youtube.oauth` doplň `client_id`, `client_secret`, `refresh_token`
(OAuth scope `https://www.googleapis.com/auth/yt-analytics.readonly`, vlastník kanála).

## Poznámka k ROAS
ROAS = hodnota konverzií **nahlásená reklamnými platformami** (Google/Meta tracking) ÷ výdavky.
**Nie sú to reálne tržby zo Shoptetu** (ten zatiaľ nie je napojený). Po napojení Shoptet API
bude k dispozícii skutočný ROAS z tržieb.

## Štruktúra
- `server.js` – agregátor API + HTTP server + cache
- `store.js` – časová perzistencia (SQLite/JSON, upsert)
- `index.html` – dashboard (vanilla JS + Chart.js)
- `vendor/` – Chart.js + pluginy (offline, MIT)
- `markets.json` – verejné ID trhov
- `config.local.example.json` – vzor konfigurácie
