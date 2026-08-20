import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMetrics, buildSignature, signatureSimilarity, signatureCorrelation,
  classifyDefects, describeDefects, frameHash, W, H,
} from '../src/image-quality.js';

// Пороги задаём явно, чтобы тесты не зависели от .env машины.
const T = {
  darkMean: 25, darkRatio: 0.9,
  brightMean: 230, brightRatio: 0.6,
  blurAbs: 100, blurRel: 0.4, noiseRel: 2,
  angleCorr: 0.5, minStreak: 3,
};

/** Ровный кадр одной яркости. */
const flat = (v) => Buffer.alloc(W * H, v);

/** Шахматка с заданным шагом — даёт сильные градиенты, то есть высокую резкость. */
function checker(step, lo = 40, hi = 200) {
  const b = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      b[y * W + x] = (Math.floor(x / step) + Math.floor(y / step)) % 2 ? hi : lo;
    }
  }
  return b;
}

test('computeMetrics: ровный кадр — нулевой контраст и нулевая резкость', () => {
  const m = computeMetrics(flat(128));
  assert.equal(m.mean, 128);
  assert.equal(m.std, 0);
  assert.equal(m.sharpness, 0);
  assert.equal(m.darkRatio, 0);
  assert.equal(m.brightRatio, 0);
});

test('computeMetrics: чёрный кадр даёт долю тёмных пикселей 1', () => {
  const m = computeMetrics(flat(5));
  assert.equal(m.darkRatio, 1);
  assert.equal(m.mean, 5);
});

test('computeMetrics: мелкая шахматка резче крупной', () => {
  const fine = computeMetrics(checker(2));
  const coarse = computeMetrics(checker(16));
  assert.ok(fine.sharpness > coarse.sharpness,
    `мелкая ${fine.sharpness} должна быть резче крупной ${coarse.sharpness}`);
});

test('classifyDefects: нормальный кадр — дефектов нет', () => {
  const m = computeMetrics(checker(8));
  assert.deepEqual(classifyDefects(m, { thresholds: T }), []);
});

test('classifyDefects: чёрный кадр — только «тёмный», без «расфокусировки»', () => {
  // В чёрном кадре нет градиентов, поэтому он выглядит и размытым.
  // Причина одна — называть её надо одним словом.
  const d = classifyDefects(computeMetrics(flat(5)), { thresholds: T });
  assert.deepEqual(d, ['dark']);
});

test('classifyDefects: засветка — только «засветка»', () => {
  const d = classifyDefects(computeMetrics(flat(250)), { thresholds: T });
  assert.deepEqual(d, ['overexposed']);
});

test('classifyDefects: тёмный кадр ловится и по доле чёрного при яркой лампе', () => {
  // Сумерки в цехе: 90,5% кадра почти чёрные (яркость 20 — ниже порога «тёмного»
  // пикселя), но яркая лампа на 9,5% площади поднимает СРЕДНЮЮ яркость до 42,
  // то есть выше порога darkMean. Правило по средней тут молчит — сработать
  // должно правило по доле чёрного.
  const b = Buffer.alloc(W * H, 20);
  for (let i = 0; i < Math.floor(W * H * 0.095); i++) b[i] = 255;
  const m = computeMetrics(b);
  assert.ok(m.mean > T.darkMean, `средняя яркость ${m.mean} должна быть выше порога ${T.darkMean}`);
  assert.ok(m.darkRatio > T.darkRatio, `доля тёмных ${m.darkRatio} должна быть выше ${T.darkRatio}`);
  assert.ok(classifyDefects(m, { thresholds: T }).includes('dark'));
});

test('classifyDefects: размытие ловится абсолютным порогом без истории', () => {
  // Крупная шахматка с малым перепадом — слабые градиенты.
  const m = computeMetrics(checker(32, 120, 130));
  assert.ok(m.sharpness < T.blurAbs, `резкость ${m.sharpness} должна быть ниже порога`);
  assert.ok(classifyDefects(m, { thresholds: T }).includes('blurry'));
});

test('classifyDefects: падение резкости относительно нормы камеры', () => {
  const m = computeMetrics(checker(16, 100, 160));
  // Сама по себе резкость выше абсолютного порога — дефекта нет.
  assert.deepEqual(classifyDefects(m, { thresholds: T }), []);
  // Но если у камеры норма впятеро выше — это ухудшение.
  const d = classifyDefects(m, { thresholds: T, baselineSharpness: m.sharpness * 5 });
  assert.deepEqual(d, ['blurry']);
});

test('classifyDefects: резкость много выше нормы — шум', () => {
  const m = computeMetrics(checker(2));
  const d = classifyDefects(m, { thresholds: T, baselineSharpness: m.sharpness / 3 });
  assert.deepEqual(d, ['noisy']);
});

