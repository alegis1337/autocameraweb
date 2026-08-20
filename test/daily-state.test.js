// Тесты «тумблера» рассылки (src/daily-state.js) — чистая логика, без сети.
// Мутаторы (markSent/markFailed/recordOutbox/pendingGroups) работают над
// переданным объектом состояния, диск не трогают.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  todayMskDate, mskMinutes, recordOutbox, markSent, markFailed,
  pendingGroups, isGroupSent,
} from '../src/daily-state.js';

test('todayMskDate: UTC 11:00 → 14:00 МСК тех же суток', () => {
  assert.equal(todayMskDate(new Date('2026-06-15T11:00:00Z')), '2026-06-15');
});

test('todayMskDate: поздний вечер UTC → уже следующие сутки МСК', () => {
  // 22:30 UTC 15-го = 01:30 МСК 16-го
  assert.equal(todayMskDate(new Date('2026-06-15T22:30:00Z')), '2026-06-16');
});

test('mskMinutes: 11:00 UTC = 14:00 МСК = 840 минут', () => {
  assert.equal(mskMinutes(new Date('2026-06-15T11:00:00Z')), 840);
});

function freshState() {
  return {
    date: '2026-06-15', lastAttemptAt: null,
    groups: {
      'Группа A': { status: 'pending', attempts: 0 },
      'Группа B':    { status: 'pending', attempts: 0 },
    },
  };
}

test('markSent: группа становится sent, растёт attempts, ставится lastAttemptAt', () => {
  const s = freshState();
  markSent(s, 'Группа A', 'a@b.ru');
  assert.equal(s.groups['Группа A'].status, 'sent');
  assert.equal(s.groups['Группа A'].attempts, 1);
  assert.equal(s.groups['Группа A'].to, 'a@b.ru');
  assert.ok(s.lastAttemptAt, 'lastAttemptAt проставлен');
});

test('pendingGroups: возвращает только не-sent', () => {
  const s = freshState();
  markSent(s, 'Группа A', 'a@b.ru');
  assert.deepEqual(pendingGroups(s), ['Группа B']);
});

test('markFailed: статус failed, но группа остаётся в pending (не sent)', () => {
  const s = freshState();
  markFailed(s, 'Группа B', { error: 'SMTP timeout' });
  assert.equal(s.groups['Группа B'].status, 'failed');
  assert.equal(s.groups['Группа B'].lastError, 'SMTP timeout');
  assert.ok(pendingGroups(s).includes('Группа B'));
});

test('recordOutbox: сохраняет путь к отчёту, статус не сбивает с sent', () => {
  const s = freshState();
  markSent(s, 'Группа A', 'a@b.ru');
  recordOutbox(s, 'Группа A', { to: 'a@b.ru', reportPath: '/r/e.html', cidList: [] });
  // Уже отправленную группу recordOutbox не возвращает в pending
  assert.equal(s.groups['Группа A'].status, 'sent');
  recordOutbox(s, 'Группа B', { to: 'c@d.ru', reportPath: '/r/o.html', cidList: [{ cid: 'x', path: '/p' }] });
  assert.equal(s.groups['Группа B'].status, 'pending');
  assert.equal(s.groups['Группа B'].reportPath, '/r/o.html');
});

test('isGroupSent: точное определение отправленной группы', () => {
  const s = freshState();
  assert.equal(isGroupSent(s, 'Группа A'), false);
  markSent(s, 'Группа A', 'a@b.ru');
  assert.equal(isGroupSent(s, 'Группа A'), true);
  assert.equal(isGroupSent(s, 'Группа B'), false);
});
