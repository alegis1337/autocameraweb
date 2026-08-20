import test from 'node:test';
import assert from 'node:assert/strict';
import { mapApiToConfig } from '../src/rostelecom-check.js';

// Сопоставление камер портала РТ с конфигом — место, где ошибка не падает, а
// тихо сдвигает статусы: оператор получает заявку не на ту камеру. Раньше
// маппили по порядку выдачи API, теперь по uid; тесты держат обе ветки.

const api = (name, uid, status = 'ok') => ({ name, uid, id: name, status });
const cfg = (index, name, rtUid) => (rtUid ? { index, name, rtUid } : { index, name });

test('маппинг по uid не зависит от порядка выдачи портала', () => {
  const apiCams = [api('B', 'uid-b', 'offline'), api('A', 'uid-a'), api('C', 'uid-c')];
  const configCameras = [cfg(0, 'Первая', 'uid-a'), cfg(1, 'Вторая', 'uid-b'), cfg(2, 'Третья', 'uid-c')];

  const out = mapApiToConfig(apiCams, configCameras);

  assert.equal(out[0].name, 'Первая');
  assert.equal(out[0].online, true);            // uid-a → ok
  assert.equal(out[1].name, 'Вторая');
  assert.equal(out[1].online, false);           // uid-b → offline
  assert.equal(out[2].online, true);
});

test('камера с uid, пропавшая с портала, даёт «нет данных», а не чужой статус', () => {
  // До перехода на uid статус здесь уехал бы от следующей камеры по порядку.
  const apiCams = [api('A', 'uid-a'), api('C', 'uid-c')];
  const configCameras = [cfg(0, 'Первая', 'uid-a'), cfg(1, 'Вторая', 'uid-b'), cfg(2, 'Третья', 'uid-c')];

  const out = mapApiToConfig(apiCams, configCameras);

  assert.equal(out[1].online, null);
  assert.match(out[1].notes, /uid-b/);
  assert.equal(out[2].online, true);            // третья не съехала на место второй
});

test('новая камера на портале не ломает сопоставление остальных', () => {
  const apiCams = [api('НОВАЯ', 'uid-new'), api('A', 'uid-a'), api('B', 'uid-b', 'offline')];
  const configCameras = [cfg(0, 'Первая', 'uid-a'), cfg(1, 'Вторая', 'uid-b')];

  const out = mapApiToConfig(apiCams, configCameras);

  assert.equal(out.length, 2);
  assert.equal(out[0].online, true);
  assert.equal(out[1].online, false);
});

test('без rtUid работает старое сопоставление по порядку', () => {
  const apiCams = [api('A', 'uid-a'), api('B', 'uid-b', 'offline')];
  const configCameras = [cfg(0, 'Первая'), cfg(1, 'Вторая')];

  const out = mapApiToConfig(apiCams, configCameras);

  assert.equal(out[0].online, true);
  assert.equal(out[1].online, false);
});

test('excludeApiNames убирает камеру до сопоставления', () => {
  const apiCams = [api('979316, 27.05.26', 'uid-skip', 'offline'), api('A', 'uid-a')];
  const configCameras = [cfg(0, 'Первая')];

  const out = mapApiToConfig(apiCams, configCameras, ['979316']);

  assert.equal(out.length, 1);
  assert.equal(out[0].online, true);            // взята A, а не исключённая
});

test('неразвёрнутый ${...} за uid не принимается — откат на порядок', () => {
  // Забыли переменную в .env: config-loader оставляет плейсхолдер как есть.
  // Без обработки все камеры ушли бы в «нет данных» из-за одной строки.
  const apiCams = [api('A', 'uid-a'), api('B', 'uid-b', 'offline')];
  const configCameras = [
    { index: 0, name: 'Первая', rtUid: '${CAM_ONE_UID}' },
    { index: 1, name: 'Вторая', rtUid: '${CAM_TWO_UID}' },
  ];

  const out = mapApiToConfig(apiCams, configCameras);

  assert.equal(out[0].online, true);
  assert.equal(out[1].online, false);
});

test('uid прокидывается в результат — по нему снапшоттер достаёт кадр', () => {
  const out = mapApiToConfig([api('A', 'uid-a')], [cfg(0, 'Первая', 'uid-a')]);
  assert.equal(out[0].uid, 'uid-a');
});
