# Tokyo Radar — Deploy Guide

## Files
```
tokyo-radar/
  server.js          ← Node.js backend (Pulse API)
  package.json
  railway.toml
  static/
    index.html       ← Single-file app (Pulse + Radar + Desk)
    thumbs.json      ← Copy from Tinance.zip (1MB image thumbnails)
```

## Step 1 — Add thumbs.json
Copy `thumbs.json` from your Tinance.zip into the `static/` folder.

## Step 2 — Firebase setup
1. Go to https://console.firebase.google.com → Create project
2. Add a Web App → copy config
3. Open `static/index.html`, find `var FIREBASE_CONFIG = {` near top of script
4. Replace the placeholder values with your real config

## Step 3 — Set your PIN
In `static/index.html` find:
```js
var PIN_HASH = '1234'; // change to your real PIN
```
Change `'1234'` to your 4-digit PIN.

## Step 4 — Deploy to Railway
1. Push this folder to a GitHub repo (or use Railway CLI)
2. railway.app → New Project → Deploy from GitHub repo
3. Railway auto-detects Node.js via package.json
4. Set env var if needed: `PORT` (Railway sets it automatically)
5. Done — your app is at `https://yourapp.up.railway.app`

## Tabs
- **Pulse** — Tech/Reddit/HN/Google Trends feed, refreshes every 60s
- **Radar** — Live Pump.fun WebSocket; hot words, coin check, watch words
- **Desk** — Launch log, wallets, bills, tips, sources, weekly review (Firebase)
