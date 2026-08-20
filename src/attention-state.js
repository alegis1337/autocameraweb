/**
 * attention-state.js — дедупликация заявок на НЕСТАБИЛЬНЫЕ камеры (v3, пункт 1 ТЗ).
 *
 * Отдельно от state/helpdesk-state.json намеренно. Тот отслеживает «камера
 * сломана / починилась» — событие с чёткими границами. Здесь другое: камера
 * работает, но статистика за неделю плохая. Такое состояние держится днями, и
 * без своей памяти заявка уходила бы каждое утро, пока показатели не улягутся.
 * Смешивать эти два состояния в одном файле — значит запутать оба.
 *
 * Файл: state/attention-state.json (gitignored).
 *
 * Правила повторной отправки:
 *   • первый раз — шлём;
 *   • повторно по той же камере — не раньше ATTENTION_RENOTIFY_DAYS (14 дней),
 *     чтобы helpdesk не получал одно и то же каждый день;
 *   • раньше срока — только если стало заметно хуже (падений в полтора раза
 *     больше, чем было при прошлой заявке): это уже новая информация;
 *   • камера выпала из списка нестабильных — запись живёт ещё
 *     ATTENTION_FORGET_DAYS (7 дней) и удаляется. Если через месяц она
 *     развалится снова, это будет новая заявка, а не «продолжение» старой.
 */

import fs from 'fs';
import path from 'path';

const STATE_DIR = path.resolve('state');
const STATE_FILE = path.join(STATE_DIR, 'attention-state.json');

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

/** Во сколько раз должно вырасти число падений, чтобы слать заявку досрочно. */
const WORSE_FACTOR = 1.5;

export function loadAttentionState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { cameras: parsed.cameras || {}, updatedAt: parsed.updatedAt || null };
  } catch {
    return { cameras: {}, updatedAt: null };
  }
}

export function saveAttentionState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

/**
 * Решает, по каким камерам слать заявку, и обновляет состояние.
 *
 * ВАЖНО: функция мутирует переданный state — вызывающая сторона обязана
 * сохранить его через saveAttentionState, иначе на следующем прогоне уйдут
 * те же заявки. Ровно как diffAndUpdate в state.js.
 *
 * @param {object} state     — из loadAttentionState()
 * @param {Array}  attention — из stats.collectAttention()
 * @param {Date}   [now]
 * @returns {{ toNotify: Array, skipped: number, forgotten: number }}
 */
export function diffAttention(state, attention, now = new Date()) {
  const renotifyDays = num(process.env.ATTENTION_RENOTIFY_DAYS, 14);
  const forgetDays = num(process.env.ATTENTION_FORGET_DAYS, 7);
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const current = new Set(attention.map((a) => a.cam_key));
  const toNotify = [];
  let skipped = 0;

  for (const a of attention) {
    const prev = state.cameras[a.cam_key];

    if (!prev) {
      toNotify.push(a);
      state.cameras[a.cam_key] = {
        firstSeenAt: nowIso,
        notifiedAt: nowIso,
        notifiedFalls: a.falls,
        notifiedDowntimeMin: a.downtime_min,
        lastSeenAt: nowIso,
        camera: a.camera,
        system: a.system,
      };
      continue;
    }

    prev.lastSeenAt = nowIso;

    const sinceNotifyDays = prev.notifiedAt
      ? (nowMs - Date.parse(prev.notifiedAt)) / 86400_000
      : Infinity;
    const gotWorse = a.falls >= Math.ceil((prev.notifiedFalls || 0) * WORSE_FACTOR)
      && a.falls > (prev.notifiedFalls || 0);

    if (sinceNotifyDays >= renotifyDays || gotWorse) {
      toNotify.push({ ...a, repeat: true, worse: gotWorse });
      prev.notifiedAt = nowIso;
      prev.notifiedFalls = a.falls;
      prev.notifiedDowntimeMin = a.downtime_min;
    } else {
      skipped++;
    }
  }

  // Забываем тех, кто давно не появлялся в списке — иначе состояние растёт
  // вечно, а вернувшаяся через месяц проблема считалась бы «уже отправленной».
  let forgotten = 0;
  for (const [key, rec] of Object.entries(state.cameras)) {
    if (current.has(key)) continue;
    const idleDays = (nowMs - Date.parse(rec.lastSeenAt || rec.notifiedAt || nowIso)) / 86400_000;
    if (idleDays >= forgetDays) {
      delete state.cameras[key];
      forgotten++;
    }
  }

  return { toNotify, skipped, forgotten };
}

/** Сброс состояния — для отладки и из меню. */
export function resetAttentionState() {
  try {
    fs.unlinkSync(STATE_FILE);
    return true;
  } catch {
    return false;
  }
}
