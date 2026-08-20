import test from 'node:test';
import assert from 'node:assert/strict';
import { pickReminders, markNotified, diffAndUpdate } from '../src/state.js';

// 17.08.2026: по «Группе A» не пришло ничего, хотя Объект 1 лежало
// целиком вторые сутки — письмо уходило только на НОВУЮ поломку. Эти тесты
// закрывают именно тот сценарий.

const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString();

const still = (systemId, camera, notifiedAt) => ({
  systemId, system: systemId, group: 'Группа A', camera, status: 'OFFLINE',
  _brokenSince: daysAgo(10), _notifiedAt: notifiedAt,
});

test('объект, лежащий целиком, напоминает о себе каждый прогон', () => {
  const rows = [still('site-1', '201', daysAgo(0)), still('site-1', '202', daysAgo(0))];
  const due = pickReminders(rows, { downSystems: new Set(['site-1']), renotifyDays: 3 });
  assert.equal(due.length, 2);
  assert.ok(due.every(r => r._reminder === 'outage'));
});

test('отдельная камера молчит до истечения срока', () => {
  const rows = [still('site-3', 'Camera 16', daysAgo(1))];
  assert.equal(pickReminders(rows, { renotifyDays: 3 }).length, 0);
});

test('отдельная камера напоминает о себе, когда срок вышел', () => {
  const rows = [still('site-3', 'Camera 16', daysAgo(4))];
  const due = pickReminders(rows, { renotifyDays: 3 });
  assert.equal(due.length, 1);
  assert.equal(due[0]._reminder, 'renotify');
  assert.equal(due[0]._daysSilent, 4);
});

test('камера без отметки о письме напоминает сразу (старый state)', () => {
  const rows = [{ systemId: 'x', camera: 'CH1', group: 'Группа A', status: 'OFFLINE' }];
  assert.equal(pickReminders(rows, { renotifyDays: 3 }).length, 1);
});

test('markNotified сдвигает срок молчания', () => {
  const state = { lastRun: null, cameras: {} };
  const broken = [{ systemId: 'site-3', system: 'Объект 3', group: 'Группа A',
    camera: 'Camera 16', status: 'OFFLINE', notes: '' }];

  // Первый прогон: поломка новая.
  const d1 = diffAndUpdate(state, broken);
  assert.equal(d1.newlyBroken.length, 1);

  // Про неё написали сегодня — напоминания быть не должно...
  markNotified(state, broken);
  const d2 = diffAndUpdate(state, broken);
  assert.equal(pickReminders(d2.stillBroken, { renotifyDays: 3 }).length, 0);

  // ...а через четыре дня — должно.
  state.cameras['site-3|Camera 16'].notifiedAt = daysAgo(4);
  const d3 = diffAndUpdate(state, broken);
  assert.equal(pickReminders(d3.stillBroken, { renotifyDays: 3 }).length, 1);
});

test('восстановленная камера в напоминания не попадает', () => {
  const state = { lastRun: null, cameras: {} };
  const broken = [{ systemId: 'x', system: 'X', group: 'Группа A', camera: 'CH1', status: 'OFFLINE' }];
  diffAndUpdate(state, broken);
  const d = diffAndUpdate(state, []);            // камера поднялась
  assert.equal(d.recovered.length, 1);
  assert.equal(pickReminders(d.stillBroken, { renotifyDays: 0 }).length, 0);
});
