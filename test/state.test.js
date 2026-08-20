// Тесты helpdesk-дедупликации (src/state.js) — чистая логика, без диска/сети.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraKey, diffAndUpdate } from '../src/state.js';

test('cameraKey: ключ вида systemId|camera', () => {
  assert.equal(cameraKey({ systemId: 'office', camera: 'CH11' }), 'office|CH11');
});

test('cameraKey: fallback на system, если нет systemId', () => {
  assert.equal(cameraKey({ system: 'Объект 2', camera: 'CH2' }), 'Объект 2|CH2');
});

test('diffAndUpdate: новая поломка → newlyBroken, state помечен broken', () => {
  const state = { lastRun: null, cameras: {} };
  const broken = [{ systemId: 'office', system: 'Объект 2', group: 'Группа A', camera: 'CH11', status: 'OFFLINE', notes: '' }];
  const r = diffAndUpdate(state, broken);
  assert.equal(r.newlyBroken.length, 1);
  assert.equal(r.stillBroken.length, 0);
  assert.equal(r.recovered.length, 0);
  assert.equal(state.cameras['office|CH11'].status, 'broken');
});

test('diffAndUpdate: та же поломка во втором прогоне → stillBroken, не newly', () => {
  const state = { lastRun: null, cameras: {} };
  const broken = [{ systemId: 'office', camera: 'CH11', status: 'OFFLINE', notes: '' }];
  diffAndUpdate(state, broken);            // прогон 1
  const r = diffAndUpdate(state, broken);  // прогон 2 — та же поломка
  assert.equal(r.newlyBroken.length, 0);
  assert.equal(r.stillBroken.length, 1);
});

test('diffAndUpdate: сменилась причина → снова newlyBroken (_statusChanged)', () => {
  const state = { lastRun: null, cameras: {} };
  diffAndUpdate(state, [{ systemId: 'office', camera: 'CH11', status: 'OFFLINE', notes: '' }]);
  const r = diffAndUpdate(state, [{ systemId: 'office', camera: 'CH11', status: 'НЕТ ЗАПИСИ', notes: '' }]);
  assert.equal(r.newlyBroken.length, 1);
  assert.equal(r.newlyBroken[0]._statusChanged, true);
});

test('diffAndUpdate: камера пропала из broken → recovered, state active', () => {
  const state = { lastRun: null, cameras: {} };
  diffAndUpdate(state, [{ systemId: 'office', camera: 'CH11', status: 'OFFLINE', notes: '' }]);
  const r = diffAndUpdate(state, []);      // больше не сломана
  assert.equal(r.recovered.length, 1);
  assert.equal(state.cameras['office|CH11'].status, 'active');
});
