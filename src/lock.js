/**
 * lock.js — единый лок «один прогон за раз».
 *
 * Зачем: light-тик (каждые 15 мин от 00:00 → :00/:15/:30/:45) совпадает по
 * времени со стартом daily (14:00 МСК). Раньше в 14:00 МСК стартовали ДВА
 * процесса одновременно, дрались за общие файлы (reports/, state/,
 * screenshots/, live.html) и Playwright — и daily иногда падал ещё до этапа
 * отправки писем. Из-за этого 15 и 20 июня заказчики не получили рассылку.
 *
 * Решение: атомарный лок-файл `state/autocamera.lock`. Daily/manual ждут
 * освобождения (light короткий), а light при занятом локе просто пропускает
 * свой тик — следующий через 15 мин.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('.');
const LOCK_PATH = path.join(ROOT, 'state', 'autocamera.lock');

// Лок старше этого срока считаем «осиротевшим» (процесс убит без очистки).
const STALE_MS = 30 * 60 * 1000;

let held = false;

function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')); }
  catch { return null; }
}

/** Жив ли процесс с таким PID (signal 0 — только проверка существования). */
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // EPERM — процесс есть, но чужой
}

/** Лок «протух»: нет файла / процесс мёртв / слишком старый. */
function lockIsStale(info) {
  if (!info) return true;
  if (!pidAlive(info.pid)) return true;
  if (Date.now() - (info.ts || 0) > STALE_MS) return true;
  return false;
}

function tryCreate(mode) {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  // 'wx' — атомарно: бросит EEXIST, если файл уже существует.
  const fd = fs.openSync(LOCK_PATH, 'wx');
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, mode, ts: Date.now() }));
  fs.closeSync(fd);
  held = true;
}

/**
 * Захватить лок.
 * @param {'light'|'daily'|'manual'} mode
 * @param {{ waitMs?: number, onWait?: (info:object)=>void }} [opts]
 *        waitMs > 0 — сколько ждать освобождения (для daily/manual).
 * @returns {Promise<boolean>} true — лок наш; false — занят и ждать не стали.
 */
export async function acquireLock(mode, { waitMs = 0, onWait = null } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      tryCreate(mode);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const info = readLock();
      if (lockIsStale(info)) {
        try { fs.unlinkSync(LOCK_PATH); } catch {}
        continue;                       // повтор сразу же
      }
      if (Date.now() < deadline) {      // занят живым процессом — ждём
        if (onWait) onWait(info);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      return false;                     // занят, ждать не просили / время вышло
    }
  }
}

/** Забрать лок принудительно (daily не имеет права пропустить прогон). */
export function forceAcquireLock(mode) {
  try { fs.unlinkSync(LOCK_PATH); } catch {}
  try { tryCreate(mode); } catch { /* в крайнем случае работаем без лока */ }
}

/** Отпустить лок (только если он наш). Идемпотентно. */
export function releaseLock() {
  if (!held) return;
  const info = readLock();
  if (info && info.pid === process.pid) {
    try { fs.unlinkSync(LOCK_PATH); } catch {}
  }
  held = false;
}
