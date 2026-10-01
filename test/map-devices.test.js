/**
 * Устройства на карте (v3.6) — разбор того, что прислал клиент.
 *
 * Проверяем только чистую нормализацию: запись в файл и маршруты — это уже
 * ввод-вывод, для них дешевле руками. Важно, что через ручку нельзя положить
 * в state/map-devices.json мусор: чужой тип, координаты «в никуда»,
 * несуществующий объект или имя с управляющими символами.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDevice, DEVICE_TYPES } from '../server/map-devices.js';

const point = { lat: 55.1, lon: 82.9 };

test('шесть типов устройств из ТЗ и рабочие места (v3.10) на месте', () => {
  assert.deepEqual(Object.keys(DEVICE_TYPES),
    ['hub', 'nvr', 'switch', 'router', 'phone', 'ap', 'pc', 'printer']);
});

test('компьютер и принтер ставятся так же, как остальные устройства', () => {
  const pc = normalizeDevice({ type: 'pc', system_id: 'site-1', floor: 2, ...point }, { systemIds: new Set(['site-1']) });
  assert.equal(pc.name, 'Компьютер');
  assert.equal(pc.floor, 2);
  assert.equal(pc.system_id, 'site-1');
  assert.deepEqual(pc.photos, []);
  assert.equal(normalizeDevice({ type: 'printer', ...point }).name, 'Принтер');
  // Смена типа в карточке: коммутатор → принтер, фото остаются при устройстве.
  const id = 'dev-00000000-0000-4000-8000-000000000001';
  const current = { id, type: 'switch', name: 'Коммутатор 1', photos: [`${id}-0123abcd.jpg`], ...point };
  const next = normalizeDevice({ type: 'printer' }, { current });
  assert.equal(next.type, 'printer');
  assert.deepEqual(next.photos, current.photos);
});

test('неизвестный тип не проходит', () => {
  assert.throws(() => normalizeDevice({ type: 'спутник', ...point }), /тип/);
  assert.throws(() => normalizeDevice({ ...point }), /тип/);
});

test('координаты обязательны и должны быть в пределах глобуса', () => {
  assert.throws(() => normalizeDevice({ type: 'hub' }), /координат/);
  assert.throws(() => normalizeDevice({ type: 'hub', lat: 95, lon: 0 }), /координат/);
  assert.throws(() => normalizeDevice({ type: 'hub', lat: 0, lon: 200 }), /координат/);
});

test('без имени берём подпись типа', () => {
  assert.equal(normalizeDevice({ type: 'ap', ...point }).name, 'Точка доступа');
  assert.equal(normalizeDevice({ type: 'ap', name: '   ', ...point }).name, 'Точка доступа');
});

test('имя чистится и обрезается', () => {
  const long = normalizeDevice({ type: 'nvr', name: 'я'.repeat(200), ...point });
  assert.equal(long.name.length, 60);
  const dirty = normalizeDevice({ type: 'nvr', name: '  Стойка\u0007 NVR  ', ...point });
  assert.equal(dirty.name, 'Стойка  NVR');
});

test('этаж только первый или второй', () => {
  assert.equal(normalizeDevice({ type: 'hub', floor: 2, ...point }).floor, 2);
  assert.equal(normalizeDevice({ type: 'hub', floor: '2', ...point }).floor, 2);
  assert.equal(normalizeDevice({ type: 'hub', floor: 7, ...point }).floor, 1);
  assert.equal(normalizeDevice({ type: 'hub', ...point }).floor, 1);
});

test('объект проверяется по конфигу, но не обязателен', () => {
  const known = new Set(['site-1']);
  assert.equal(normalizeDevice({ type: 'hub', system_id: 'site-1', ...point }, { systemIds: known }).system_id, 'site-1');
  assert.equal(normalizeDevice({ type: 'hub', ...point }, { systemIds: known }).system_id, '');
  assert.throws(() => normalizeDevice({ type: 'hub', system_id: 'site-9', ...point }, { systemIds: known }), /объект/);
});

test('правка сохраняет id и недосказанные поля', () => {
  const current = { id: 'dev-1', type: 'router', name: 'Роутер 1', system_id: 'site-1', floor: 2, ...point };
  const next = normalizeDevice({ name: 'Роутер у входа' }, { current });
  assert.equal(next.id, 'dev-1');
  assert.equal(next.name, 'Роутер у входа');
  assert.equal(next.type, 'router');
  assert.equal(next.floor, 2);
  assert.equal(next.system_id, 'site-1');
  assert.equal(next.lat, point.lat);
});

test('новой записи id выдаёт сервер, клиентский не берём', () => {
  const d = normalizeDevice({ id: '../../etc/passwd', type: 'switch', ...point });
  assert.match(d.id, /^dev-[0-9a-f-]{36}$/);
});
