/**
 * daily-state.js — «тумблер» отправки отчётов заказчикам.
 *
 * Файл `state/daily-state.json` хранит за текущие сутки (МСК) статус рассылки
 * по каждой группе:
 *   status: 'pending' | 'failed' | 'sent'
 * Daily помечает группу 'sent' при успешной отправке. Если daily упал или SMTP
 * не принял письмо — группа остаётся 'pending'/'failed', и light-прогон (раз в
 * 15 мин) досылает письмо с шагом 30 мин, пока все группы не станут 'sent'.
 *
 * Привязка к суткам — по дате МСК: daily идёт в 14:00 МСК, окно досылки —
 * до конца тех же суток МСК. Новые сутки → новый цикл.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('.');
const STATE_PATH = path.join(ROOT, 'state', 'daily-state.json');

// МСК = UTC+3 круглый год (в России нет перехода на летнее время с 2014 г.).
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Дата суток рассылки в МСК, формат YYYY-MM-DD. */
export function todayMskDate(d = new Date()) {
  return new Date(d.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Текущее время МСК как «минуты от полуночи» (для проверки «после 14:00»). */
export function mskMinutes(d = new Date()) {
  const msk = new Date(d.getTime() + MSK_OFFSET_MS);
  return msk.getUTCHours() * 60 + msk.getUTCMinutes();
}

export function loadDailyState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return null; }
}

export function saveDailyState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function emptyGroup() {
  return {
    status: 'pending', attempts: 0, lastAttempt: null,
    lastError: null, sentAt: null, to: null, reportPath: null, cidList: null,
  };
}

/**
 * Вернуть состояние за сегодня (МСК), создав заготовку при смене даты/отсутствии
 * файла. Гарантирует наличие записей для всех переданных групп.
 */
export function ensureToday(groups = []) {
  const date = todayMskDate();
  let state = loadDailyState();
  if (!state || state.date !== date) {
    state = { date, startedAt: new Date().toISOString(), lastAttemptAt: null, groups: {} };
  }
  if (!state.groups) state.groups = {};
  for (const g of groups) {
    if (!state.groups[g]) state.groups[g] = emptyGroup();
  }
  return state;
}

/** Запомнить «исходящее» до попытки отправки (чтобы досылка нашла отчёт). */
export function recordOutbox(state, group, { to, reportPath, cidList }) {
  const g = state.groups[group] || (state.groups[group] = emptyGroup());
  if (g.status !== 'sent') g.status = 'pending';
  g.to = to;
  g.reportPath = reportPath;
  g.cidList = cidList;
}

export function markSent(state, group, to) {
  const g = state.groups[group] || (state.groups[group] = emptyGroup());
  const now = new Date().toISOString();
  g.status = 'sent';
  g.sentAt = now;
  g.lastAttempt = now;
  g.lastError = null;
  g.attempts = (g.attempts || 0) + 1;
  if (to != null) g.to = to;
  state.lastAttemptAt = now;
}

export function markFailed(state, group, { to, error, reportPath, cidList } = {}) {
  const g = state.groups[group] || (state.groups[group] = emptyGroup());
  const now = new Date().toISOString();
  g.status = 'failed';
  g.attempts = (g.attempts || 0) + 1;
  g.lastAttempt = now;
  g.lastError = error || null;
  if (to != null) g.to = to;
  if (reportPath != null) g.reportPath = reportPath;
  if (cidList != null) g.cidList = cidList;
  state.lastAttemptAt = now;
}

/** Имена групп, которые сегодня ещё НЕ отправлены (status !== 'sent'). */
export function pendingGroups(state) {
  if (!state || !state.groups) return [];
  return Object.entries(state.groups)
    .filter(([, g]) => g.status !== 'sent')
    .map(([name]) => name);
}

export function isGroupSent(state, group) {
  return !!(state && state.groups && state.groups[group]
            && state.groups[group].status === 'sent');
}
