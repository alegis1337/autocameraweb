/**
 * logger.js — Система логирования AutoCamera
 *
 * Каждая строка лога содержит:
 *   [timestamp] [LEVEL] [step] message | key=value key=value
 *
 * Уровни: INFO, WARN, ERROR, DEBUG
 * Шаги с таймингами: stepStart/stepEnd показывают сколько секунд занял каждый этап
 *
 * Пример вывода:
 *   [2026-03-31T08:00:01.123Z] [INFO] [STARTUP] Загрузка конфигурации | systems=2
 *   [2026-03-31T08:00:02.456Z] [INFO] [noviy-ceh:browser] Запуск Chromium | url=http://<nvr>/
 *   [2026-03-31T08:00:05.789Z] [INFO] [noviy-ceh:browser] Логин выполнен | type=ipanda elapsed=3.3s
 *   [2026-03-31T08:00:06.012Z] [INFO] [noviy-ceh:browser] Скриншот сохранён | file=noviy-ceh-2026-03-31.png size=245KB
 *   [2026-03-31T08:00:08.345Z] [INFO] [noviy-ceh:ai] Анализ завершён | model=gemini cameras=10 online=8 offline=2 elapsed=2.3s
 *   [2026-03-31T08:00:08.346Z] [WARN] [noviy-ceh:ai] Камера offline | index=3 notes="Нет соединения"
 *   [2026-03-31T08:00:08.500Z] [ERROR] [hiwatch:browser] Не удалось подключиться | url=http://<nvr>/ error="net::ERR_CONNECTION_REFUSED"
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('.');
const LOGS_DIR = path.join(ROOT, 'logs');

let currentLevel = 1; // 0=DEBUG, 1=INFO, 2=WARN, 3=ERROR
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const COLORS = {
  DEBUG: '\x1b[90m',   // серый
  INFO:  '\x1b[0m',    // стандартный
  WARN:  '\x1b[33m',   // жёлтый
  ERROR: '\x1b[31m',   // красный
  RESET: '\x1b[0m',
  BOLD:  '\x1b[1m',
  DIM:   '\x1b[2m',
};

/** Активные таймеры шагов */
const timers = {};

/**
 * Установить уровень логирования.
 * @param {'DEBUG'|'INFO'|'WARN'|'ERROR'} level
 */
export function setLogLevel(level) {
  if (LEVELS[level] !== undefined) currentLevel = LEVELS[level];
}

/**
 * Путь к файлу лога текущего дня.
 */
function logFilePath() {
  return path.join(LOGS_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
}

/**
 * Записать строку лога.
 * @param {number} level - числовой уровень
 * @param {string} step  - текущий шаг (напр. "noviy-ceh:browser")
 * @param {string} message - основное сообщение
 * @param {object} [meta] - дополнительные ключ-значение
 */
function write(level, step, message, meta) {
  if (level < currentLevel) return;

  const ts = new Date().toISOString();
  const levelName = LEVEL_NAMES[level];
  const stepPart = step ? `[${step}]` : '';

  // key=value из meta
  let metaPart = '';
  if (meta && Object.keys(meta).length > 0) {
    metaPart = ' | ' + Object.entries(meta)
      .map(([k, v]) => `${k}=${typeof v === 'string' && v.includes(' ') ? `"${v}"` : v}`)
      .join(' ');
  }

  const plainLine = `[${ts}] [${levelName}] ${stepPart} ${message}${metaPart}\n`;

  // В файл — без цветов
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.appendFileSync(logFilePath(), plainLine, 'utf8');

  // В консоль — с цветами
  const color = COLORS[levelName] || COLORS.RESET;
  const dimStep = step ? `${COLORS.DIM}[${step}]${COLORS.RESET} ` : '';
  const consoleLine = `${COLORS.DIM}[${ts}]${COLORS.RESET} ${color}[${levelName}]${COLORS.RESET} ${dimStep}${message}${metaPart ? COLORS.DIM + metaPart + COLORS.RESET : ''}\n`;
  process.stdout.write(consoleLine);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function debug(step, message, meta) { write(0, step, message, meta); }
export function info(step, message, meta)  { write(1, step, message, meta); }
export function warn(step, message, meta)  { write(2, step, message, meta); }
export function error(step, message, meta) { write(3, step, message, meta); }

/**
 * Разделитель — визуально отделяет этапы в логе.
 * @param {string} title
 */
export function section(title) {
  const line = `${'═'.repeat(4)} ${title} ${'═'.repeat(Math.max(0, 50 - title.length))}`;
  write(1, '', line);
}

/**
 * Начать отсчёт времени для шага.
 * @param {string} stepId - уникальный id шага
 * @param {string} message
 * @param {object} [meta]
 */
export function stepStart(stepId, message, meta) {
  timers[stepId] = Date.now();
  write(1, stepId, `▶ ${message}`, meta);
}

/**
 * Завершить шаг и логировать затраченное время.
 * @param {string} stepId
 * @param {'ok'|'warn'|'fail'} status
 * @param {string} message
 * @param {object} [meta]
 */
export function stepEnd(stepId, status, message, meta) {
  const start = timers[stepId];
  const elapsed = start ? ((Date.now() - start) / 1000).toFixed(1) + 's' : '?';
  delete timers[stepId];

  const enrichedMeta = { ...meta, elapsed };
  const icon = status === 'ok' ? '✓' : status === 'warn' ? '⚠' : '✗';
  const level = status === 'fail' ? 3 : status === 'warn' ? 2 : 1;

  write(level, stepId, `${icon} ${message}`, enrichedMeta);
}

/**
 * Удаляет файлы логов старше N дней.
 * @param {number} days
 */
export function cleanOldLogs(days) {
  const cutoff = Date.now() - days * 86400_000;
  if (!fs.existsSync(LOGS_DIR)) return;
  for (const file of fs.readdirSync(LOGS_DIR)) {
    if (!file.endsWith('.log') || file === 'scheduler.log') continue;
    const fullPath = path.join(LOGS_DIR, file);
    if (fs.statSync(fullPath).mtimeMs < cutoff) fs.unlinkSync(fullPath);
  }
}
