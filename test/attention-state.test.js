import test from 'node:test';
import assert from 'node:assert/strict';
import { diffAttention } from '../src/attention-state.js';

const cam = (key, falls, downMin) => ({
  cam_key: key,
  system_id: key.split('|')[0],
  camera: key.split('|')[1],
  falls,
  downtime_min: downMin,
  days: 7,
});

const emptyState = () => ({ cameras: {}, updatedAt: null });
const daysAgo = (n) => new Date(Date.now() - n * 86400_000);

test('diffAttention: первая нестабильная камера уходит в заявку', () => {
  const state = emptyState();
  const { toNotify, skipped } = diffAttention(state, [cam('sys|Cam 1', 12, 300)]);
  assert.equal(toNotify.length, 1);
  assert.equal(skipped, 0);
  assert.ok(state.cameras['sys|Cam 1']);
  assert.equal(state.cameras['sys|Cam 1'].notifiedFalls, 12);
});

test('diffAttention: на следующий день о той же камере молчим', () => {
  const state = emptyState();
  diffAttention(state, [cam('sys|Cam 1', 12, 300)]);
  const second = diffAttention(state, [cam('sys|Cam 1', 13, 320)]);
  assert.equal(second.toNotify.length, 0);
  assert.equal(second.skipped, 1);
});

test('diffAttention: через ATTENTION_RENOTIFY_DAYS напоминаем повторно', () => {
  const state = emptyState();
  diffAttention(state, [cam('sys|Cam 1', 12, 300)], daysAgo(20));
  const again = diffAttention(state, [cam('sys|Cam 1', 13, 320)]);
  assert.equal(again.toNotify.length, 1);
  assert.equal(again.toNotify[0].repeat, true);
  assert.equal(again.toNotify[0].worse, false);
});

test('diffAttention: заметное ухудшение шлём досрочно', () => {
  const state = emptyState();
  diffAttention(state, [cam('sys|Cam 1', 10, 300)]);
  // 10 падений было, стало 15 — рост в полтора раза.
  const worse = diffAttention(state, [cam('sys|Cam 1', 15, 800)]);
  assert.equal(worse.toNotify.length, 1);
  assert.equal(worse.toNotify[0].worse, true);
  assert.equal(state.cameras['sys|Cam 1'].notifiedFalls, 15);
});

test('diffAttention: небольшой рост досрочной заявки не вызывает', () => {
  const state = emptyState();
  diffAttention(state, [cam('sys|Cam 1', 10, 300)]);
  const same = diffAttention(state, [cam('sys|Cam 1', 12, 340)]);
  assert.equal(same.toNotify.length, 0);
  assert.equal(same.skipped, 1);
});

test('diffAttention: камера ушла из списка — запись забывается по сроку', () => {
  const state = emptyState();
  diffAttention(state, [cam('sys|Cam 1', 12, 300)], daysAgo(10));
  const gone = diffAttention(state, []);
  assert.equal(gone.forgotten, 1);
  assert.equal(state.cameras['sys|Cam 1'], undefined);
});

test('diffAttention: недавно пропавшая камера ещё помнится', () => {
  const state = emptyState();
  diffAttention(state, [cam('sys|Cam 1', 12, 300)], daysAgo(2));
  const gone = diffAttention(state, []);
  assert.equal(gone.forgotten, 0);
  assert.ok(state.cameras['sys|Cam 1']);
});

test('diffAttention: вернувшаяся после забвения камера — снова заявка', () => {
  const state = emptyState();
  diffAttention(state, [cam('sys|Cam 1', 12, 300)], daysAgo(10));
  diffAttention(state, []);                       // забыли
  const back = diffAttention(state, [cam('sys|Cam 1', 11, 280)]);
  assert.equal(back.toNotify.length, 1);
  assert.equal(back.toNotify[0].repeat, undefined);
});

test('diffAttention: несколько камер обрабатываются независимо', () => {
  const state = emptyState();
  diffAttention(state, [cam('sys|Cam 1', 12, 300)]);
  const mixed = diffAttention(state, [cam('sys|Cam 1', 12, 300), cam('sys|Cam 2', 20, 900)]);
  assert.equal(mixed.toNotify.length, 1);
  assert.equal(mixed.toNotify[0].camera, 'Cam 2');
  assert.equal(mixed.skipped, 1);
});
