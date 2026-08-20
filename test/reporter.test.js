// Тесты логики «серых» камер (src/reporter.js → isUnusedChannel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnusedChannel } from '../src/reporter.js';

test('isUnusedChannel: нет sys или cam → false', () => {
  assert.equal(isUnusedChannel(null, {}), false);
  assert.equal(isUnusedChannel({}, null), false);
});

test('isUnusedChannel: TRASSIR — по имени из knownOffline', () => {
  const sys = { type: 'trassir-sdk', knownOffline: ['210', '215'] };
  assert.equal(isUnusedChannel(sys, { name: '215' }), true);
  assert.equal(isUnusedChannel(sys, { name: '204' }), false);
});

test('isUnusedChannel: TRASSIR с пустым knownOffline → false', () => {
  assert.equal(isUnusedChannel({ type: 'trassir-sdk', knownOffline: [] }, { name: '215' }), false);
});

test('isUnusedChannel: прочие системы — по unusedChannels (1-based от index)', () => {
  const sys = { type: 'hikvision-isapi', unusedChannels: [1, 2, 3, 4, 5] };
  assert.equal(isUnusedChannel(sys, { index: 0 }), true);  // ch = 0 + 1 = 1
  assert.equal(isUnusedChannel(sys, { index: 4 }), true);  // ch = 5
  assert.equal(isUnusedChannel(sys, { index: 5 }), false); // ch = 6
});

test('isUnusedChannel: cam.id имеет приоритет над index', () => {
  const sys = { unusedChannels: [2] };
  assert.equal(isUnusedChannel(sys, { id: 2, index: 99 }), true);
});
