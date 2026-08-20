/**
 * quality-check.js — разбор снятых кадров и решение о заявке (v3, пункт 2 ТЗ).
 *
 * Связывает три части: анализатор кадра (src/image-quality.js, чистая
 * математика), историю метрик (state/monitor.db, таблица cam_quality) и
 * дедупликацию заявок (state/quality-state.json).
 *
 * Главная мысль: абсолютных порогов недостаточно. Неосвещённый цех ночью
 * законно тёмный,
 * камера в тумане законно мягкая. Отличить дефект от особенности объекта можно
 * только по СОБСТВЕННОЙ норме камеры, поэтому каждая метрика сравнивается с
 * медианой её же истории. И заявка уходит лишь после того, как дефект
 * продержался несколько прогонов подряд — этого прямо требует ТЗ
 * («защита от ложных срабатываний»).
 */

import fs from 'fs';
import path from 'path';
import { openMonitorDb, recordQuality, readQualityHistoryAll, cleanOldQuality } from './monitor-db.js';
import { analyzeFile, qualityThresholds, describeDefects } from './image-quality.js';
import * as log from './logger.js';

const STATE_DIR = path.resolve('state');
const STATE_FILE = path.join(STATE_DIR, 'quality-state.json');

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

/** Медиана — устойчивее среднего: один выброс не уводит норму камеры. */
export function median(values) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/**
 * Сколько прогонов подряд (считая текущий) держится каждый дефект.
 *
 * @param {string[]} current — коды дефектов текущего кадра
 * @param {Array}    history — записи cam_quality, свежие первыми, БЕЗ текущей
 * @returns {Map<string, number>} код дефекта → длина серии
 */
export function defectStreaks(current, history) {
  const streaks = new Map();
  for (const code of current) {
    let n = 1;
    for (const h of history) {
      const past = String(h.defects || '').split(',').filter(Boolean);
      if (past.includes(code)) n++;
      else break;
    }
    streaks.set(code, n);
  }
  return streaks;
}

// ─── Состояние заявок по качеству ────────────────────────────────────────────

export function loadQualityState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { cameras: parsed.cameras || {}, updatedAt: parsed.updatedAt || null };
  } catch {
    return { cameras: {}, updatedAt: null };
  }
}

export function saveQualityState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

/**
 * Решает, по каким камерам слать заявку о качестве. Мутирует state.
 *
 * Повторно шлём, если: прошло QUALITY_RENOTIFY_DAYS, либо набор дефектов
 * изменился (появился новый — это новая информация для оператора).
 * Камера, у которой дефекты пропали, забывается сразу: качество вернулось,
 * ждать нечего.
 *
 * @param {object} state    — из loadQualityState()
 * @param {Array}  findings — [{ cam_key, system_id, camera, defects, streak, metrics }]
 * @returns {{ toNotify: Array, skipped: number, cleared: number }}
 */
export function diffQuality(state, findings, now = new Date()) {
  const renotifyDays = num(process.env.QUALITY_RENOTIFY_DAYS, 14);
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  const current = new Map(findings.map((f) => [f.cam_key, f]));
  const toNotify = [];
  let skipped = 0;

  for (const f of findings) {
    const prev = state.cameras[f.cam_key];
    const key = [...f.defects].sort().join(',');

    if (!prev) {
      toNotify.push(f);
      state.cameras[f.cam_key] = {
        firstSeenAt: nowIso, notifiedAt: nowIso, defects: key,
        camera: f.camera, system: f.system,
      };
      continue;
    }

    const sinceDays = prev.notifiedAt ? (nowMs - Date.parse(prev.notifiedAt)) / 86400_000 : Infinity;
    const changed = prev.defects !== key;

    if (changed || sinceDays >= renotifyDays) {
      toNotify.push({ ...f, repeat: true, changed });
      prev.notifiedAt = nowIso;
      prev.defects = key;
    } else {
      skipped++;
    }
  }

  // Качество восстановилось — забываем сразу, без выдержки: если дефект
  // вернётся, оператору нужна новая заявка, а не молчание.
  let cleared = 0;
  for (const key of Object.keys(state.cameras)) {
    if (!current.has(key)) { delete state.cameras[key]; cleared++; }
  }

  return { toNotify, skipped, cleared };
}

/** Сброс состояния — для отладки и из меню. */
export function resetQualityState() {
  try { fs.unlinkSync(STATE_FILE); return true; } catch { return false; }
}

// ─── Основной проход ─────────────────────────────────────────────────────────

