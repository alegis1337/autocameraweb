/**
 * status.js — сборка БЕЗОПАСНОГО снимка состояния для веб-карты.
 *
 * Читает state/monitor.db ТОЛЬКО на чтение и отдаёт наружу лишь то, что нужно
 * на экране: объект, камера, статус, простой, есть ли снимок. Внутренние детали
 * (IP камер и NVR, логины, пути на диске) наружу не уходят — иначе карта стала
 * бы удобной картой сети заказчика для любого, кто добрался до браузера.
 *
 * Схема как в проекте wifi-monitor («рынок»), server/status.js.
 */
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openMonitorDbRead, readSnapshot, readEvents, getMeta } from '../src/monitor-db.js';
import { detectSystemOutages, isBrokenKind } from '../src/detector.js';
import { loadSystems } from '../src/config-loader.js';
import { readCameraPoints } from './camera-points.js';
import { readSystemPoints } from './system-points.js';
import { config } from './config.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LAST_GOOD_ROOT = join(ROOT, 'screenshots', 'last-good');

// Как имя камеры превращается в имя файла — повторяет src/last-good.js.
function safeName(s) {
  return String(s || 'cam').replace(/[/\\:*?"<>|]/g, '_').slice(0, 60);
}

/**
 * Ищет last-good снимок камеры. Индекс камеры в БД может быть пустым (у записей,
 * поднятых из старых timeline-файлов), поэтому основной способ — поиск файла с
 * подходящим хвостом имени, а не сборка точного пути.
 * @returns {string|null} абсолютный путь
 */
export function findSnapshot(systemId, camera, idx = null, dirCache = null) {
  const dir = join(LAST_GOOD_ROOT, String(systemId));
  const tail = `-${safeName(camera)}.jpg`;

  if (idx != null) {
    const exact = join(dir, `${String(idx).padStart(2, '0')}${tail}`);
    if (existsSync(exact)) return exact;
  }

  // Список файлов каталога кэшируем на время одного запроса: без этого сборка
  // статуса делала readdirSync на каждую из ~80 камер, то есть десятки лишних
  // обращений к диску каждые полминуты. На одноядерной ВМ это заметно.
  let files;
  if (dirCache && dirCache.has(systemId)) {
    files = dirCache.get(systemId);
  } else {
    try {
      files = readdirSync(dir);
    } catch {
      files = [];
    }
    if (dirCache) dirCache.set(systemId, files);
  }

  const hit = files.find((f) => f.endsWith(tail));
  return hit ? join(dir, hit) : null;
}

/**
 * Статус камеры для показа. Если состояние давно не обновлялось, показываем
 * «нет данных», а не последний известный статус: чекер по этой камере ничего
 * не сказал (упал целиком, объект недоступен), и зелёный бейдж двухчасовой
 * давности врал бы оператору сильнее, чем честное «данных нет».
 */
function camStatus(c) {
  if (!c.status) return 'unknown';
  const seen = Date.parse(c.last_seen || '');
  if (Number.isFinite(seen) && Date.now() - seen > config.staleAfterSec * 1000) return 'unknown';
  return c.status;
}

/**
 * Этаж камеры. Второй — только у тех, кто перечислен в WEB_FLOOR2_CAMERAS,
 * остальные первый. Список ведём наоборот (перечисляем меньшинство), потому
 * что второй этаж бывает у одного-двух объектов — расписывать ради нескольких
 * камер все восемьдесят незачем, а одноэтажные объекты должны попадать
 * в «1 этаж» сами.
 */
export function floorOf(camKey) {
  return config.floor2.has(camKey) ? 2 : 1;
}

/** Сводный статус объекта по статусам его камер. */
function systemStatus(cams, isDown) {
  const known = cams.filter((c) => c.status && c.status !== 'unknown');
  if (!known.length) return 'unknown';
  if (isDown) return 'down';
  return known.some((c) => isBrokenKind(c.status)) ? 'issues' : 'ok';
}

const EMPTY = {
  generated_at: null, last_run: null, data_age_sec: null, stale: true,
  systems: [], cameras: [],
  totals: { systems: 0, cameras: 0, broken: 0 },
};

/**
 * Снимок состояния для карты: объекты со сводным статусом, камеры со статусами и
 * координатами (если расставлены в редакторе). Диагностику («требуют внимания»,
 * суточный простой) здесь не считаем — на карте нужна только сводка «работает /
 * не работает», а лишние проходы по журналу событий — заметная работа на слабой
 * ВМ на каждый опрос.
 */
export function buildStatus() {
  const db = openMonitorDbRead();
  if (!db) return { ...EMPTY, generated_at: new Date().toISOString() };

  try {
    const snap = readSnapshot(db, config.group);

    // Системы, которых уже нет в config/systems.json (например, старый
    // отдельная камера, ставшая extraCameras другого объекта), в БД остаются как
    // история — на карту и в список их не выводим.
    let live;
    try {
      live = new Set(loadSystems().map((s) => s.id));
    } catch {
      live = new Set(snap.systems.map((s) => s.id));
    }
    const systems = snap.systems.filter((s) => live.has(s.id));
    const sysIds = new Set(systems.map((s) => s.id));
    // Статус нормализуем сразу: им пользуются и счётчики объектов, и
    // detectSystemOutages, и список — иначе цифры в шапке и в списке разошлись бы.
    // Камеры-заглушки (WEB_HIDE_CAMERAS) отсекаем здесь же, до счётчиков:
    // иначе застрявшая в БД «Камера 1» не только висела бы точкой на карте,
    // но и добавляла бы единицу к «нет данных» в шапке.
    const cameras = snap.cameras
      .filter((c) => sysIds.has(c.system_id) && !config.hideCameras.has(c.cam_key))
      .map((c) => ({ ...c, status: camStatus(c) }));

    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const brokenNow = new Set(cameras.filter((c) => isBrokenKind(c.status)).map((c) => c.cam_key));
    const { downSystems } = detectSystemOutages(cameras);

    const camsBySystem = new Map();
    for (const c of cameras) {
      if (!camsBySystem.has(c.system_id)) camsBySystem.set(c.system_id, []);
      camsBySystem.get(c.system_id).push(c);
    }

    // Центры объектов (geo.txt → public/points.json): вокруг них фронт
    // раскладывает камеры, у которых своих координат ещё нет, и по ним же
    // подгоняет границы карты.
    const sysPoints = readSystemPoints();

    const outSystems = systems.map((s) => {
      const cams = camsBySystem.get(s.id) ?? [];
      const geo = sysPoints[s.id];
      return {
        id: s.id,
        name: s.name,
        status: systemStatus(cams, downSystems.has(s.id)),
        total: cams.length,
        online: cams.filter((c) => c.status === 'online').length,
        broken: cams.filter((c) => isBrokenKind(c.status)).length,
        unknown: cams.filter((c) => !c.status || c.status === 'unknown').length,
        ...(geo ? { lat: geo.lat, lon: geo.lon } : {}),
      };
    });

    // Координаты камер расставлены админом в редакторе (state/camera-points.json).
    // Камера без координат на карту «в никуда» не падает — фронт разложит её
    // рядом с центром, чтобы админ перетащил на место.
    const camPoints = readCameraPoints();
    const snapDirs = new Map();
    const outCameras = cameras.map((c) => {
      const geo = camPoints[c.cam_key];
      return {
        cam_key: c.cam_key,
        system_id: c.system_id,
        camera: c.name,
        status: camStatus(c),
        floor: floorOf(c.cam_key),
        since: c.status_since,
        reason: c.last_reason || '',
        last_seen: c.last_seen,
        has_snapshot: !!findSnapshot(c.system_id, c.name, c.idx, snapDirs),
        ...(geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)
          ? { lat: geo.lat, lon: geo.lon }
          : {}),
      };
    });

    const lastRun = snap.lastRun || getMeta(db, 'last_run');
    const ageSec = lastRun ? Math.max(0, Math.round((now - Date.parse(lastRun)) / 1000)) : null;

    return {
      generated_at: nowIso,
      last_run: lastRun,
      data_age_sec: ageSec,
      stale: ageSec === null || ageSec > config.staleAfterSec,
      systems: outSystems,
      cameras: outCameras,
      totals: {
        systems: outSystems.length,
        cameras: outCameras.length,
        broken: brokenNow.size,
      },
    };
  } finally {
    db.close();
  }
}

/**
 * Карточка одной камеры: история событий за N дней.
 * cam_key приходит от клиента — сверяем, что такая камера есть в разрешённой
 * группе, иначе через параметр можно было бы вытащить чужой объект.
 */
export function buildCameraDetail(camKey, { days = 30 } = {}) {
  const db = openMonitorDbRead();
  if (!db) return null;
  try {
    const snap = readSnapshot(db, config.group);
    const cam = snap.cameras.find((c) => c.cam_key === camKey);
    if (!cam) return null;

    const sys = snap.systems.find((s) => s.id === cam.system_id);
    const fromIso = new Date(Date.now() - days * 86400_000).toISOString();
    const events = readEvents(db, fromIso, new Date().toISOString(), { camKey });

    return {
      cam_key: cam.cam_key,
      camera: cam.name,
      system_id: cam.system_id,
      system: sys ? sys.name : cam.system_id,
      status: camStatus(cam),
      since: cam.status_since,
      reason: cam.last_reason || '',
      has_snapshot: !!findSnapshot(cam.system_id, cam.name, cam.idx),
      days,
      events: events.reverse().slice(0, 200).map((e) => ({
        ts: e.ts,
        kind: e.kind,
        downtime_sec: e.downtime_sec,
        reason: e.reason || '',
      })),
    };
  } finally {
    db.close();
  }
}

/** Есть ли такая камера в разрешённой группе — валидация записи координат. */
export function isKnownCamera(camKey) {
  const db = openMonitorDbRead();
  if (!db) return false;
  try {
    const snap = readSnapshot(db, config.group);
    return snap.cameras.some((c) => c.cam_key === camKey);
  } finally {
    db.close();
  }
}

/** Абсолютный путь к снимку камеры — только для камер разрешённой группы. */
export function snapshotPathFor(camKey) {
  const db = openMonitorDbRead();
  if (!db) return null;
  try {
    const snap = readSnapshot(db, config.group);
    const cam = snap.cameras.find((c) => c.cam_key === camKey);
    return cam ? findSnapshot(cam.system_id, cam.name, cam.idx) : null;
  } finally {
    db.close();
  }
}
