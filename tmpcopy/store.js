// LCD Štatistiky – časová perzistencia metrík (history store).
//
// Ukladá denné hodnoty metrík kľúčované (metric, date) s idempotentným upsertom:
// opätovné spustenie v ten istý deň hodnotu prepíše (žiadne duplicity), neskoré
// revízie sa tým pádom správne premietnu.
//
// Primárne používa **better-sqlite3** (rýchle, indexy, ON CONFLICT upsert). Ak nie je
// nainštalovaný (je to natívny modul – treba `npm i better-sqlite3` + electron-rebuild),
// automaticky padne na **JSON** súbor. Appka funguje v oboch prípadoch.

'use strict';
const fs = require('fs');
const path = require('path');

function createStore(dataDir) {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {}

  // ── 1) skús SQLite ──
  try {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(dataDir, 'stats.db'));
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS metric_history (' +
      'metric TEXT NOT NULL, date TEXT NOT NULL, value REAL, updated_at TEXT, ' +
      'PRIMARY KEY (metric, date))');
    const upStmt = db.prepare(
      'INSERT INTO metric_history (metric, date, value, updated_at) VALUES (@metric, @date, @value, @updated_at) ' +
      'ON CONFLICT(metric, date) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
    const selStmt = db.prepare('SELECT date AS d, value AS v FROM metric_history WHERE metric = ? ORDER BY date');
    const upMany = db.transaction((rows) => { for (const r of rows) upStmt.run(r); });
    return {
      engine: 'sqlite',
      upsert(metric, date, value) { upStmt.run({ metric, date, value: Number(value), updated_at: new Date().toISOString() }); },
      upsertMany(rows) {
        upMany(rows.map((r) => ({ metric: r.metric, date: r.date, value: Number(r.value), updated_at: new Date().toISOString() })));
      },
      series(metric) { return selStmt.all(metric).map((r) => ({ d: r.d, v: r.v })).filter((p) => p.v != null && !isNaN(p.v)); }
    };
  } catch (e) {
    // ── 2) JSON fallback: { metric: { date: value } } ──
    const file = path.join(dataDir, 'history.json');
    const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; } };
    const save = (o) => { try { fs.writeFileSync(file, JSON.stringify(o)); } catch (_) {} };
    return {
      engine: 'json',
      _reason: String((e && (e.code || e.message)) || e),
      upsert(metric, date, value) { const o = load(); (o[metric] = o[metric] || {})[date] = Number(value); save(o); },
      upsertMany(rows) {
        const o = load();
        for (const r of rows) { (o[r.metric] = o[r.metric] || {})[r.date] = Number(r.value); }
        save(o);
      },
      series(metric) {
        const o = load(); const m = o[metric] || {};
        return Object.keys(m).sort().map((d) => ({ d, v: m[d] })).filter((p) => p.v != null && !isNaN(p.v));
      }
    };
  }
}

// Jednorazová migrácia starého snapshots.json ({date:{key:val}}) do store-u.
function migrateSnapshots(store, snapFile) {
  try {
    if (!fs.existsSync(snapFile)) return 0;
    const old = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    const rows = [];
    Object.keys(old || {}).forEach((date) => {
      const day = old[date] || {};
      Object.keys(day).forEach((metric) => { if (day[metric] != null) rows.push({ metric, date, value: day[metric] }); });
    });
    if (rows.length) store.upsertMany(rows);
    // premenuj starý súbor, nech sa migruje len raz
    try { fs.renameSync(snapFile, snapFile + '.migrated'); } catch (_) {}
    return rows.length;
  } catch (e) { return 0; }
}

module.exports = { createStore, migrateSnapshots };
