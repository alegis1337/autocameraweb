/**
 * camera-points.js — координаты камер для карты (v3.2).
 *
 * В отличие от `public/points.json` (координаты ОБЪЕКТОВ, собираются из geo.txt
 * и только читаются), здесь координаты КАЖДОЙ камеры, и файл сервер ПИШЕТ: их
 * расставляет админ мышью в режиме редактора. Поэтому файл лежит в `state/`
 * (рантайм, в git не идёт), а не в public/.
 *
 * Формат: { "<cam_key>": { "lat": <число>, "lon": <число> }, ... }
 * cam_key — тот же ключ, что у камеры в /api/status (`<sysId>|<имя камеры>`).
 */
import { readFileSync, writeFileSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FILE = join(ROOT, 'state', 'camera-points.json');

// Кэш с проверкой mtime: /api/status зовёт это на каждый опрос, но перечитываем
// файл, только если он изменился (после сохранения из редактора).
let cache = { mtimeMs: -1, map: {} };

export function readCameraPoints() {
  try {
    const st = statSync(FILE);
    if (st.mtimeMs !== cache.mtimeMs) {
      const obj = JSON.parse(readFileSync(FILE, 'utf8'));
      cache = { mtimeMs: st.mtimeMs, map: obj && typeof obj === 'object' ? obj : {} };
    }
  } catch {
    // Нет файла или битый JSON — координат просто нет, карта расставит камеры
    // хаотично, редактор их сохранит.
    cache = { mtimeMs: -1, map: {} };
  }
  return cache.map;
}

/**
 * Сохранить/удалить координату камеры. lat/lon = null → убрать точку.
 * @returns {{lat:number,lon:number}|null} итоговая точка камеры
 */
export function saveCameraPoint(camKey, lat, lon) {
  const map = { ...readCameraPoints() };
  if (lat === null || lon === null) {
    delete map[camKey];
  } else {
    map[camKey] = { lat, lon };
  }
  const dir = dirname(FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(FILE, JSON.stringify(map, null, 2) + '\n', 'utf8');
  // Сбрасываем кэш: следующее чтение перечитает файл по новому mtime.
  cache = { mtimeMs: -1, map: {} };
  return map[camKey] || null;
}
