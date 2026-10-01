// Тесты helpdesk-дедупликации (src/state.js) — чистая логика, без диска/сети.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraKey, diffAndUpdate, CHECK_ERROR_STATUS } from '../src/state.js';

test('cameraKey: ключ вида systemId|camera', () => {
  assert.equal(cameraKey({ systemId: 'site-2', camera: 'CH11' }), 'site-2|CH11');
});

test('cameraKey: fallback на system, если нет systemId', () => {
  assert.equal(cameraKey({ system: 'Объект 2', camera: 'CH2' }), 'Объект 2|CH2');
});

test('diffAndUpdate: новая поломка → newlyBroken, state помечен broken', () => {
  const state = { lastRun: null, cameras: {} };
  const broken = [{ systemId: 'site-2', system: 'Объект 2', group: 'Группа A', camera: 'CH11', status: 'OFFLINE', notes: '' }];
  const r = diffAndUpdate(state, broken);
  assert.equal(r.newlyBroken.length, 1);
  assert.equal(r.stillBroken.length, 0);
  assert.equal(r.recovered.length, 0);
  assert.equal(state.cameras['site-2|CH11'].status, 'broken');
});

test('diffAndUpdate: та же поломка во втором прогоне → stillBroken, не newly', () => {
  const state = { lastRun: null, cameras: {} };
  const broken = [{ systemId: 'site-2', camera: 'CH11', status: 'OFFLINE', notes: '' }];
  diffAndUpdate(state, broken);            // прогон 1
  const r = diffAndUpdate(state, broken);  // прогон 2 — та же поломка
  assert.equal(r.newlyBroken.length, 0);
  assert.equal(r.stillBroken.length, 1);
});

test('diffAndUpdate: сменилась причина → снова newlyBroken (_statusChanged)', () => {
  const state = { lastRun: null, cameras: {} };
  diffAndUpdate(state, [{ systemId: 'site-2', camera: 'CH11', status: 'OFFLINE', notes: '' }]);
  const r = diffAndUpdate(state, [{ systemId: 'site-2', camera: 'CH11', status: 'НЕТ ЗАПИСИ', notes: '' }]);
  assert.equal(r.newlyBroken.length, 1);
  assert.equal(r.newlyBroken[0]._statusChanged, true);
});

test('diffAndUpdate: камера пропала из broken → recovered, state active', () => {
  const state = { lastRun: null, cameras: {} };
  diffAndUpdate(state, [{ systemId: 'site-2', camera: 'CH11', status: 'OFFLINE', notes: '' }]);
  const r = diffAndUpdate(state, []);      // больше не сломана
  assert.equal(r.recovered.length, 1);
  assert.equal(state.cameras['site-2|CH11'].status, 'active');
});

test('diffAndUpdate: упавший опрос объекта не «восстанавливает» его камеры', () => {
  // Регрессия 17–18.09.2026: NVR не ответил, вместо камер пришла одна запись
  // «(вся система) — ошибка проверки», и камера, лежавшая неделю, ушла в
  // recovered; назавтра она вернулась как новая — «не работает с 18.09».
  const state = { lastRun: null, cameras: {} };
  diffAndUpdate(state, [{ systemId: 'site-3', camera: 'Camera 15', status: 'OFFLINE', notes: 'NO VIDEO' }]);
  const since = state.cameras['site-3|Camera 15'].since;

  const failed = [{ systemId: 'site-3', system: 'Объект 3', camera: '(вся система)', status: CHECK_ERROR_STATUS, notes: 'fetch failed' }];
  const r = diffAndUpdate(state, failed);
  assert.equal(r.recovered.length, 0);
  assert.equal(r.unchecked.length, 1);
  assert.equal(r.unchecked[0].camera, 'Camera 15');
  assert.equal(r.newlyBroken.length, 1);              // сама запись об ошибке — новая
  assert.equal(state.cameras['site-3|Camera 15'].status, 'broken');
  assert.equal(state.cameras['site-3|Camera 15'].since, since);

  // Опрос вернулся — камера по-прежнему лежит, и дата поломки прежняя.
  const r2 = diffAndUpdate(state, [{ systemId: 'site-3', camera: 'Camera 15', status: 'OFFLINE', notes: 'NO VIDEO' }]);
  assert.equal(r2.newlyBroken.length, 0);
  assert.equal(r2.stillBroken.length, 1);
  assert.equal(r2.stillBroken[0]._brokenSince, since);
  assert.equal(r2.recovered.length, 1);               // а запись «(вся система)» закрылась
  assert.equal(r2.recovered[0].camera, '(вся система)');
});

test('diffAndUpdate: ошибка опроса одного объекта не мешает восстановлению на другом', () => {
  const state = { lastRun: null, cameras: {} };
  diffAndUpdate(state, [
    { systemId: 'site-3',  camera: 'Camera 15', status: 'OFFLINE', notes: '' },
    { systemId: 'site-2', camera: 'CH11',      status: 'OFFLINE', notes: '' },
  ]);
  const r = diffAndUpdate(state, [
    { systemId: 'site-3', camera: '(вся система)', status: CHECK_ERROR_STATUS, notes: 'fetch failed' },
  ]);
  assert.deepEqual(r.recovered.map((c) => c.camera), ['CH11']);
  assert.deepEqual(r.unchecked.map((c) => c.camera), ['Camera 15']);
});
