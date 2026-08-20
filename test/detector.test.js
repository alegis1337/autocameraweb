import test from 'node:test';
import assert from 'node:assert/strict';
import { collectUnstable, detectSystemOutages } from '../src/detector.js';

const FROM = '2026-08-01T00:00:00.000Z';
const TO = '2026-08-02T00:00:00.000Z';   // сутки = 86400 сек

const ev = (ts, camKey, kind, extra = {}) => ({
  ts,
  cam_key: camKey,
  system_id: camKey.split('|')[0],
  camera: camKey.split('|')[1],
  kind,
  prev_kind: null,
  downtime_sec: null,
  ...extra,
});

test('collectUnstable: камера ниже обоих порогов не попадает в выдачу', () => {
  const events = [
    ev('2026-08-01T10:00:00.000Z', 'sys|Cam 1', 'offline'),
    ev('2026-08-01T10:20:00.000Z', 'sys|Cam 1', 'online', { downtime_sec: 1200 }),
  ];
  const out = collectUnstable(events, { fromIso: FROM, toIso: TO, minDowntimeSec: 3600, minFalls: 5 });
  assert.equal(out.length, 0);
});

test('collectUnstable: превышен порог по простою', () => {
  const events = [
    ev('2026-08-01T02:00:00.000Z', 'sys|Cam 1', 'offline'),
    ev('2026-08-01T05:00:00.000Z', 'sys|Cam 1', 'online', { downtime_sec: 10800 }),
  ];
  const out = collectUnstable(events, { fromIso: FROM, toIso: TO, minDowntimeSec: 3600, minFalls: 5 });
  assert.equal(out.length, 1);
  assert.equal(out[0].downtime_sec, 10800);
  assert.equal(out[0].falls, 1);
  assert.equal(out[0].share_pct, 13);   // 10800 / 86400 = 12.5% → 13
});

test('collectUnstable: превышен порог по числу падений при малом простое', () => {
  const events = [];
  for (let i = 0; i < 6; i++) {
    events.push(ev(`2026-08-01T0${i}:00:00.000Z`, 'sys|Cam 2', 'offline'));
    events.push(ev(`2026-08-01T0${i}:05:00.000Z`, 'sys|Cam 2', 'online', { downtime_sec: 300 }));
  }
  const out = collectUnstable(events, { fromIso: FROM, toIso: TO, minDowntimeSec: 3600, minFalls: 5 });
  assert.equal(out.length, 1);
  assert.equal(out[0].falls, 6);
  assert.equal(out[0].downtime_sec, 1800);
});

test('collectUnstable: переход offline → no-recording не считается новым падением', () => {
  const events = [
    ev('2026-08-01T01:00:00.000Z', 'sys|Cam 3', 'offline'),
    ev('2026-08-01T01:30:00.000Z', 'sys|Cam 3', 'no-recording', { prev_kind: 'offline' }),
    ev('2026-08-01T02:00:00.000Z', 'sys|Cam 3', 'online', { downtime_sec: 3600 }),
  ];
  const out = collectUnstable(events, { fromIso: FROM, toIso: TO, minDowntimeSec: 3600, minFalls: 5 });
  assert.equal(out[0].falls, 1);
});

test('collectUnstable: простой, начавшийся до периода, засчитывается только хвостом', () => {
  // Падение шло 10 часов, но период начался за 1 час до восстановления.
  const events = [
    ev('2026-08-01T01:00:00.000Z', 'sys|Cam 4', 'online', { downtime_sec: 36000 }),
  ];
  const out = collectUnstable(events, { fromIso: FROM, toIso: TO, minDowntimeSec: 1, minFalls: 99 });
  assert.equal(out[0].downtime_sec, 3600);
});

test('collectUnstable: камеры из skipCamKeys исключаются (они уже в блоке «не работают»)', () => {
  const events = [
    ev('2026-08-01T02:00:00.000Z', 'sys|Cam 5', 'offline'),
    ev('2026-08-01T08:00:00.000Z', 'sys|Cam 5', 'online', { downtime_sec: 21600 }),
  ];
  const out = collectUnstable(events, {
    fromIso: FROM, toIso: TO,
    skipCamKeys: new Set(['sys|Cam 5']),
    minDowntimeSec: 3600, minFalls: 5,
  });
  assert.equal(out.length, 0);
});

test('collectUnstable: сортировка по простою, затем по числу падений', () => {
  const events = [
    ev('2026-08-01T01:00:00.000Z', 'sys|Малый', 'offline'),
    ev('2026-08-01T03:00:00.000Z', 'sys|Малый', 'online', { downtime_sec: 7200 }),
    ev('2026-08-01T01:00:00.000Z', 'sys|Большой', 'offline'),
    ev('2026-08-01T09:00:00.000Z', 'sys|Большой', 'online', { downtime_sec: 28800 }),
  ];
  const out = collectUnstable(events, { fromIso: FROM, toIso: TO, minDowntimeSec: 3600, minFalls: 5 });
  assert.deepEqual(out.map((o) => o.camera), ['Большой', 'Малый']);
});

test('detectSystemOutages: объект целиком считается упавшим при массовой поломке', () => {
  const cams = [
    { cam_key: 'a|1', system_id: 'a', status: 'offline' },
    { cam_key: 'a|2', system_id: 'a', status: 'offline' },
    { cam_key: 'a|3', system_id: 'a', status: 'offline' },
    { cam_key: 'a|4', system_id: 'a', status: 'offline' },
    { cam_key: 'a|5', system_id: 'a', status: 'online' },
  ];
  const { downSystems } = detectSystemOutages(cams, { ratio: 0.8, minCameras: 3 });
  assert.ok(downSystems.has('a'));
});

test('detectSystemOutages: одиночная поломка объект не роняет', () => {
  const cams = [
    { cam_key: 'b|1', system_id: 'b', status: 'offline' },
    { cam_key: 'b|2', system_id: 'b', status: 'online' },
    { cam_key: 'b|3', system_id: 'b', status: 'online' },
    { cam_key: 'b|4', system_id: 'b', status: 'online' },
  ];
  const { downSystems } = detectSystemOutages(cams, { ratio: 0.8, minCameras: 3 });
  assert.equal(downSystems.size, 0);
});

test('detectSystemOutages: объект из двух сломанных камер не «падает целиком»', () => {
  // minCameras=3 защищает от того, чтобы маленький объект давал ложный сбой.
  const cams = [
    { cam_key: 'c|1', system_id: 'c', status: 'offline' },
    { cam_key: 'c|2', system_id: 'c', status: 'offline' },
  ];
  const { downSystems } = detectSystemOutages(cams, { ratio: 0.8, minCameras: 3 });
  assert.equal(downSystems.size, 0);
});

test('detectSystemOutages: камеры без данных в расчёт доли не идут', () => {
  const cams = [
    { cam_key: 'd|1', system_id: 'd', status: 'unknown' },
    { cam_key: 'd|2', system_id: 'd', status: 'unknown' },
    { cam_key: 'd|3', system_id: 'd', status: 'unknown' },
  ];
  const { downSystems, bySystem } = detectSystemOutages(cams);
  assert.equal(downSystems.size, 0);
  assert.equal(bySystem.get('d').total, 0);
});