/**
 * Разбирает свежие кадры прогона, пишет метрики в БД и возвращает камеры
 * с устойчивыми дефектами.
 *
 * @param {Array} captured — из snapshots.captureAll: [{ sysId, camIndex, camName, localPath }]
 * @param {Array} systemResults — для имён объектов и отсева офлайн-камер
 * @returns {Promise<{ analyzed, failed, findings }>}
 *   findings — камеры, у которых дефект держится QUALITY_MIN_STREAK прогонов
 */
export async function checkQuality(captured, systemResults, { now = new Date() } = {}) {
  const t = qualityThresholds();
  const sysById = new Map(systemResults.map((s) => [s.id, s]));

  let db;
  try {
    db = openMonitorDb();
  } catch (e) {
    log.warn('quality', `Не удалось открыть monitor.db: ${e.message}`);
    return { analyzed: 0, failed: 0, findings: [] };
  }

  try {
    const history = readQualityHistoryAll(db, 20);

    const rows = [];
    const findings = [];
    let failed = 0;

    for (const item of captured) {
      if (!item.localPath || !fs.existsSync(item.localPath)) continue;

      const sys = sysById.get(item.sysId);
      if (!sys) continue;
      const cam = sys.cameras?.find((c) => c.index === item.camIndex);
      // Офлайн-камеру разбирать бессмысленно: в кадре либо заглушка NVR
      // «NO VIDEO», либо старый кадр. Это поймала обычная проверка связи.
      if (cam?.online !== true) continue;

      const camKey = `${item.sysId}|${item.camName}`;
      const past = history.get(camKey) || [];

      // Норма камеры — по её же прошлым кадрам. Пока истории мало, относительные
      // правила не применяем: две точки нормой не считаются.
      const baselineSharpness = past.length >= 3 ? median(past.map((h) => h.sharpness)) : null;
      const prevHash = past[0]?.frame_hash || null;

      // Эталоны для ракурса — не один кадр, а ОКНО прошлых прогонов.
      //
      // Свежие кадры в эталоны не берём (пропускаем QUALITY_ANGLE_BASE_RUNS
      // штук): иначе разворот камеры «стал бы нормой» за один прогон и мы бы
      // его не заметили. Дальше берём QUALITY_ANGLE_WINDOW кадров подряд —
      // они охватывают разные законные состояния сцены (день, ночь, свет
      // включён/выключен), и совпадение хотя бы с одним означает, что камера
      // смотрит туда же. Почему так, а не по одному кадру — см. комментарий
      // в image-quality.classifyDefects.
      //
      // Заявка при этом не залипает: после реального разворота новое положение
      // само доходит до окна за несколько прогонов, и сигнал гаснет.
      const skip = num(process.env.QUALITY_ANGLE_BASE_RUNS, 3);
      const win = past.slice(skip, skip + num(process.env.QUALITY_ANGLE_WINDOW, 10));
      // Меньше трёх эталонов — состояния сцены не покрыты, сравнивать нечестно.
      const baseSignatures = win.length >= 3 ? win.map((h) => h.signature).filter(Boolean) : null;

      const res = await analyzeFile(item.localPath, {
        baselineSharpness,
        prevHash,
        baseSignatures,
        thresholds: t,
      });
      if (!res) { failed++; continue; }

      rows.push({
        cam_key: camKey,
        system_id: item.sysId,
        camera: item.camName,
        metrics: res.metrics,
        defects: res.defects,
      });

      if (res.defects.length === 0) continue;

      // Устойчивость: дефект должен держаться несколько прогонов подряд.
      const streaks = defectStreaks(res.defects, past);
      const stable = res.defects.filter((d) => (streaks.get(d) || 0) >= t.minStreak);
      if (stable.length === 0) continue;

      findings.push({
        cam_key: camKey,
        system_id: item.sysId,
        system: sys.name,
        group: sys.group || 'Прочее',
        camera: item.camName,
        defects: stable,
        defectsText: describeDefects(stable),
        streak: Math.max(...stable.map((d) => streaks.get(d) || 0)),
        metrics: res.metrics,
      });
    }

    if (rows.length) recordQuality(db, rows, now);

    // История нужна на пару месяцев, дальше — балласт: таблица прирастает
    // строкой на камеру каждый прогон.
    const removed = cleanOldQuality(db, num(process.env.QUALITY_HISTORY_DAYS, 90));
    if (removed > 0) log.info('quality', `Старых записей качества удалено: ${removed}`);

    return { analyzed: rows.length, failed, findings };
  } finally {
    db.close();
  }
}
