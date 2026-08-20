import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHelpdeskTextHtml, countHelpdeskIssues } from '../src/reporter.js';

const runMeta = { startTime: Date.parse('2026-08-04T07:00:00+03:00') };

const brokenCam = (sysId, sysName, camera) => ({
  systemId: sysId, system: sysName, group: 'Группа A', camera, status: 'OFFLINE', notes: '',
});

// Объект, у которого легли все 16 камер.
const vyduvAll = Array.from({ length: 16 }, (_, i) =>
  brokenCam('site-5', 'Объект 5 (NVR-C)', `Camera ${String(i + 1).padStart(2, '0')}`));

const outages = {
  downSystems: new Set(['site-5']),
  bySystem: new Map([['site-5', { total: 16, broken: 16 }]]),
};

test('упавший целиком объект сворачивается в одну строку', () => {
  const html = buildHelpdeskTextHtml(vyduvAll, runMeta, 'Группа A', outages);
  assert.match(html, /объект недоступен целиком/);
  assert.match(html, /не отвечают 16 камер из 16/);
  // Перечисления камер быть не должно.
  assert.doesNotMatch(html, /не работают камеры:/);
});

test('без данных о сбое объекта письмо остаётся прежним', () => {
  const html = buildHelpdeskTextHtml(vyduvAll, runMeta, 'Группа A');
  assert.match(html, /не работают камеры:/);
  assert.doesNotMatch(html, /объект недоступен целиком/);
});

test('одиночная поломка на здоровом объекте перечисляется по-старому', () => {
  const list = [brokenCam('site-3', 'Объект 3 (NVR-C)', 'Camera 06')];
  const html = buildHelpdeskTextHtml(list, runMeta, 'Группа A', outages);
  assert.match(html, /Объект 3 — не работают камеры: 6/);
  assert.doesNotMatch(html, /Объект 3.*объект недоступен/);
});

test('упавший объект и одиночная поломка соседствуют в одном письме', () => {
  const list = [...vyduvAll, brokenCam('site-3', 'Объект 3 (NVR-C)', 'Camera 06')];
  const html = buildHelpdeskTextHtml(list, runMeta, 'Группа A', outages);
  assert.match(html, /Объект 5 — объект недоступен целиком/);
  assert.match(html, /Объект 3 — не работают камеры: 6/);
});

test('countHelpdeskIssues: упавший объект считается за одну проблему', () => {
  assert.equal(countHelpdeskIssues(vyduvAll, outages), 1);
  assert.equal(countHelpdeskIssues([...vyduvAll, brokenCam('site-3', 'Объект 3 (NVR-C)', 'Camera 06')], outages), 2);
});

test('countHelpdeskIssues: без сбоя объекта считаем камеры как раньше', () => {
  assert.equal(countHelpdeskIssues(vyduvAll), 16);
  assert.equal(countHelpdeskIssues(vyduvAll, null), 16);
});

test('заголовок письма не спорит с телом', () => {
  const html = buildHelpdeskTextHtml(vyduvAll, runMeta, 'Группа A', outages);
  // В теле одна проблема — и в шапке письма должна стоять единица.
  assert.match(html, /выявила <strong>1<\/strong> проблему/);
});

// ─── Одно письмо на всё: поломки + «обратить внимание» + картинка ────────────

const attentionRows = [
  { system: 'Объект 3 (NVR-C)', camera: 'Camera 06', falls: 9, downtime_min: 525, days: 7 },
  { system: 'Объект 4 (NVR-B)', camera: 'CH2', falls: 15, downtime_min: 315, days: 7 },
];
const qualityRows = [
  { system: 'Объект 2 (NVR-B)', camera: 'IPCamera 03', defectsText: 'помехи на изображении', streak: 4 },
];

test('нестабильные камеры перечислены в том же письме', () => {
  const list = [brokenCam('site-3', 'Объект 3 (NVR-C)', 'Camera 06')];
  const html = buildHelpdeskTextHtml(list, runMeta, 'Группа A', null, { attention: attentionRows });
  assert.match(html, /Объект 3 — не работают камеры: 6/);
  assert.match(html, /Объект 3 — камера 6: пропадала 9 раз, суммарно не работала 8 ч 45 мин/);
  assert.match(html, /Объект 4 — камера 2: пропадала 15 раз, суммарно не работала 5 ч 15 мин/);
  assert.match(html, /связь регулярно пропадает/);
});

test('склонение «раз/раза» по числу падений', () => {
  const rows = [
    { system: 'A (X)', camera: 'CH1', falls: 1,   downtime_min: 60, days: 7 },
    { system: 'A (X)', camera: 'CH2', falls: 74,  downtime_min: 60, days: 7 },
    { system: 'A (X)', camera: 'CH3', falls: 131, downtime_min: 60, days: 7 },
    { system: 'A (X)', camera: 'CH4', falls: 12,  downtime_min: 60, days: 7 },
  ];
  const html = buildHelpdeskTextHtml([], runMeta, 'Группа A', null, { attention: rows });
  assert.match(html, /камера 1: пропадала 1 раз,/);
  assert.match(html, /камера 2: пропадала 74 раза,/);
  assert.match(html, /камера 3: пропадала 131 раз,/);
  assert.match(html, /камера 4: пропадала 12 раз,/);
});

