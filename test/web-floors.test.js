import test from 'node:test';
import assert from 'node:assert/strict';

// Настройки веба читаются из окружения ОДИН раз при импорте модуля, поэтому
// задаём их до него. dotenv существующие переменные не перетирает, так что
// боевой .env на эти значения не влияет.
process.env.WEB_FLOOR2_CAMERAS = 'site-2|CH3, site-2|CH4 ,site-4|CH2,';
process.env.WEB_HIDE_CAMERAS = 'site-5|Камера 1';

const { parseList, config } = await import('../server/config.js');
const { floorOf } = await import('../server/status.js');

test('parseList: пробелы и пустые элементы отбрасываются', () => {
  assert.deepEqual(parseList(' a , b ,,c, '), ['a', 'b', 'c']);
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList(undefined), []);
});

test('этаж: перечисленные камеры — второй', () => {
  assert.equal(floorOf('site-2|CH3'), 2);
  assert.equal(floorOf('site-2|CH4'), 2);
  assert.equal(floorOf('site-4|CH2'), 2);
});

test('этаж: всё остальное — первый', () => {
  // Одноэтажные объекты в настройку не вписываем: их камеры должны попадать
  // в «1 этаж» сами, иначе пришлось бы перечислять все восемьдесят.
  assert.equal(floorOf('site-1|204'), 1);
  assert.equal(floorOf('site-5|Camera 01'), 1);
  assert.equal(floorOf('site-2|CH1'), 1);
  assert.equal(floorOf('site-4|CH3'), 1);
});

test('этаж: неизвестная камера не роняет проверку', () => {
  assert.equal(floorOf('нет-такой|камеры'), 1);
  assert.equal(floorOf(''), 1);
});

test('скрытые камеры разбираются в множество', () => {
  assert.ok(config.hideCameras.has('site-5|Камера 1'));
  assert.ok(!config.hideCameras.has('site-5|Camera 01'));
});
