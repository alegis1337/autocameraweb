/**
 * Регрессия 20.08.2026 — «письма заказчику молча перестали уходить».
 *
 * `.env` грузился в теле `index.js`, то есть ПОСЛЕ его импортов, а
 * `reporter.js` читал `REPORT_GROUPS` на верхнем уровне модуля. Группы
 * оказывались пустыми, цикл формирования отчётов по группам не давал ни
 * одного письма — и никакой ошибки при этом не было.
 *
 * Тест закрепляет лечение: группы разбираются ЛЕНИВО, при первом обращении,
 * поэтому переменная, появившаяся уже после импорта, всё равно видна.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// На момент импорта переменной нет — ровно как при опоздавшем .env.
delete process.env.REPORT_GROUPS;
const { reportGroups, groupRecipients } = await import('../src/reporter.js');

test('группы видны, даже если .env появился уже после импорта модуля', () => {
  process.env.REPORT_GROUPS  = 'Группа A:AAA,Группа B:BBB';
  process.env.REPORT_TO_AAA  = 'a@example.com';
  process.env.REPORT_TO_BBB  = 'b1@example.com,b2@example.com';

  assert.deepEqual(reportGroups(), ['Группа A', 'Группа B'], 'порядок групп — как в .env');
  assert.equal(groupRecipients('Группа A'), 'a@example.com');
  assert.equal(groupRecipients('Группа B'), 'b1@example.com,b2@example.com');
});

test('группа без суффикса и незнакомая группа отдают пусто (фолбэк на REPORT_TO)', () => {
  assert.equal(groupRecipients('Группа C'), '', 'группы нет в REPORT_GROUPS');
});