test('classifyDefects: шум и размытие одновременно не выставляются', () => {
  const m = computeMetrics(checker(8));
  const d = classifyDefects(m, { thresholds: T, baselineSharpness: m.sharpness * 5 });
  assert.ok(d.includes('blurry'));
  assert.ok(!d.includes('noisy'));
});

test('signatureSimilarity: одинаковые подписи дают 1', () => {
  const s = buildSignature(checker(8));
  assert.equal(signatureSimilarity(s, s), 1);
});

test('frameHash: одинаковые кадры дают одинаковый отпечаток, разные — разный', () => {
  assert.equal(frameHash(checker(8)), frameHash(checker(8)));
  assert.notEqual(frameHash(checker(8)), frameHash(checker(4)));
});

test('classifyDefects: точное совпадение с прошлым кадром — «зависло»', () => {
  const m = computeMetrics(checker(8));
  const d = classifyDefects(m, { thresholds: T, prevHash: m.frameHash });
  assert.deepEqual(d, ['frozen']);
});

test('classifyDefects: другая сцена «зависанием» не считается', () => {
  const m = computeMetrics(checker(8));
  const other = computeMetrics(checker(4, 10, 250));
  const d = classifyDefects(m, { thresholds: T, prevHash: other.frameHash });
  assert.ok(!d.includes('frozen'));
});

test('classifyDefects: почти такой же кадр «зависанием» не считается', () => {
  // Ключевой случай: статичная ночная сцена, кадр отличается на единицу
  // яркости в одном пикселе. Порог похожести дал бы тут ложную заявку —
  // именно поэтому «зависло» проверяется точным совпадением.
  const base = checker(8);
  const almost = Buffer.from(base);
  almost[0] = almost[0] + 1;
  const m = computeMetrics(almost);
  const d = classifyDefects(m, { thresholds: T, prevHash: frameHash(base) });
  assert.ok(!d.includes('frozen'));
});

test('signatureCorrelation: изменение яркости структуру не меняет', () => {
  // Та же сцена, но темнее на 30 единиц — так выглядит вечер против дня.
  const base = checker(8, 60, 200);
  const dim = Buffer.from(base.map((v) => Math.max(0, v - 30)));
  const corr = signatureCorrelation(buildSignature(base), buildSignature(dim));
  assert.ok(corr > 0.95, `корреляция ${corr} должна остаться высокой`);
});

test('classifyDefects: смена ракурса по низкой корреляции с эталоном', () => {
  const m = computeMetrics(checker(8));
  // Другая структура: вертикальные полосы вместо шахматки.
  const stripes = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) stripes[y * W + x] = x < W / 2 ? 40 : 200;
  }
  const d = classifyDefects(m, { thresholds: T, baseSignature: buildSignature(stripes) });
  assert.ok(d.includes('angle-changed'));
});

test('classifyDefects: та же сцена при другом свете ракурсом не считается', () => {
  const base = checker(8, 60, 200);
  const dim = Buffer.from(base.map((v) => Math.max(0, v - 30)));
  const m = computeMetrics(dim);
  const d = classifyDefects(m, { thresholds: T, baseSignature: buildSignature(base) });
  assert.ok(!d.includes('angle-changed'));
});

// ─── Окно эталонов (18.08.2026) ──────────────────────────────────────────────
// Раньше эталон был один, и сцена с двумя законными состояниями (свет
// включили/выключили) каждый раз давала «изменился ракурс».

test('classifyDefects: совпадение хоть с одним эталоном — не ракурс', () => {
  const scene = checker(8, 60, 200);
  const other = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) other[y * W + x] = x < W / 2 ? 40 : 200;

  const m = computeMetrics(scene);
  // В окне и «другое состояние сцены», и свой же кадр — второй спасает.
  const d = classifyDefects(m, {
    thresholds: T,
    baseSignatures: [buildSignature(other), buildSignature(other), buildSignature(scene)],
  });
  assert.ok(!d.includes('angle-changed'));
});

test('classifyDefects: расхождение со ВСЕМ окном — настоящий разворот', () => {
  const stripes = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) stripes[y * W + x] = x < W / 2 ? 40 : 200;
  const m = computeMetrics(checker(8));
  const d = classifyDefects(m, {
    thresholds: T,
    baseSignatures: [buildSignature(stripes), buildSignature(stripes), buildSignature(stripes)],
  });
  assert.ok(d.includes('angle-changed'));
});

test('classifyDefects: без эталонов ракурс не проверяется', () => {
  const d = classifyDefects(computeMetrics(checker(8)), { thresholds: T, baseSignatures: [] });
  assert.ok(!d.includes('angle-changed'));
});

test('describeDefects: коды переводятся на русский', () => {
  assert.equal(describeDefects(['dark', 'frozen']), 'тёмный кадр, изображение зависло');
  assert.equal(describeDefects([]), '');
});
