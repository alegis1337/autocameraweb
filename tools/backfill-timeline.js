/**
 * backfill-timeline.js — перенос накопленной истории из state/timeline-*.json
 * в state/monitor.db.
 *
 * Нужен один раз при переходе на v3: журналы событий копятся с мая, терять их
 * при смене хранилища нельзя — вся статистика «нестабильных камер» строится
 * именно на них.
 *
 * Идемпотентен: у cam_events стоит UNIQUE (cam_key, ts, kind), поэтому повторный
 * запуск ничего не задвоит — можно гонять сколько угодно.
 *
 * Запуск: node tools/backfill-timeline.js
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openMonitorDb, importTimeline } from '../src/monitor-db.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = join(ROOT, 'state');

function main() {
  const files = readdirSync(STATE_DIR)
    .filter((f) => /^timeline-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  if (!files.length) {
    console.log('[backfill] timeline-файлов не найдено — нечего переносить');
    return;
  }

  const db = openMonitorDb();
  let totalAdded = 0;
  let totalEvents = 0;
  let skipped = 0;

  for (const f of files) {
    let timeline;
    try {
      timeline = JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8'));
    } catch (e) {
      console.warn(`[backfill] ${f}: битый JSON, пропуск (${e.message})`);
      skipped++;
      continue;
    }
    const events = (timeline.events || []).length;
    const added = importTimeline(db, timeline);
    totalEvents += events;
    totalAdded += added;
    console.log(`[backfill] ${f}: событий ${events}, добавлено ${added}`);
  }

  const cams = db.prepare('SELECT COUNT(*) AS n FROM cameras').get().n;
  const evs = db.prepare('SELECT COUNT(*) AS n FROM cam_events').get().n;
  const range = db.prepare('SELECT MIN(ts) AS a, MAX(ts) AS b FROM cam_events').get();
  db.close();

  console.log('');
  console.log(`[backfill] файлов обработано: ${files.length - skipped} из ${files.length}`);
  console.log(`[backfill] событий в файлах: ${totalEvents}, добавлено новых: ${totalAdded}`);
  console.log(`[backfill] в БД сейчас: камер ${cams}, событий ${evs}`);
  if (range.a) console.log(`[backfill] период истории: ${range.a.slice(0, 10)} — ${range.b.slice(0, 10)}`);
}

main();