test('дефекты изображения перечислены в том же письме', () => {
  const list = [brokenCam('site-3', 'Объект 3 (NVR-C)', 'Camera 06')];
  const html = buildHelpdeskTextHtml(list, runMeta, 'Группа A', null, { quality: qualityRows });
  assert.match(html, /Обратите внимание на изображение/);
  assert.match(html, /Объект 2 — камера IP3: помехи на изображении/);
});

test('повторное упоминание и ухудшение помечаются', () => {
  const rows = [
    { system: 'Объект 3 (NVR-C)', camera: 'Camera 06', falls: 20, downtime_min: 600, days: 7, repeat: true, worse: true },
    { system: 'Объект 3 (NVR-C)', camera: 'Camera 15', falls: 11, downtime_min: 450, days: 7, repeat: true, worse: false },
  ];
  const html = buildHelpdeskTextHtml([], runMeta, 'Группа A', null, { attention: rows });
  assert.match(html, /камера 6:.*— стало хуже/);
  assert.match(html, /камера 15:.*— повторно/);
});

test('без поломок письмо честно говорит, что неработающих камер нет', () => {
  const html = buildHelpdeskTextHtml([], runMeta, 'Группа A', null, { attention: attentionRows });
  assert.match(html, /неработающих камер нет/);
  assert.doesNotMatch(html, /выявила <strong>0<\/strong>/);
  assert.match(html, /Объект 3 — камера 6: пропадала 9 раз/);
});

test('без событий разделы «обратите внимание» не появляются', () => {
  const list = [brokenCam('site-3', 'Объект 3 (NVR-C)', 'Camera 06')];
  const html = buildHelpdeskTextHtml(list, runMeta, 'Группа A');
  assert.doesNotMatch(html, /связь регулярно пропадает/);
  assert.doesNotMatch(html, /Обратите внимание на изображение/);
});

// ─── Вид письма: разделы, отступы, формулировки (18.08.2026) ─────────────────

test('разделы письма пронумерованы и идут списком с отступом', () => {
  const list = [brokenCam('site-3', 'Объект 3 (NVR-C)', 'Camera 06')];
  const html = buildHelpdeskTextHtml(list, runMeta, 'Группа A', null,
    { attention: attentionRows, quality: qualityRows });
  assert.match(html, /<strong>1\. Не работают камеры<\/strong>/);
  assert.match(html, /<strong>2\. Работают, но связь регулярно пропадает/);
  assert.match(html, /<strong>3\. Обратите внимание на изображение<\/strong>/);
  assert.match(html, /<ul>\s*\n\s*<li>/);
});

test('нумерация сквозная — пропущенные разделы не оставляют дыр', () => {
  const html = buildHelpdeskTextHtml([], runMeta, 'Группа A', null, { quality: qualityRows });
  assert.match(html, /<strong>1\. Обратите внимание на изображение<\/strong>/);
  assert.doesNotMatch(html, /<strong>2\./);
});

test('в письме нет подсказок «почему так» — инженеры их не просили', () => {
  const list = [brokenCam('site-3', 'Объект 3 (NVR-C)', 'Camera 06')];
  const html = buildHelpdeskTextHtml(list, runMeta, 'Группа A', null,
    { attention: attentionRows, quality: qualityRows });
  assert.doesNotMatch(html, /на стороне сети или питания/);
  assert.doesNotMatch(html, /Обычные причины/);
  assert.doesNotMatch(html, /разобрать ничего/);
});

test('повторная поломка подписана датой, новая — нет', () => {
  const old = { ...brokenCam('site-3', 'Объект 3 (NVR-C)', 'Camera 06'),
    _brokenSince: '2026-08-16T04:05:06Z' };
  assert.match(buildHelpdeskTextHtml([old], runMeta, 'Группа A'), /не работает с 16\.08/);
  const fresh = brokenCam('site-3', 'Объект 3 (NVR-C)', 'Camera 06');
  assert.doesNotMatch(buildHelpdeskTextHtml([fresh], runMeta, 'Группа A'), /не работает с/);
});

test('смена ракурса вынесена из дефектов изображения в свой раздел', () => {
  const rows = [
    { system: 'Объект 2 (NVR-B)', camera: 'CH4', defects: ['angle-changed'], defectsText: 'изменился ракурс' },
    { system: 'Объект 3 (NVR-C)', camera: 'Camera 07', defects: ['blurry', 'angle-changed'],
      defectsText: 'расфокусировка или грязный объектив, изменился ракурс' },
  ];
  const html = buildHelpdeskTextHtml([], runMeta, 'Группа A', null, { quality: rows });
  assert.match(html, /Камеры смотрят не туда, куда раньше/);
  assert.match(html, /изменился сектор обзора/);
  // Камера только с ракурсом в раздел про качество не попадает…
  assert.doesNotMatch(html, /Объект 2 — камера 4: /);
  // …а камера с настоящим дефектом — попадает, но уже без слова «ракурс».
  assert.match(html, /Объект 3 — камера 7: расфокусировка или грязный объектив/);
  assert.doesNotMatch(html, /камера 7: расфокусировка[^<]*ракурс/);
});

test('только смена ракурса — раздела про качество изображения нет', () => {
  const rows = [{ system: 'Объект 2 (NVR-B)', camera: 'CH4', defects: ['angle-changed'], defectsText: 'изменился ракурс' }];
  const html = buildHelpdeskTextHtml([], runMeta, 'Группа A', null, { quality: rows });
  assert.doesNotMatch(html, /Обратите внимание на изображение/);
  assert.match(html, /Камеры смотрят не туда/);
});
