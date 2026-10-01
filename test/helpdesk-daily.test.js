/**
 * Ежедневное письмо в helpdesk (v3.7).
 *
 * До 04.09.2026 письмо уходило только по событию, и «тихое» утро выглядело
 * ровно так же, как сломанная рассылка — что и позволило ей молчать две
 * недели. Теперь письмо приходит каждый день и первым делом сообщает, ушёл ли
 * отчёт заказчику.
 *
 * Проверяем чистую сборку письма и темы: сама отправка — это SMTP, её
 * юнит-тестом не берём.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHelpdeskTextHtml, helpdeskSubject } from '../src/reporter.js';

const runMeta = { startTime: Date.parse('2026-09-04T07:00:00+03:00') };
const cleanStats = { total: 77, online: 77, broken: 0, unknown: 0 };

const brokenCam = (camera) => ({
  systemId: 'site-1', system: 'Объект 1 (NVR-A)', group: 'Группа A',
  camera, status: 'OFFLINE', notes: '',
});

// ── Строка о рассылке отчёта заказчику ────────────────────────────────────────

test('отчёт ушёл — письмо говорит «отправлен» и считает адресатов', () => {
  const html = buildHelpdeskTextHtml([], runMeta, 'Группа A', null, {
    delivery: { sent: true, to: 'a@example.com, b@example.com, c@example.com' },
    stats: cleanStats,
  });
  assert.match(html, /Отчёт по видеонаблюдению за 04\.09\.2026 <strong>отправлен<\/strong> заказчику \(3 адреса\)/);
  assert.doesNotMatch(html, /НЕ отправлен/);
});

test('отчёт не ушёл — письмо говорит «НЕ отправлен» и называет причину', () => {
  const html = buildHelpdeskTextHtml([], runMeta, 'Группа A', null, {
    delivery: { sent: false, to: 'a@example.com', error: 'SMTP 451 timeout' },
    stats: cleanStats,
  });
  assert.match(html, /заказчику НЕ отправлен/);
  assert.match(html, /Причина: SMTP 451 timeout/);
  assert.match(html, /попробует дослать/);
});

test('причина экранируется — текст ошибки приходит извне', () => {
  const html = buildHelpdeskTextHtml([], runMeta, 'Группа A', null, {
    delivery: { sent: false, error: '<b>сломалось</b> & точка' },
    stats: cleanStats,
  });
  assert.match(html, /&lt;b&gt;сломалось&lt;\/b&gt; &amp; точка/);
});

test('без данных о рассылке строки нет вовсе', () => {
  const html = buildHelpdeskTextHtml([], runMeta, 'Группа A', null, { stats: cleanStats });
  assert.doesNotMatch(html, /Отчёт по видеонаблюдению за/);
});

// ── «Все камеры работают» ─────────────────────────────────────────────────────

test('тихое утро: все камеры работают, со сводкой', () => {
  const html = buildHelpdeskTextHtml([], runMeta, 'Группа A', null, {
    delivery: { sent: true, to: 'a@example.com' },
    stats: cleanStats,
  });
  assert.match(html, /<strong>все камеры работают<\/strong>, замечаний нет/);
  assert.match(html, /Проверено камер: <strong>77<\/strong> — работают 77\./);
  assert.match(html, /<title>Все камеры работают 04\.09\.2026<\/title>/);
});

test('есть камеры без данных — «все работают» не утверждаем', () => {
  const html = buildHelpdeskTextHtml([], runMeta, 'Группа A', null, {
    stats: { total: 77, online: 75, broken: 0, unknown: 2 },
  });
  assert.doesNotMatch(html, /все камеры работают/);
  assert.match(html, /неработающих камер нет/);
  assert.match(html, /нет данных 2/);
});

test('поломки есть — заголовок прежний, сводка рядом', () => {
  const html = buildHelpdeskTextHtml([brokenCam('Camera 06')], runMeta, 'Группа A', null, {
    delivery: { sent: true, to: 'a@example.com' },
    stats: { total: 77, online: 76, broken: 1, unknown: 0 },
  });
  assert.match(html, /выявила <strong>1<\/strong> проблему/);
  assert.match(html, /не работают камеры: 6/);
  assert.match(html, /работают 76, не работают 1/);
  assert.match(html, /<strong>отправлен<\/strong> заказчику/);
});

test('без сводки письмо остаётся прежним (старые вызовы)', () => {
  const html = buildHelpdeskTextHtml([brokenCam('Camera 06')], runMeta, 'Группа A');
  assert.match(html, /выявила <strong>1<\/strong> проблему/);
  assert.doesNotMatch(html, /Проверено камер/);
});

// ── Тема письма ───────────────────────────────────────────────────────────────

test('тема: поломки', () => {
  assert.equal(
    helpdeskSubject({ groupName: 'Группа A', dateStr: '04.09.2026', brokenCount: 3 }),
    '[HELPDESK] Группа A — не работают камеры 04.09.2026 (3 шт.)');
});

test('тема: только замечания', () => {
  assert.equal(
    helpdeskSubject({ groupName: 'Группа A', dateStr: '04.09.2026', extrasCount: 2 }),
    '[HELPDESK] Группа A — обратите внимание на камеры 04.09.2026 (2 шт.)');
});

test('тема: тихое утро', () => {
  assert.equal(
    helpdeskSubject({ groupName: 'Группа A', dateStr: '04.09.2026' }),
    '[HELPDESK] Группа A — все камеры работают 04.09.2026');
});

test('тема кричит о несостоявшейся рассылке — в 1С видно без открытия письма', () => {
  const s = helpdeskSubject({
    groupName: 'Группа A', dateStr: '04.09.2026', brokenCount: 3,
    delivery: { sent: false },
  });
  assert.equal(s, '[HELPDESK] Группа A — не работают камеры 04.09.2026 (3 шт.) — отчёт заказчику НЕ отправлен');
});

test('успешная рассылка тему не засоряет', () => {
  const s = helpdeskSubject({ groupName: 'Группа A', dateStr: '04.09.2026', delivery: { sent: true } });
  assert.doesNotMatch(s, /НЕ отправлен/);
});
