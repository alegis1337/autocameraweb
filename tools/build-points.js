/**
 * build-points.js — сборка public/points.json из geo.txt.
 *
 * Перенесено из проекта wifi-monitor («рынок»), tools/build-points.js. Отличие:
 * там точка = Wi-Fi AP и коды радио, здесь точка = объект видеонаблюдения
 * (система из config/systems.json), а камеры показываются внутри его карточки.
 *
 * Имя и группа объекта в points.json не пишутся: их отдаёт сервер из
 * monitor.db вместе со статусом. В файле — только привязка id к координатам,
 * чтобы правка координат не требовала пересборки чего-либо ещё.
 *
 * Запуск: npm run build-points  (или node tools/build-points.js)
 */

// .env нужен до loadSystems(): в systems.json адреса заданы ${ПЛЕЙСХОЛДЕРАМИ},
// без него config-loader завалит вывод предупреждениями о неразрешённых.
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadSystems } from '../src/config-loader.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'geo.txt');
const OUT_DIR = join(ROOT, 'public');
const OUT = join(OUT_DIR, 'points.json');

const LINE = /^\(([^)]+)\)\s+([-\d.]+)\s*,\s*([-\d.]+)\s*$/;

function parse(text) {
  const points = [];
  const seen = new Set();
  let lineNo = 0;

  for (const raw of text.split(/\r?\n/)) {
    lineNo += 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const m = line.match(LINE);
    if (!m) {
      console.warn(`[build-points] строка ${lineNo} не распознана, пропуск: ${line}`);
      continue;
    }
    const id = m[1].trim();
    const lat = Number(m[2]);
    const lon = Number(m[3]);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      console.warn(`[build-points] строка ${lineNo}: пустой id или координаты, пропуск`);
      continue;
    }
    if (seen.has(id)) {
      console.warn(`[build-points] строка ${lineNo}: id "${id}" уже был, пропуск`);
      continue;
    }
    seen.add(id);
    points.push({ id, lat, lon });
  }
  return points;
}

function main() {
  let text;
  try {
    text = readFileSync(SRC, 'utf8');
  } catch {
    console.error(`[build-points] не найден ${SRC} — скопируйте geo.txt.example в geo.txt`);
    process.exit(1);
  }

  const points = parse(text);

  // Сверяемся с systems.json: опечатка в id тихо убрала бы объект с карты.
  try {
    const known = new Set(loadSystems().map((s) => s.id));
    for (const p of points) {
      if (!known.has(p.id)) console.warn(`[build-points] id "${p.id}" нет в config/systems.json`);
    }
    for (const id of known) {
      if (!points.some((p) => p.id === id)) console.warn(`[build-points] система "${id}" без координат — на карте не будет`);
    }
  } catch (e) {
    console.warn(`[build-points] не удалось сверить с systems.json: ${e.message}`);
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify(points, null, 2) + '\n', 'utf8');
  console.log(`[build-points] объектов: ${points.length} → ${OUT}`);
}

main();
