/**
 * detector.js — выявление проблемных камер по накопленной статистике (v3).
 *
 * Перенос готовой логики из проекта wifi-monitor («рынок»), файл src/detector.js,
 * функция collectUnstable. Там она писалась под Wi-Fi точки, но сознательно — без
 * привязки к типу устройства (в исходнике так и помечено: «тот же расчёт пойдёт
 * для камер»). Здесь она адаптирована под наши виды событий: у точки было
 * down/up, у камеры — offline / no-recording / online.
 *
 * Задача, которую это решает (п.1 ТЗ v3): сегодня заявка создаётся только на
 * камеру, не работающую В МОМЕНТ проверки. Камера, которая за сутки отвалилась
 * восемь раз по десять минут и каждый раз вернулась сама, к моменту отчёта
 * зелёная и остаётся незамеченной. Здесь она попадает в «Требуют внимания».
 *
 * Функции чистые (никакой сети и диска) — покрываются юнит-тестами.
 */

const BROKEN_KINDS = new Set(['offline', 'no-recording']);

/** Событие означает поломку (в отличие от восстановления)? */
export function isBrokenKind(kind) {
  return BROKEN_KINDS.has(kind);
}

/**
 * «Нестабильные за период»: камера на момент отчёта отвечает — значит в блок
 * «сейчас не работают» не попадёт, — но за период суммарно пролежала часы или
 * падала раз за разом.
 *
 * Событие online закрывает падение, начавшееся (ts - downtime_sec). Падение
 * могло начаться ещё ДО начала периода — тогда в зачёт идёт только его хвост
 * внутри периода, иначе вчерашний многочасовой простой всплывал бы в сегодняшней
 * сводке.
 *
 * @param {Array}  events — события периода из monitor-db.readEvents:
 *                          { ts, cam_key, system_id, camera, kind, prev_kind, downtime_sec }
 * @param {object} opts
 * @param {string} opts.fromIso        — начало периода
 * @param {string} opts.toIso          — конец периода
 * @param {Set}    [opts.skipCamKeys]  — кто лежит прямо сейчас (они уже в блоке
 *                                       «не работают», дублировать не надо)
 * @param {number} opts.minDowntimeSec — порог по накопленному простою
 * @param {number} opts.minFalls       — порог по числу падений
 * @returns {Array<{cam_key, system_id, camera, downtime_sec, falls, share_pct, last_online_ts}>}
 */
export function collectUnstable(events, { fromIso, toIso, skipCamKeys, minDowntimeSec, minFalls }) {
  const from = Date.parse(fromIso);
  const periodSec = Math.max(1, Math.round((Date.parse(toIso) - from) / 1000));
  const skip = skipCamKeys ?? new Set();
  const byCam = new Map();

  for (const e of events) {
    if (skip.has(e.cam_key)) continue;

    let a = byCam.get(e.cam_key);
    if (!a) {
      a = {
        cam_key: e.cam_key,
        system_id: e.system_id,
        camera: e.camera,
        downtime_sec: 0,
        falls: 0,
        last_online_ts: null,
      };
      byCam.set(e.cam_key, a);
    }

    if (isBrokenKind(e.kind)) {
      // offline → no-recording (и обратно) — смена характера поломки внутри уже
      // идущего падения, а не новое падение. Такой переход timeline помечает
      // prev_kind'ом, тоже «сломанным».
      if (!isBrokenKind(e.prev_kind)) a.falls++;
      continue;
    }

    if (e.kind !== 'online') continue;
    const inPeriodSec = Math.round((Date.parse(e.ts) - from) / 1000);
    a.downtime_sec += Math.max(0, Math.min(e.downtime_sec ?? 0, inPeriodSec));
    a.last_online_ts = e.ts;
  }

  return [...byCam.values()]
    .filter((a) => a.downtime_sec >= minDowntimeSec || a.falls >= minFalls)
    .map((a) => ({ ...a, share_pct: Math.round((a.downtime_sec / periodSec) * 100) }))
    .sort((a, b) => b.downtime_sec - a.downtime_sec || b.falls - a.falls);
}

/**
 * Отделяет сбой объекта целиком от поломки отдельных камер (п.1 ТЗ).
 *
 * Зачем: когда падает NVR или канал связи, все 16 камер объекта уходят в offline
 * одновременно, и helpdesk получает 16 заявок об одном и том же. Оператору нужна
 * одна: «объект недоступен целиком».
 *
 * Объект считается упавшим, если сломана доля камер не меньше `ratio`
 * и при этом сломанных не меньше `minCameras` — чтобы объект из двух камер
 * не «падал целиком» от одной поломки.
 *
 * @param {Array}  cameras — [{ cam_key, system_id, status }]
 * @param {object} opts    — { ratio = 0.8, minCameras = 3 }
 * @returns {{ downSystems: Set<string>, bySystem: Map<string, {total, broken}> }}
 */
export function detectSystemOutages(cameras, { ratio = 0.8, minCameras = 3 } = {}) {
  const bySystem = new Map();
  for (const c of cameras) {
    let s = bySystem.get(c.system_id);
    if (!s) { s = { total: 0, broken: 0 }; bySystem.set(c.system_id, s); }
    // Камеры без данных (unknown) в знаменатель не берём: чекер по ним ничего не
    // сказал, и «сломано 100%» из двух unknown — это не сбой объекта.
    if (c.status === 'unknown' || c.status == null) continue;
    s.total++;
    if (isBrokenKind(c.status)) s.broken++;
  }

  const downSystems = new Set();
  for (const [sysId, s] of bySystem) {
    if (s.broken >= minCameras && s.total > 0 && s.broken / s.total >= ratio) {
      downSystems.add(sysId);
    }
  }
  return { downSystems, bySystem };
}

