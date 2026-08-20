// Тесты чистых хелперов timeline (src/timeline.js) — формат и ключи.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, todayYmd, cameraKey } from '../src/timeline.js';

test('formatDuration: ноль/отрицательное/null → "<1 мин"', () => {
  assert.equal(formatDuration(0), '<1 мин');
  assert.equal(formatDuration(-5), '<1 мин');
  assert.equal(formatDuration(null), '<1 мин');
});

test('formatDuration: меньше часа → "N мин"', () => {
  assert.equal(formatDuration(1), '1 мин');
  assert.equal(formatDuration(59), '59 мин');
});

test('formatDuration: ровные часы → "N ч"', () => {
  assert.equal(formatDuration(60), '1 ч');
  assert.equal(formatDuration(120), '2 ч');
});

test('formatDuration: часы с минутами → "H ч M мин"', () => {
  assert.equal(formatDuration(90), '1 ч 30 мин');
  assert.equal(formatDuration(125), '2 ч 5 мин');
});

test('todayYmd: дата форматируется с ведущими нулями', () => {
  assert.equal(todayYmd(new Date(2026, 4, 31)), '2026-05-31'); // май = индекс 4
  assert.equal(todayYmd(new Date(2026, 0, 5)), '2026-01-05');
});

test('cameraKey: ключ вида systemId|cameraName', () => {
  assert.equal(cameraKey('office', 'CH11'), 'office|CH11');
});
