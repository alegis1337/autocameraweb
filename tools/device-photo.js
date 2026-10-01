/**
 * device-photo.js — фотографии устройств на карте с командной строки (v3.9).
 *
 * Пара к загрузке из режима редактора: когда снимков много и они уже лежат
 * папкой на диске, привязывать их мышью по одному долго. Делает то же, что
 * ручка POST /api/device-photo: перекодирует ffmpeg'ом в state/device-photos/
 * и дописывает имя в `photos` записи устройства (state/map-devices.json).
 *
 *   node tools/device-photo.js list [подстрока]        — устройства и их фото
 *   node tools/device-photo.js add <id|имя> <файл...>   — привязать снимки
 *   node tools/device-photo.js remove <id|имя> <фото|all>
 *
 * Устройство ищется по id или по точному имени («Хаб 10»), без учёта регистра.
 * Боевой веб подхватит изменения сам: файл устройств он перечитывает по mtime.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readDevices, addDevicePhoto, removeDevicePhoto, DEVICE_TYPES } from '../server/map-devices.js';
import { storePhotoFromFile, deletePhotoFile } from '../server/device-photos.js';

const [cmd, ...args] = process.argv.slice(2);

function findDevice(key) {
  const list = readDevices();
  const k = String(key || '').trim().toLowerCase();
  const hits = list.filter((d) => d.id === key || d.name.toLowerCase() === k);
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`устройство «${key}» не найдено — смотрите list`);
  throw new Error(`имя «${key}» неоднозначно (${hits.length} шт.) — укажите id`);
}

function list(filter = '') {
  const f = filter.toLowerCase();
  const rows = readDevices().filter((d) => !f || `${d.name} ${d.system_id} ${d.type}`.toLowerCase().includes(f));
  for (const d of rows) {
    const photos = (d.photos || []).length;
    console.log(`${d.id}  ${(DEVICE_TYPES[d.type] || d.type).padEnd(14)} ${d.name.padEnd(22)} ${(d.system_id || '—').padEnd(18)} эт.${d.floor}  фото: ${photos}`);
  }
  console.log(`всего: ${rows.length}`);
}

async function add(key, files) {
  if (!files.length) throw new Error('укажите хотя бы один файл');
  const dev = findDevice(key);
  for (const f of files) {
    const src = resolve(f);
    if (!existsSync(src)) throw new Error(`нет файла: ${src}`);
    const name = await storePhotoFromFile(dev.id, src);
    try {
      addDevicePhoto(dev.id, name);
    } catch (e) {
      deletePhotoFile(name);
      throw e;
    }
    console.log(`${dev.name}: + ${name}  (из ${f})`);
  }
}

function remove(key, which) {
  const dev = findDevice(key);
  const targets = which === 'all' ? [...(dev.photos || [])] : [which];
  for (const name of targets) {
    if (!(dev.photos || []).includes(name)) { console.log(`${dev.name}: фото ${name} не привязано`); continue; }
    removeDevicePhoto(dev.id, name);
    deletePhotoFile(name);
    console.log(`${dev.name}: − ${name}`);
  }
}

try {
  if (cmd === 'list') list(args[0]);
  else if (cmd === 'add') await add(args[0], args.slice(1));
  else if (cmd === 'remove') remove(args[0], args[1]);
  else {
    console.log('Использование:\n  list [подстрока]\n  add <id|имя> <файл...>\n  remove <id|имя> <фото|all>');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error('Ошибка:', e.message);
  process.exit(1);
}
