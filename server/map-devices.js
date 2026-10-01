/**
 * map-devices.js — устройства на карте, которые НЕ камеры (v3.6).
 *
 * Хабы, регистраторы, коммутаторы, роутеры, телефоны, точки доступа, а с v3.10
 * ещё компьютеры и принтеры. Мониторинг
 * их не опрашивает: это отметки «что и где стоит», а не состояние. Поэтому они
 * живут не в `monitor.db` (туда пишут прогоны), а в отдельном файле
 * `state/map-devices.json`, который правит только веб — как и координаты камер
 * в `camera-points.js`.
 *
 * Формат файла — массив записей:
 *   { id, type, name, system_id, floor, lat, lon, photos: [<имя файла>, ...] }
 * `id` выдаёт сервер: клиенту доверять формирование ключа нельзя.
 * `photos` (v3.9) — фотографии устройства, файлы в state/device-photos/
 * (см. device-photos.js); клиент этот список не присылает, его меняют
 * только ручки загрузки/удаления фото.
 * `system_id` привязывает устройство к объекту, чтобы фильтр по объектам и
 * этажам на карте работал для устройств так же, как для камер.
 *
 * Новый тип устройства = одна строка в DEVICE_TYPES + фигура в public/app.js
 * (DEVICE_SHAPES). Список типов уходит во фронт через /config.js, поэтому
 * кнопки редактора и подписи строятся по нему, а не по зашитому списку.
 */
import { readFileSync, writeFileSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withPhoto, withoutPhoto, safePhotoName } from './device-photos.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FILE = join(ROOT, 'state', 'map-devices.json');

/** Типы устройств: id → подпись. Порядок задаёт порядок кнопок в редакторе. */
export const DEVICE_TYPES = {
  hub:     'Хаб',
  nvr:     'Регистратор',
  switch:  'Коммутатор',
  router:  'Роутер',
  phone:   'Телефон',
  ap:      'Точка доступа',
  pc:      'Компьютер',
  printer: 'Принтер',
};

/** Потолок на всякий случай: файл читается на каждый опрос карты. */
export const MAX_DEVICES = 500;

const NAME_MAX = 60;

// Кэш с проверкой mtime — как в camera-points.js: /api/status зовёт чтение на
// каждый опрос, а файл меняется только когда админ что-то поставил.
let cache = { mtimeMs: -1, list: [] };

export function readDevices() {
  try {
    const st = statSync(FILE);
    if (st.mtimeMs !== cache.mtimeMs) {
      const arr = JSON.parse(readFileSync(FILE, 'utf8'));
      cache = { mtimeMs: st.mtimeMs, list: Array.isArray(arr) ? arr : [] };
    }
  } catch {
    // Файла ещё нет (устройств не ставили) или он битый — на карте просто нет
    // устройств; первое сохранение создаст файл заново.
    cache = { mtimeMs: -1, list: [] };
  }
  return cache.list;
}

function writeDevices(list) {
  const dir = dirname(FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(FILE, JSON.stringify(list, null, 2) + '\n', 'utf8');
  cache = { mtimeMs: -1, list: [] };   // следующее чтение перечитает файл
}

/** Имя устройства: без управляющих символов и разумной длины. */
function cleanName(raw, fallback) {
  // Управляющие символы (коды < 32) в имя не пускаем: они ломают и файл,
  // и разметку балуна на карте.
  const s = [...String(raw ?? '')].map((c) => (c.codePointAt(0) < 32 ? ' ' : c)).join('')
    .trim().slice(0, NAME_MAX);
  return s || fallback;
}

/**
 * Привести присланную клиентом запись к виду, который можно писать в файл.
 * Чистая функция (никакого ввода-вывода) — её же проверяют тесты.
 *
 * @param {object} input      — тело запроса
 * @param {object} [opts]
 * @param {object} [opts.current]   — существующая запись (правка) или null (создание)
 * @param {Set}    [opts.systemIds] — id известных объектов; null — не проверять
 * @returns {object} нормализованная запись
 * @throws {Error} с человеческим текстом — он уходит клиенту как есть
 */
export function normalizeDevice(input, { current = null, systemIds = null } = {}) {
  const type = String(input?.type ?? current?.type ?? '');
  if (!Object.hasOwn(DEVICE_TYPES, type)) throw new Error('неизвестный тип устройства');

  const lat = Number(input?.lat ?? current?.lat);
  const lon = Number(input?.lon ?? current?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error('некорректные координаты');
  }

  // Объект не обязателен: устройство может стоять между площадками. Без него
  // оно видно при любом фильтре — прятать отметку, которую некуда отнести,
  // хуже, чем показать лишнюю.
  const systemId = String(input?.system_id ?? current?.system_id ?? '').trim();
  if (systemId && systemIds && !systemIds.has(systemId)) throw new Error('неизвестный объект');

  const floorRaw = Number(input?.floor ?? current?.floor ?? 1);
  const floor = floorRaw === 2 ? 2 : 1;

  return {
    id: current?.id || `dev-${randomUUID()}`,
    type,
    name: cleanName(input?.name ?? current?.name, DEVICE_TYPES[type]),
    system_id: systemId,
    floor,
    lat,
    lon,
    // Фото — только из существующей записи: с клиента список не принимаем,
    // им управляют отдельные ручки. Чужие имена отсеиваем на всякий случай.
    photos: (Array.isArray(current?.photos) ? current.photos : []).filter((p) => safePhotoName(p)),
  };
}

/**
 * Создать или обновить устройство. Без `input.id` — создание.
 * @returns {object} сохранённая запись
 */
export function saveDevice(input, { systemIds = null } = {}) {
  const list = [...readDevices()];
  const id = input?.id ? String(input.id) : '';
  const idx = id ? list.findIndex((d) => d.id === id) : -1;
  if (id && idx < 0) throw new Error('устройство не найдено');
  if (idx < 0 && list.length >= MAX_DEVICES) throw new Error(`больше ${MAX_DEVICES} устройств не поставить`);

  const device = normalizeDevice(input, { current: idx >= 0 ? list[idx] : null, systemIds });
  if (idx >= 0) list[idx] = device; else list.push(device);
  writeDevices(list);
  return device;
}

/** Удалить устройство. @returns {object|null} удалённая запись (чтобы убрать её фото) */
export function deleteDevice(id) {
  const list = readDevices();
  const removed = list.find((d) => d.id === String(id)) || null;
  if (!removed) return null;
  writeDevices(list.filter((d) => d !== removed));
  return removed;
}

/** Привязать файл фото к устройству. @returns {object} обновлённая запись */
export function addDevicePhoto(id, name) {
  const list = [...readDevices()];
  const idx = list.findIndex((d) => d.id === String(id));
  if (idx < 0) throw new Error('устройство не найдено');
  list[idx] = { ...list[idx], photos: withPhoto(list[idx].photos, name) };
  writeDevices(list);
  return list[idx];
}

/** Отвязать фото. @returns {object|null} обновлённая запись или null, если устройства нет */
export function removeDevicePhoto(id, name) {
  const list = [...readDevices()];
  const idx = list.findIndex((d) => d.id === String(id));
  if (idx < 0) return null;
  list[idx] = { ...list[idx], photos: withoutPhoto(list[idx].photos, name) };
  writeDevices(list);
  return list[idx];
}
