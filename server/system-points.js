/**
 * system-points.js — координаты ОБЪЕКТОВ (систем) для карты.
 *
 * Пара к `camera-points.js`: там точки каждой камеры, которые расставляет админ
 * мышью, здесь — центр объекта целиком. Нужен для двух вещей:
 *   • камеры без своих координат раскладываются вокруг центра СВОЕГО объекта,
 *     а не общего центра карты — иначе камеры разных объектов легли бы одной
 *     кучей и растащить их было бы невозможно;
 *   • фронт подгоняет границы карты по объектам (площадки бывают разнесены
 *     на сотни метров, на одном зуме все сразу не видны).
 *
 * Источник — `public/points.json`, который собирается из `geo.txt`
 * (`npm run build-points`). Оба файла в git не идут: координаты объектов
 * заказчика — чувствительные данные. Правка geo.txt без пересборки points.json
 * ничего не меняет — это осознанный контракт, описанный в geo.txt.example.
 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FILE = join(ROOT, 'public', 'points.json');

// Кэш с проверкой mtime — как в camera-points.js: /api/status зовёт это на
// каждый опрос, а файл меняется раз в полгода.
let cache = { mtimeMs: -1, map: {} };

/** @returns {Record<string, {lat:number, lon:number}>} id системы → координаты */
export function readSystemPoints() {
  try {
    const st = statSync(FILE);
    if (st.mtimeMs !== cache.mtimeMs) {
      const arr = JSON.parse(readFileSync(FILE, 'utf8'));
      const map = {};
      if (Array.isArray(arr)) {
        for (const p of arr) {
          if (p && p.id && Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
            map[p.id] = { lat: p.lat, lon: p.lon };
          }
        }
      }
      cache = { mtimeMs: st.mtimeMs, map };
    }
  } catch {
    // Нет файла или битый JSON — координат объектов просто нет. Карта при этом
    // работает: камеры без координат лягут у общего центра из .env.
    cache = { mtimeMs: -1, map: {} };
  }
  return cache.map;
}
