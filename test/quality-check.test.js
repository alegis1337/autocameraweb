import test from 'node:test';
import assert from 'node:assert/strict';
import { median, defectStreaks, diffQuality } from '../src/quality-check.js';

test('median: нечётное и чётное число значений', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('median: выброс не уводит норму', () => {
  // Ради этого и берётся медиана, а не среднее: один битый кадр не должен
  // переписать представление о том, какая у камеры обычная резкость.
  assert.equal(median([100, 105, 110, 5000]), 107.5);
});

test('median: пустой список и мусор', () => {
  assert.equal(median([]), null);
  assert.equal(median([null, undefined, NaN]), null);
});

const hist = (...defectLists) => defectLists.map((d) => ({ defects: d.join(',') }));

test('defectStreaks: дефект впервые — серия 1', () => {
  const s = defectStreaks(['blurry'], hist([], []));
  assert.equal(s.get('blurry'), 1);
});

test('defectStreaks: дефект держится три прогона подряд', () => {
  const s = defectStreaks(['blurry'], hist(['blurry'], ['blurry'], []));
  assert.equal(s.get('blurry'), 3);
});

test('defectStreaks: разрыв обрывает серию', () => {
  // Был, пропал, снова появился — это не устойчивый дефект, а мигание.
  const s = defectStreaks(['blurry'], hist([], ['blurry'], ['blurry']));
  assert.equal(s.get('blurry'), 1);
});

test('defectStreaks: серии считаются по каждому дефекту отдельно', () => {
  const s = defectStreaks(['dark', 'frozen'], hist(['dark'], ['dark', 'frozen']));
  assert.equal(s.get('dark'), 3);
  assert.equal(s.get('frozen'), 1);
});

test('defectStreaks: пустой список дефектов — пустой результат', () => {
  assert.equal(defectStreaks([], hist(['dark'])).size, 0);
});

const finding = (camKey, defects) => ({
  cam_key: camKey,
  system_id: camKey.split('|')[0],
  system: 'Объект',
  camera: camKey.split('|')[1],
  defects,
  defectsText: defects.join(', '),
  streak: 3,
});

const emptyState = () => ({ cameras: {}, updatedAt: null });
const daysAgo = (n) => new Date(Date.now() - n * 86400_000);

test('diffQuality: новый дефект уходит в заявку', () => {
  const state = emptyState();
  const r = diffQuality(state, [finding('sys|Cam 1', ['blurry'])]);
  assert.equal(r.toNotify.length, 1);
  assert.ok(state.cameras['sys|Cam 1']);
});

test('diffQuality: назавтра о том же дефекте молчим', () => {
  const state = emptyState();
  diffQuality(state, [finding('sys|Cam 1', ['blurry'])]);
  const second = diffQuality(state, [finding('sys|Cam 1', ['blurry'])]);
  assert.equal(second.toNotify.length, 0);
  assert.equal(second.skipped, 1);
});

test('diffQuality: изменился набор дефектов — заявка повторно', () => {
  const state = emptyState();
  diffQuality(state, [finding('sys|Cam 1', ['blurry'])]);
  const changed = diffQuality(state, [finding('sys|Cam 1', ['blurry', 'dark'])]);
  assert.equal(changed.toNotify.length, 1);
  assert.equal(changed.toNotify[0].changed, true);
});

test('diffQuality: порядок дефектов не считается изменением', () => {
  const state = emptyState();
  diffQuality(state, [finding('sys|Cam 1', ['blurry', 'dark'])]);
  const same = diffQuality(state, [finding('sys|Cam 1', ['dark', 'blurry'])]);
  assert.equal(same.toNotify.length, 0);
});

test('diffQuality: через QUALITY_RENOTIFY_DAYS напоминаем', () => {
  const state = emptyState();
  diffQuality(state, [finding('sys|Cam 1', ['blurry'])], daysAgo(20));
  const again = diffQuality(state, [finding('sys|Cam 1', ['blurry'])]);
  assert.equal(again.toNotify.length, 1);
  assert.equal(again.toNotify[0].repeat, true);
  assert.equal(again.toNotify[0].changed, false);
});

test('diffQuality: дефект исчез — запись забывается сразу', () => {
  // В отличие от нестабильности, тут выдержки нет: качество вернулось,
  // а если испортится снова — оператору нужна новая заявка, а не молчание.
  const state = emptyState();
  diffQuality(state, [finding('sys|Cam 1', ['blurry'])]);
  const cleared = diffQuality(state, []);
  assert.equal(cleared.cleared, 1);
  assert.equal(state.cameras['sys|Cam 1'], undefined);
});

test('diffQuality: вернувшийся дефект даёт новую заявку', () => {
  const state = emptyState();
  diffQuality(state, [finding('sys|Cam 1', ['blurry'])]);
  diffQuality(state, []);
  const back = diffQuality(state, [finding('sys|Cam 1', ['blurry'])]);
  assert.equal(back.toNotify.length, 1);
  assert.equal(back.toNotify[0].repeat, undefined);
});
