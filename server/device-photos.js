/**
 * device-photos.js — фотографии устройств на карте (v3.9).
 *
 * Снимок привязан к устройству из map-devices.json: у записи есть массив
 * `photos` с именами файлов, сами файлы лежат в `state/device-photos/`.
 * Оригиналы с телефона весят 3–8 МБ и несут EXIF (в том числе GPS) — поэтому
 * всё, что попадает сюда, прогоняется через ffmpeg: сторона не больше
 * MAX_SIDE, метаданные вырезаны, поворот по EXIF применён. Это же и защита:
 * что бы ни прислал клиент под видом JPEG, наружу уходит перекодированный
 * ffmpeg'ом файл, а не исходные байты.
 *
 * Имя файла выдаёт сервер (`<id устройства>-<8 hex>.jpg`) и проверяет по
 * шаблону на входе: с клиента приходит только имя, путь строится здесь.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { config } from './config.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PHOTOS_DIR = join(ROOT, 'state', 'device-photos');

export const MAX_PHOTOS = 6;                 // на одно устройство: стойка — 3–4 кадра, больше незачем
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_SIDE = 1600;                // px по длинной стороне: в балуне и лайтбоксе хватает
const FFMPEG_TIMEOUT_MS = 30_000;

/** JPEG начинается с FF D8 FF — всё остальное не берём даже на перекодирование. */
export function isJpeg(buf) {
  return Buffer.isBuffer(buf) && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

const NAME_RE = /^dev-[0-9a-f-]{36}-[0-9a-f]{8}\.jpg$/;

/** Имя файла фото, как его выдаёт сервер, или null — чужое имя в путь не попадает. */
export function safePhotoName(name) {
  const s = String(name ?? '');
  return NAME_RE.test(s) ? s : null;
}

/** Новое имя для фото устройства. */
export function newPhotoName(deviceId) {
  return `${deviceId}-${randomBytes(4).toString('hex')}.jpg`;
}

/** Абсолютный путь к файлу фото или null. */
export function photoPath(name) {
  const safe = safePhotoName(name);
  return safe ? join(PHOTOS_DIR, safe) : null;
}

/** Список фото + новое имя; больше MAX_PHOTOS — ошибка (чистая функция, под тест). */
export function withPhoto(photos, name) {
  const list = Array.isArray(photos) ? photos.filter((p) => safePhotoName(p)) : [];
  if (list.includes(name)) return list;
  if (list.length >= MAX_PHOTOS) throw new Error(`больше ${MAX_PHOTOS} фото на устройство не привязать`);
  return [...list, name];
}

export function withoutPhoto(photos, name) {
  return (Array.isArray(photos) ? photos : []).filter((p) => p !== name && safePhotoName(p));
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = (config.ffmpegPath || 'ffmpeg');
    const proc = spawn(ffmpeg, ['-y', '-loglevel', 'error', ...args], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill(); reject(new Error('ffmpeg не уложился в таймаут')); }, FFMPEG_TIMEOUT_MS);
    proc.on('error', (e) => { clearTimeout(timer); reject(new Error(`ffmpeg не запустился: ${e.message}`)); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg завершился с кодом ${code}: ${stderr.trim().slice(0, 200)}`));
    });
  });
}

/**
 * Перекодировать исходный JPEG (путь на диске) в файл фото устройства.
 * @returns {Promise<string>} имя сохранённого файла
 */
export async function storePhotoFromFile(deviceId, srcPath) {
  if (!existsSync(PHOTOS_DIR)) mkdirSync(PHOTOS_DIR, { recursive: true });
  const name = newPhotoName(deviceId);
  const out = join(PHOTOS_DIR, name);
  // scale: длинная сторона → MAX_SIDE, короткая — пропорционально и чётная
  // (-2), иначе JPEG-кодер ffmpeg ругается на нечётные размеры.
  const scale = `scale='if(gt(iw,ih),${MAX_SIDE},-2)':'if(gt(iw,ih),-2,${MAX_SIDE})'`;
  try {
    await runFfmpeg(['-i', srcPath, '-vf', scale, '-q:v', '5', '-map_metadata', '-1', '-frames:v', '1', out]);
  } catch (e) {
    try { unlinkSync(out); } catch { /* файла могло не появиться */ }
    throw e;
  }
  if (!existsSync(out) || statSync(out).size === 0) throw new Error('ffmpeg не записал файл');
  return name;
}

/** То же для байтов из запроса: пишем во временный файл, перекодируем, убираем. */
export async function storePhotoFromBuffer(deviceId, buf) {
  if (!isJpeg(buf)) throw new Error('это не JPEG');
  const tmp = join(tmpdir(), `autocamera-upload-${randomBytes(6).toString('hex')}.jpg`);
  writeFileSync(tmp, buf);
  try {
    return await storePhotoFromFile(deviceId, tmp);
  } finally {
    try { unlinkSync(tmp); } catch { /* уже нет */ }
  }
}

export function deletePhotoFile(name) {
  const p = photoPath(name);
  if (!p) return false;
  try { unlinkSync(p); return true; } catch { return false; }
}
