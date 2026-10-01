/**
 * Фото устройств (v3.9) — чистая часть: имена файлов, JPEG-сигнатура, список
 * фото у записи, и что нормализация устройства не даёт клиенту подменить
 * список. Перекодирование ffmpeg'ом и маршруты — ввод-вывод, руками.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isJpeg, safePhotoName, newPhotoName, withPhoto, withoutPhoto, photoPath, MAX_PHOTOS } from '../server/device-photos.js';
import { normalizeDevice } from '../server/map-devices.js';

const ID = 'dev-123e4567-e89b-12d3-a456-426614174000';
const point = { lat: 55.1, lon: 82.9 };

test('isJpeg: только FF D8 FF, пустое и не-буфер — нет', () => {
  assert.equal(isJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), true);
  assert.equal(isJpeg(Buffer.from([0x89, 0x50, 0x4e, 0x47])), false, 'PNG');
  assert.equal(isJpeg(Buffer.from('<svg/>')), false);
  assert.equal(isJpeg(Buffer.alloc(0)), false);
  assert.equal(isJpeg('ffd8ff'), false);
});

test('newPhotoName даёт имя по шаблону, safePhotoName его принимает', () => {
  const name = newPhotoName(ID);
  assert.match(name, /^dev-[0-9a-f-]{36}-[0-9a-f]{8}\.jpg$/);
  assert.equal(safePhotoName(name), name);
  assert.ok(photoPath(name).endsWith(name));
});

test('safePhotoName: чужое имя, путь, обход каталога — null', () => {
  for (const bad of ['../.env', 'x.jpg', `${ID}-deadbeef.png`, `${ID}-deadbeef.jpg/..`, '', null, undefined,
    `${ID}-DEADBEEF.jpg`, `..\\${ID}-deadbeef.jpg`]) {
    assert.equal(safePhotoName(bad), null, String(bad));
    assert.equal(photoPath(bad), null, String(bad));
  }
});

test('withPhoto: добавляет, не дублирует, отсеивает мусор и держит потолок', () => {
  const a = newPhotoName(ID);
  const b = newPhotoName(ID);
  assert.deepEqual(withPhoto(undefined, a), [a]);
  assert.deepEqual(withPhoto([a], a), [a], 'повтор не добавляется');
  assert.deepEqual(withPhoto([a, '../x.jpg'], b), [a, b], 'мусор из старого списка выкинут');
  const full = Array.from({ length: MAX_PHOTOS }, () => newPhotoName(ID));
  assert.throws(() => withPhoto(full, newPhotoName(ID)), /больше/);
});

test('withoutPhoto: убирает нужное, остальное чистит по шаблону', () => {
  const a = newPhotoName(ID);
  const b = newPhotoName(ID);
  assert.deepEqual(withoutPhoto([a, b, 'junk'], a), [b]);
  assert.deepEqual(withoutPhoto(null, a), []);
});

test('normalizeDevice: photos берутся из записи, клиентский список игнорируется', () => {
  const mine = newPhotoName(ID);
  const current = { id: ID, type: 'hub', name: 'Хаб', system_id: '', floor: 1, ...point, photos: [mine, 'bad.jpg'] };
  const next = normalizeDevice({ name: 'Хаб 2', photos: ['../../etc/passwd'] }, { current });
  assert.deepEqual(next.photos, [mine], 'своё оставили, мусор и клиентское — нет');
  assert.deepEqual(normalizeDevice({ type: 'hub', photos: ['x.jpg'], ...point }).photos, [], 'у новой записи фото нет');
});
