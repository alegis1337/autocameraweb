/**
 * monitor-db.js — источник правды для веб-интерфейса и статистики (v3).
 *
 * Зачем нужен, если есть state/timeline-YYYY-MM-DD.json: журнал по файлам на
 * день хорош для «истории за сегодня», но статистика за месяц требует открыть
 * и распарсить три десятка файлов, а веб-интерфейсу нужен произвольный доступ
 * (одна камера, один объект, произвольный период). Поэтому те же события
 * дублируются в SQLite — timeline-файлы продолжают писаться как раньше и
 * остаются основой «отчёта за период» (menu.ps1 → H).
 *
 * БД: state/monitor.db, встроенный node:sqlite (Node >= 22.5, лишних
 * зависимостей нет — как в проекте wifi-monitor).
 *
 * Пишет только коллектор (src/index.js) — по разу за прогон. Веб-сервер
 * открывает файл ТОЛЬКО на чтение (openMonitorDbRead) и в него не пишет.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const MONITOR_DB_PATH = join(ROOT, 'state', 'monitor.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS systems (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  grp         TEXT NOT NULL DEFAULT '',
  type        TEXT,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS cameras (
  cam_key     TEXT PRIMARY KEY,           -- "<systemId>|<имя камеры>", как в timeline.cameraKey
  system_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  idx         INTEGER,
  updated_at  TEXT
);

-- Текущее состояние камеры: одна строка на камеру, перезаписывается каждым прогоном.
CREATE TABLE IF NOT EXISTS cam_state (
  cam_key        TEXT PRIMARY KEY,
  status         TEXT NOT NULL,           -- online | offline | no-recording | unknown
  status_since   TEXT,
  last_online_ts TEXT,
  last_reason    TEXT,
  last_seen      TEXT
);

-- Журнал событий. UNIQUE держит вставку идемпотентной: повторный прогон
-- бэкфилла или двойная запись одного события ничего не дублируют.
CREATE TABLE IF NOT EXISTS cam_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,             -- ISO 8601
  cam_key      TEXT NOT NULL,
  system_id    TEXT NOT NULL,
  camera       TEXT NOT NULL,
  kind         TEXT NOT NULL,             -- offline | no-recording | online
  prev_kind    TEXT,
  downtime_sec INTEGER,
  reason       TEXT,
  UNIQUE (cam_key, ts, kind)
);

CREATE INDEX IF NOT EXISTS idx_events_ts      ON cam_events (ts);
CREATE INDEX IF NOT EXISTS idx_events_cam_ts  ON cam_events (cam_key, ts);
CREATE INDEX IF NOT EXISTS idx_events_sys_ts  ON cam_events (system_id, ts);

-- Качество изображения (v3, пункт 2 ТЗ): метрики каждого снятого кадра.
-- Нужна именно история, а не последнее значение: у каждой камеры своя сцена,
-- и «резкость 12» для одной норма, для другой — расфокус. Отличить дефект от
-- особенности объекта можно только по собственной норме камеры.
CREATE TABLE IF NOT EXISTS cam_quality (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  cam_key      TEXT NOT NULL,
  system_id    TEXT NOT NULL,
  camera       TEXT NOT NULL,
  mean         REAL,
  std          REAL,
  sharpness    REAL,
  dark_ratio   REAL,
  bright_ratio REAL,
  signature    TEXT,          -- 16x16 яркостей: для сравнения СТРУКТУРЫ (ракурс)
  frame_hash   TEXT,          -- отпечаток кадра: точное совпадение = изображение зависло
  defects      TEXT,          -- коды через запятую, пусто = кадр в порядке
  UNIQUE (cam_key, ts)
);

CREATE INDEX IF NOT EXISTS idx_quality_cam_ts ON cam_quality (cam_key, ts);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * Догоняет схему существующей БД до текущей.
 *
 * `CREATE TABLE IF NOT EXISTS` в SCHEMA создаёт таблицу только когда её нет, и
 * новый столбец в уже существующую таблицу не добавит — база просто останется
 * со старой схемой, а запрос упадёт на «no such column». Поэтому недостающие
 * столбцы досыпаем явно. Список открытый: каждое расширение схемы добавляет
 * сюда строку.
 */
