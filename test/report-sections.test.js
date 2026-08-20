import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildReport } from '../src/reporter.js';

const DIR = mkdtempSync(join(tmpdir(), 'autocamera-report-'));
test.after(() => rmSync(DIR, { recursive: true, force: true }));

const systemResults = [
  {
    id: 'site-3', name: 'Объект 3 (NVR-C)', group: 'Группа A', type: 'hiwatch',
    cameras: [
      { index: 0, name: 'Camera 01', online: true, recording: true },
      { index: 5, name: 'Camera 06', online: true, recording: true },
    ],
  },
  {
    id: 'site-8', name: 'Объект 8 (ISAPI)', group: 'Группа B', type: 'hikvision-multi',
    cameras: [{ index: 0, name: 'Камера 7', online: true, recording: true }],
  },
];

const attention = [
  { cam_key: 'site-3|Camera 06', system_id: 'site-3', system: 'Объект 3 (NVR-C)',
    camera: 'Camera 06', downtime_min: 525, share_pct: 5, falls: 9, days: 7 },
  { cam_key: 'site-8|Камера 7', system_id: 'site-8', system: 'Объект 8 (ISAPI)',
    camera: 'Камера 7', downtime_min: 765, share_pct: 8, falls: 28, days: 7 },
];

const quality = [
  { cam_key: 'site-3|Camera 01', system_id: 'site-3', system: 'Объект 3 (NVR-C)',
    camera: 'Camera 01', defects: ['blurry'], defectsText: 'расфокусировка или грязный объектив', streak: 4 },
];

function render(group, forCustomer = false) {
  const out = join(DIR, `r-${group || 'all'}-${forCustomer ? 'cust' : 'eng'}.html`);
  buildReport({
    systemResults,
    runMeta: { startTime: Date.now(), durationMs: 1000, runMode: 'daily', attention, quality, timelineSummary: [] },
    group,
    outputPath: out,
    forCustomer,
  });
  return readFileSync(out, 'utf8');
}

test('блок «Требуют внимания» появляется и объясняет смысл', () => {
  const html = render('Группа A');
  assert.match(html, /Требуют внимания/);
  assert.match(html, /пропадали\s*\n?\s*и восстанавливались сами/);
  assert.match(html, /за последние 7 дн/);
});

test('«Требуют внимания» показывает простой в часах и число падений', () => {
  const html = render('Группа A');
  // 525 минут = 8 ч 45 мин
  assert.match(html, /8 ч 45 мин/);
  assert.match(html, />9</);
});

test('«Требуют внимания» фильтруется по группе письма', () => {
  const evro = render('Группа A');
  assert.match(evro, /Camera 06/);
  assert.doesNotMatch(evro, /Камера 7/);

  const online = render('Группа B');
  assert.match(online, /Камера 7/);
});

test('блок «Качество изображения» появляется с описанием дефекта', () => {
  const html = render('Группа A');
  assert.match(html, /Качество изображения/);
  assert.match(html, /расфокусировка или грязный объектив/);
  assert.match(html, /4 пров\./);
});

test('«Качество изображения» объясняет, что камера на связи', () => {
  const html = render('Группа A');
  assert.match(html, /на связи и передают видео, но изображение непригодно/);
});

test('без данных блоки не появляются вовсе', () => {
  const out = join(DIR, 'empty.html');
  buildReport({
    systemResults,
    runMeta: { startTime: Date.now(), durationMs: 1000, runMode: 'daily', timelineSummary: [] },
    group: 'Группа A',
    outputPath: out,
  });
  const html = readFileSync(out, 'utf8');
  assert.doesNotMatch(html, /Требуют внимания/);
  assert.doesNotMatch(html, /Качество изображения/);
});

test('полный отчёт без группы содержит обе группы', () => {
  const html = render(null);
  assert.match(html, /Camera 06/);
  assert.match(html, /Камера 7/);
});

// Инженерные секции — только для нашей поддержки. Заказчику уходит письмо
// в том же виде, в каком оно было до v3: статус, запись, объекты, история дня.
test('в письме заказчику инженерных секций нет', () => {
  const html = render('Группа A', true);
  assert.doesNotMatch(html, /Требуют внимания/);
  assert.doesNotMatch(html, /Качество изображения/);
});

test('привычные разделы в письме заказчику остаются на месте', () => {
  const html = render('Группа A', true);
  assert.match(html, /Не работают камеры/);
  assert.match(html, /Запись/);
  assert.match(html, /Объект 3/);
});

test('во внутреннем отчёте те же секции видны', () => {
  const html = render('Группа A', false);
  assert.match(html, /Требуют внимания/);
  assert.match(html, /Качество изображения/);
});
