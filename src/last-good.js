/**
 * last-good.js — Кэш «последнего рабочего» снимка для каждой камеры.
 *
 * Зачем: в отчёте мы хотим показывать миниатюру даже для упавших камер,
 * чтобы сразу было понятно, ЧТО ИМЕННО ЗА КАМЕРА не работает. Для этого
 * каждый удачный снимок ONLINE-камеры копируется в локальный кэш, и при
 * следующем прогоне (когда та же камера офлайн) рендер берёт картинку
 * отсюда.
 *
 * Хранение: screenshots/last-good/<systemId>/<index>-<safeName>.jpg
 * (рядом со screenshots/<runId>/ для актуальных прогонов).
 *
 * Никакого retention пока не делаем — last-good должен переживать сколько
 * угодно дней простоя камеры; чистить только когда камеру убирают из
 * конфига (это делает manage-cameras.mjs — но он пока last-good не трогает,
 * ничего не сломается, файл просто останется ненужным).
 */

import fs from 'fs';
import path from 'path';

const LAST_GOOD_ROOT = path.resolve('screenshots', 'last-good');

function safeName(s) {
  return String(s || 'cam').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60);
}

/**
 * Путь к файлу last-good для конкретной камеры. Папку при необходимости создаёт.
 */
export function lastGoodPath(sysId, camIndex, camName, { makeDir = false } = {}) {
  const dir = path.join(LAST_GOOD_ROOT, String(sysId));
  if (makeDir) fs.mkdirSync(dir, { recursive: true });
  const idx = String(camIndex ?? 0).padStart(2, '0');
  return path.join(dir, `${idx}-${safeName(camName)}.jpg`);
}

/** true, если в кэше есть файл для этой камеры. */
export function exists(sysId, camIndex, camName) {
  return fs.existsSync(lastGoodPath(sysId, camIndex, camName));
}

/**
 * Копирует свежий снимок из src-пути в last-good. Перезаписывает если файл
 * уже есть. Возвращает true при успехе.
 */
export function update(sysId, camIndex, camName, srcLocalPath) {
  try {
    if (!srcLocalPath || !fs.existsSync(srcLocalPath)) return false;
    const stat = fs.statSync(srcLocalPath);
    if (!stat.isFile() || stat.size < 200) return false;
    const dst = lastGoodPath(sysId, camIndex, camName, { makeDir: true });
    fs.copyFileSync(srcLocalPath, dst);
    return true;
  } catch {
    return false;
  }
}

/**
 * Возвращает метаданные last-good файла или null если его нет.
 * @returns {{ path: string, mtimeMs: number, ageMs: number } | null}
 */
export function getMeta(sysId, camIndex, camName) {
  const p = lastGoodPath(sysId, camIndex, camName);
  if (!fs.existsSync(p)) return null;
  const st = fs.statSync(p);
  return { path: p, mtimeMs: st.mtimeMs, ageMs: Date.now() - st.mtimeMs };
}

/**
 * Краткое описание возраста снимка для отображения в отчёте.
 * "сейчас" / "5 мин назад" / "2 ч назад" / "вчера" / "12.05".
 */
export function describeAge(ageMs) {
  if (ageMs == null || ageMs < 0) return '';
  const min = Math.floor(ageMs / 60_000);
  if (min < 2)    return 'только что';
  if (min < 60)   return `${min} мин назад`;
  const hr = Math.floor(min / 60);
  if (hr < 12)    return `${hr} ч назад`;
  const day = Math.floor(hr / 24);
  if (day < 1)    return 'сегодня';
  if (day === 1)  return 'вчера';
  if (day < 7)    return `${day} дн назад`;
  // Иначе показываем дату DD.MM
  const d = new Date(Date.now() - ageMs);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}`;
}