function migrate(db) {
  const columns = (table) =>
    new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

  const wanted = [
    // v3.1: отпечаток кадра для детекта «изображение зависло».
    { table: 'cam_quality', column: 'frame_hash', type: 'TEXT' },
  ];

  for (const { table, column, type } of wanted) {
    try {
      if (!columns(table).has(column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    } catch {
      // Таблицы может не быть вовсе (свежая база) — её создаст SCHEMA выше.
    }
  }
}

/** Открывает БД на запись (коллектор). Создаёт файл и схему при первом вызове. */
export function openMonitorDb() {
  const dir = dirname(MONITOR_DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(MONITOR_DB_PATH);
  // WAL — чтобы веб-сервер читал параллельно с прогоном и не ловил «database is locked».
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Открывает БД только на чтение (веб-сервер).
 * Возвращает null, если файла ещё нет — веб должен пережить это спокойно
 * и показать «нет данных», а не упасть.
 */
export function openMonitorDbRead() {
  if (!existsSync(MONITOR_DB_PATH)) return null;
  const db = new DatabaseSync(MONITOR_DB_PATH, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000;');
  return db;
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function getMeta(db, key) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}

/**
 * Переносит состояние очередного прогона в БД.
 *
 * Работает от той же структуры timeline, что уже собрал diffAndAppend, —
 * второй раз статусы не вычисляем, иначе БД и timeline-файл могли бы
 * разъехаться в трактовке «сломана ли камера».
 *
 * @param {object}  db        — из openMonitorDb()
 * @param {object}  timeline  — результат loadTimeline() ПОСЛЕ diffAndAppend
 * @param {Array}   newEvents — новые события того же diffAndAppend
 * @param {object}  opts      — { systems: сырой config, runMode, now }
 */
export function recordRun(db, timeline, newEvents, { systems = [], runMode = 'manual', now = new Date() } = {}) {
  const nowIso = now.toISOString();

  const upSystem = db.prepare(
    `INSERT INTO systems (id, name, grp, type, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, grp = excluded.grp,
       type = excluded.type, updated_at = excluded.updated_at`,
  );
  const upCamera = db.prepare(
    `INSERT INTO cameras (cam_key, system_id, name, idx, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cam_key) DO UPDATE SET system_id = excluded.system_id, name = excluded.name,
       idx = COALESCE(excluded.idx, cameras.idx), updated_at = excluded.updated_at`,
  );
  const upState = db.prepare(
    `INSERT INTO cam_state (cam_key, status, status_since, last_online_ts, last_reason, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cam_key) DO UPDATE SET status = excluded.status, status_since = excluded.status_since,
       last_online_ts = COALESCE(excluded.last_online_ts, cam_state.last_online_ts),
       last_reason = excluded.last_reason, last_seen = excluded.last_seen`,
  );
  const insEvent = db.prepare(
    `INSERT OR IGNORE INTO cam_events (ts, cam_key, system_id, camera, kind, prev_kind, downtime_sec, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN');
  try {
    for (const sys of systems) {
      if (!sys || !sys.id) continue;
      upSystem.run(sys.id, sys.name || sys.id, sys.group || '', sys.type || null, nowIso);
    }

    for (const [camKey, cam] of Object.entries(timeline.cameras || {})) {
      upCamera.run(camKey, cam.systemId, cam.camera, cam.index ?? null, nowIso);
      upState.run(
        camKey,
        cam.status,
        cam.since || nowIso,
        cam.status === 'online' ? (cam.lastSeen || nowIso) : null,
        cam.lastReason || '',
        cam.lastSeen || nowIso,
      );
    }

    for (const ev of newEvents || []) {
      const camKey = `${ev.systemId}|${ev.camera}`;
      insEvent.run(
        ev.tsIso,
        camKey,
        ev.systemId,
        ev.camera,
        ev.event,
        ev.prevEvent || null,
        ev.downtimeMin != null ? ev.downtimeMin * 60 : null,
        ev.reason || '',
      );
    }

    setMeta(db, 'last_run', nowIso);
    setMeta(db, 'last_run_mode', runMode);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Импорт одного timeline-объекта (день целиком) — для бэкфилла истории.
 * Отличается от recordRun тем, что берёт ВСЕ события дня, а не только новые,
 * и не трогает cam_state (актуальное состояние даёт только свежий прогон).
 *
 * @returns {number} сколько событий реально добавлено (дубли не считаются)
 */
export function importTimeline(db, timeline) {
  const upCamera = db.prepare(
    `INSERT INTO cameras (cam_key, system_id, name, idx, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cam_key) DO NOTHING`,
  );
  const upSystem = db.prepare(
    `INSERT INTO systems (id, name, grp, type, updated_at) VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  const insEvent = db.prepare(
    `INSERT OR IGNORE INTO cam_events (ts, cam_key, system_id, camera, kind, prev_kind, downtime_sec, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let added = 0;
  db.exec('BEGIN');
  try {
    for (const [camKey, cam] of Object.entries(timeline.cameras || {})) {
      upSystem.run(cam.systemId, cam.system || cam.systemId, cam.group || '', timeline.date || '');
      upCamera.run(camKey, cam.systemId, cam.camera, cam.index ?? null, timeline.date || '');
    }
    for (const ev of timeline.events || []) {
      if (!ev.tsIso || !ev.systemId || !ev.camera) continue;
      const camKey = `${ev.systemId}|${ev.camera}`;
      const info = insEvent.run(
        ev.tsIso,
        camKey,
        ev.systemId,
        ev.camera,
        ev.event,
        ev.prevEvent || null,
        ev.downtimeMin != null ? ev.downtimeMin * 60 : null,
        ev.reason || '',
      );
      added += info.changes;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return added;
}

// ─── Чтение (веб-интерфейс и статистика) ─────────────────────────────────────

/**
 * Снимок состояния для карты: объекты + камеры со статусами.
 *
 * Берём только камеры, у которых есть строка состояния и она свежее
 * `seenSinceIso`. Иначе в списке навсегда оставались бы камеры, которых уже
 * нет: таблица cameras накапливает всё, что когда-либо встречалось в журнале,
 * а камеры регулярно уходят в «серые» (unusedChannels / knownOffline) или
 * убираются из конфига. Такие записи состояние не обновляют и осели бы на
 * карте вечными «нет данных».
 *
 * @param {object} db      — из openMonitorDbRead()
 * @param {string} [group] — фильтр по имени группы объектов; пусто = все
 * @param {object} [opts]  — { seenSinceIso: отсечка по last_seen, по умолчанию сутки }
 */
export function readSnapshot(db, group = '', { seenSinceIso = null } = {}) {
  const since = seenSinceIso || new Date(Date.now() - 86400_000).toISOString();

  const systems = group
    ? db.prepare('SELECT id, name, grp, type FROM systems WHERE grp = ? ORDER BY name').all(group)
    : db.prepare('SELECT id, name, grp, type FROM systems ORDER BY grp, name').all();

  const ids = new Set(systems.map((s) => s.id));
  const cams = db
    .prepare(
      `SELECT c.cam_key, c.system_id, c.name, c.idx,
              s.status, s.status_since, s.last_online_ts, s.last_reason, s.last_seen
       FROM cameras c JOIN cam_state s ON s.cam_key = c.cam_key
       WHERE s.last_seen >= ?
       ORDER BY c.system_id, c.idx, c.name`,
    )
    .all(since)
    .filter((c) => ids.has(c.system_id));

  return { systems, cameras: cams, lastRun: getMeta(db, 'last_run') };
}

// ─── Качество изображения (v3, пункт 2) ──────────────────────────────────────

/**
 * Записывает результаты разбора кадров одного прогона.
 * @param {Array} rows — [{ cam_key, system_id, camera, metrics, defects }]
 */
export function recordQuality(db, rows, now = new Date()) {
  const ts = now.toISOString();
  const ins = db.prepare(
    `INSERT OR REPLACE INTO cam_quality
       (ts, cam_key, system_id, camera, mean, std, sharpness, dark_ratio, bright_ratio, signature, frame_hash, defects)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const m = r.metrics || {};
      ins.run(
        ts, r.cam_key, r.system_id, r.camera,
        m.mean ?? null, m.std ?? null, m.sharpness ?? null,
        m.darkRatio ?? null, m.brightRatio ?? null,
        m.signature ?? null, m.frameHash ?? null,
        (r.defects || []).join(','),
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * История разборов камеры, свежие первыми.
 * @param {number} limit — сколько последних записей вернуть
 */
export function readQualityHistory(db, camKey, limit = 20) {
  return db
    .prepare(
      `SELECT ts, mean, std, sharpness, dark_ratio, bright_ratio, signature, frame_hash, defects
       FROM cam_quality WHERE cam_key = ? ORDER BY ts DESC LIMIT ?`,
    )
    .all(camKey, limit);
}

/** История сразу по всем камерам — чтобы не открывать соединение на каждую. */
export function readQualityHistoryAll(db, limit = 20) {
  const rows = db
    .prepare(
      `SELECT cam_key, ts, mean, std, sharpness, signature, frame_hash, defects
       FROM cam_quality ORDER BY cam_key, ts DESC`,
    )
    .all();

  const byCam = new Map();
  for (const r of rows) {
    if (!byCam.has(r.cam_key)) byCam.set(r.cam_key, []);
    const list = byCam.get(r.cam_key);
    if (list.length < limit) list.push(r);
  }
  return byCam;
}

/** Удаляет записи качества старше N дней — таблица растёт каждый прогон. */
export function cleanOldQuality(db, days = 90) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  return db.prepare('DELETE FROM cam_quality WHERE ts < ?').run(cutoff).changes;
}

/** События за период [fromIso, toIso). Для статистики и карточки камеры. */
export function readEvents(db, fromIso, toIso, { camKey = null, systemId = null } = {}) {
  let sql = 'SELECT ts, cam_key, system_id, camera, kind, prev_kind, downtime_sec, reason FROM cam_events WHERE ts >= ? AND ts < ?';
  const args = [fromIso, toIso];
  if (camKey) { sql += ' AND cam_key = ?'; args.push(camKey); }
  if (systemId) { sql += ' AND system_id = ?'; args.push(systemId); }
  sql += ' ORDER BY ts ASC';
  return db.prepare(sql).all(...args);
}
