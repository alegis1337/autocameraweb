/**
 * stats.js — статистика неисправностей поверх state/monitor.db (v3, пункт 1 ТЗ).
 *
 * Слой между «сырым» детектором (src/detector.js, чистые функции без ввода-вывода)
 * и потребителями: ежедневным письмом (reporter.js), helpdesk и еженедельным
 * отчётом. Здесь — обращения к БД, разрешение имён объектов и пороги из .env.
 *
 * Почему отдельным модулем, а не внутри index.js: те же цифры нужны трём
 * потребителям, и считать их в трёх местах — верный способ получить три разных
 * ответа на один вопрос.
 *
 * Ни одна функция здесь не должна ронять прогон: нет БД или она битая —
 * возвращаем пустой результат. Мониторинг и рассылка важнее статистики.
 */

import { openMonitorDbRead, readEvents, readSnapshot } from './monitor-db.js';
import { collectUnstable, detectSystemOutages, isBrokenKind } from './detector.js';
import * as log from './logger.js';

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

/**
 * Пороги «нестабильной» камеры. Настраиваются в .env.
 *
 * Значения по умолчанию подобраны на реальной истории проекта (7 дней,
 * 80 камер, 659 событий): при 60 мин / 5 падений в список попадали
 * 14 камер, включая те, что за неделю полежали полтора часа суммарно — это шум,
 * который оператор перестанет читать через два дня. При 180 мин / 10 падений
 * остаются 8 камер, и у каждой видна настоящая проблема.
 */
export function attentionThresholds() {
  return {
    days: num(process.env.ATTENTION_DAYS, 7),
    minDowntimeSec: num(process.env.ATTENTION_MIN_DOWNTIME_MIN, 180) * 60,
    minFalls: num(process.env.ATTENTION_MIN_FALLS, 10),
    // Потолок на случай плохого дня: письмо не должно превращаться в простыню.
    limit: num(process.env.ATTENTION_LIMIT, 15),
  };
}

/**
 * Камеры, требующие внимания: сейчас работают, но за период накопили простой
 * или падали раз за разом.
 *
 * Это и есть проблема из ТЗ: «камера, которая пропадает по несколько раз в день
 * и восстанавливается сама, остаётся незамеченной» — в момент проверки она
 * зелёная, поэтому ни в «не работают», ни в заявку не попадает.
 *
 * @param {object}  opts
 * @param {string}  [opts.group]      — имя группы объектов; пусто = все
 * @param {Set}     [opts.brokenKeys] — камеры, сломанные прямо сейчас: их не дублируем
 * @returns {Array<{cam_key, system_id, system, camera, downtime_sec, downtime_min, falls, share_pct}>}
 */
export function collectAttention({ group = '', brokenKeys = new Set() } = {}) {
  const { days, minDowntimeSec, minFalls, limit } = attentionThresholds();
  const db = openMonitorDbRead();
  if (!db) return [];

  try {
    const nowIso = new Date().toISOString();
    const fromIso = new Date(Date.now() - days * 86400_000).toISOString();

    const snap = readSnapshot(db, group);
    const sysName = new Map(snap.systems.map((s) => [s.id, s.name]));
    const sysIds = new Set(snap.systems.map((s) => s.id));

    const events = readEvents(db, fromIso, nowIso).filter((e) => sysIds.has(e.system_id));
    const rows = collectUnstable(events, {
      fromIso,
      toIso: nowIso,
      skipCamKeys: brokenKeys,
      minDowntimeSec,
      minFalls,
    });

    // Потолок применяем ПОСЛЕ сортировки по тяжести (её делает collectUnstable),
    // поэтому обрезаются самые лёгкие случаи, а не случайные.
    return rows.slice(0, limit).map((r) => ({
      ...r,
      system: sysName.get(r.system_id) || r.system_id,
      downtime_min: Math.round(r.downtime_sec / 60),
      days,
    }));
  } catch (e) {
    log.warn('stats', `Не удалось собрать «Требуют внимания»: ${e.message}`);
    return [];
  } finally {
    db.close();
  }
}

/**
 * Ключи камер, сломанных прямо сейчас (по данным последнего прогона в БД).
 * Нужны, чтобы «Требуют внимания» не дублировали блок «Не работают».
 */
export function currentlyBrokenKeys(group = '') {
  const db = openMonitorDbRead();
  if (!db) return new Set();
  try {
    const snap = readSnapshot(db, group);
    return new Set(snap.cameras.filter((c) => isBrokenKind(c.status)).map((c) => c.cam_key));
  } catch {
    return new Set();
  } finally {
    db.close();
  }
}

/**
 * Объекты, упавшие целиком (а не «несколько камер сломались»).
 *
 * Считаем по результатам ТЕКУЩЕГО прогона, а не по БД: helpdesk должен
 * реагировать на то, что видно прямо сейчас, а запись в БД идёт следом.
 *
 * @param {Array} systemResults — результат прогона чекеров
 * @param {Function} isUnused   — reporter.isUnusedChannel (серые камеры не в счёт)
 * @returns {{ downSystems: Set<string>, bySystem: Map }}
 */
export function detectOutagesFromRun(systemResults, isUnused) {
  const cams = [];
  for (const sys of systemResults) {
    if (!sys || !Array.isArray(sys.cameras)) continue;
    for (const cam of sys.cameras) {
      if (isUnused && isUnused(sys, cam)) continue;
      let status = 'unknown';
      if (cam.online === false) status = 'offline';
      else if (cam.online === true) {
        status = (sys.expectedRecording !== false && cam.recording === false) ? 'no-recording' : 'online';
      }
      cams.push({ cam_key: `${sys.id}|${cam.name}`, system_id: sys.id, status });
    }
  }

  return detectSystemOutages(cams, {
    ratio: num(process.env.OUTAGE_RATIO, 0.8),
    minCameras: num(process.env.OUTAGE_MIN_CAMERAS, 3),
  });
}
