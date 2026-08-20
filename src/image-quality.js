/**
 * image-quality.js — контроль качества изображения (v3, пункт 2 ТЗ).
 *
 * Задача из ТЗ: «камера может числиться исправной и при этом не давать
 * пригодного изображения». Проверка доступности отвечает только на вопрос «идёт ли
 * поток», поэтому чёрный кадр, расфокус или намертво зависшая картинка сегодня
 * проходят как исправная камера.
 *
 * Всё считается ЛОКАЛЬНО, без внешних сервисов анализа изображений — в ТЗ это
 * значилось как «требует согласования», согласовывать не пришлось: перечисленные
 * дефекты ловятся обычной математикой по яркости и резкости, нейросеть тут не
 * нужна.
 *
 * Декодирование — через ffmpeg, который и так обязательная зависимость проекта
 * (им снимаются RTSP-кадры). Новых npm-пакетов ноль: sharp/jimp тянуть на
 * одноядерную ВМ ради подсчёта средней яркости незачем.
 *
 * Кадр ужимается до 160x120 в оттенках серого — 19 КБ на картинку. Разбор
 * восьмидесяти кадров занимает считаные секунды, для ежедневного прогона это
 * незаметно.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const run = promisify(execFile);

// Рабочий размер кадра для метрик. Меньше — теряется резкость как признак,
// больше — растёт время без пользы: дефекты видны и на превью.
export const W = 160;
export const H = 120;

// Сторона «подписи» кадра. 16x16 достаточно, чтобы отличить сцену от сцены,
// и достаточно мало, чтобы шум и мелкое движение подпись не меняли.
export const SIG = 16;

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

/** Человеческие названия дефектов — идут в письмо и заявку. */
export const DEFECT_LABELS = {
  dark: 'тёмный кадр',
  overexposed: 'засветка',
  blurry: 'расфокусировка или грязный объектив',
  frozen: 'изображение зависло',
  noisy: 'шум и помехи',
  'angle-changed': 'изменился ракурс',
};

/** Пороги. Все настраиваются в .env — сцены у объектов разные. */
export function qualityThresholds() {
  return {
    darkMean: num(process.env.QUALITY_DARK_MEAN, 25),
    darkRatio: num(process.env.QUALITY_DARK_RATIO, 0.9),
    brightMean: num(process.env.QUALITY_BRIGHT_MEAN, 230),
    brightRatio: num(process.env.QUALITY_BRIGHT_RATIO, 0.6),
    // Абсолютный пол резкости: ниже него картинка размыта при любой сцене.
    // Значение из замера по 88 рабочим кадрам объектов: там минимум 319,
    // медиана 1689. Сильно размытый кадр даёт 15, слегка размытый — 136.
    blurAbs: num(process.env.QUALITY_BLUR_ABS, 100),
    // Доля от собственной нормы камеры: «была резкой — стала мыльной».
    blurRel: num(process.env.QUALITY_BLUR_REL, 0.4),
    // Во сколько раз резкость должна превысить норму, чтобы счесть это шумом.
    // Замер: сильный шум поднимает резкость примерно в 2,3 раза от нормы.
    noiseRel: num(process.env.QUALITY_NOISE_REL, 2),
    // Корреляция с эталонами ниже этой — сцена другая, камеру повернули.
    // 18.08.2026 порог снижен с 0,5 до 0,3: при 0,5 в заявки попадал любой
    // сдвиг на пару градусов и любая смена освещения. «Серьёзный сдвиг» —
    // это когда от прежнего кадра не остаётся почти ничего, а такое даёт
    // корреляцию ниже 0,3 (замер по двум неделям истории — см. CHANGELOG).
    angleCorr: num(process.env.QUALITY_ANGLE_CORR, 0.3),
    // Сколько прогонов подряд дефект должен держаться до заявки.
    minStreak: num(process.env.QUALITY_MIN_STREAK, 3),
  };
}

/**
 * Декодирует картинку в буфер оттенков серого W*H через ffmpeg.
 * @returns {Promise<Buffer|null>} null, если декодировать не удалось
 */
export async function decodeGray(filePath, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg') {
  try {
    const { stdout } = await run(
      ffmpegPath,
      ['-v', 'error', '-i', filePath, '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: W * H * 4, timeout: 20_000, windowsHide: true },
    );
    return stdout && stdout.length >= W * H ? stdout.subarray(0, W * H) : null;
  } catch {
    return null;
  }
}

/**
 * Метрики кадра. Чистая функция от буфера — тестируется без ffmpeg и диска.
 *
 * sharpness — дисперсия лапласиана: классическая мера резкости. У чёткого кадра
 * границы дают сильный отклик, у размытого отклик слабый. Считаем по внутренним
 * пикселям, края пропускаем.
 */
export function computeMetrics(buf, w = W, h = H) {
  const n = w * h;
  let sum = 0;
  let dark = 0;
  let bright = 0;

  for (let i = 0; i < n; i++) {
    const v = buf[i];
    sum += v;
    if (v < 24) dark++;
    else if (v > 240) bright++;
  }
  const mean = sum / n;

  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (buf[i] - mean) ** 2;
  const std = Math.sqrt(varSum / n);

  // Лапласиан: [0 1 0; 1 -4 1; 0 1 0]
  let lapSum = 0;
  let lapSqSum = 0;
  let lapCount = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = buf[i - w] + buf[i + w] + buf[i - 1] + buf[i + 1] - 4 * buf[i];
      lapSum += lap;
      lapSqSum += lap * lap;
      lapCount++;
    }
  }
  const lapMean = lapSum / lapCount;
  const sharpness = lapSqSum / lapCount - lapMean * lapMean;

  return {
    mean: Math.round(mean * 100) / 100,
    std: Math.round(std * 100) / 100,
    sharpness: Math.round(sharpness * 100) / 100,
    darkRatio: Math.round((dark / n) * 1000) / 1000,
    brightRatio: Math.round((bright / n) * 1000) / 1000,
    signature: buildSignature(buf, w, h),
    frameHash: frameHash(buf),
  };
}

/**
 * Отпечаток кадра для детекта «изображение зависло».
 *
 * Именно точное совпадение, без порога похожести. Так вышло не от простоты —
 * замер показал, что порог тут не работает в принципе: усреднённая подпись
 * даёт для «того же кадра ещё раз» 0,9993..0,9999, а для повторного съёма
 * НЕПОДВИЖНОЙ сцены с сенсорным шумом — 0,9994..0,9999. Диапазоны совпадают,
 * разделить их числом нельзя, и любой порог давал бы заявки «зависло» на
 * каждую ночную статичную сцену.
 *
 * Зато зависшая камера отдаёт БАЙТ В БАЙТ тот же кадр, а декодирование
 * детерминировано (проверено на четырёх объектах) — значит точное совпадение
 * отпечатка и есть честный признак. Обратная сторона: если регистратор
 * перекодирует застывший кадр заново, мы его пропустим. Пропустить хуже, чем
 * завалить оператора ложными заявками, поэтому выбор такой.
 */
export function frameHash(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

/**
 * Подпись кадра: SIG x SIG средних яркостей, в hex.
 * Служит для «зависло» (сравнение с предыдущим кадром) и «сменился ракурс»
 * (сравнение с эталоном).
 */
export function buildSignature(buf, w = W, h = H) {
  const cell = new Uint8Array(SIG * SIG);
  const bw = w / SIG;
  const bh = h / SIG;
  for (let by = 0; by < SIG; by++) {
    for (let bx = 0; bx < SIG; bx++) {
      let s = 0;
      let c = 0;
      const y0 = Math.floor(by * bh);
      const y1 = Math.floor((by + 1) * bh);
      const x0 = Math.floor(bx * bw);
      const x1 = Math.floor((bx + 1) * bw);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) { s += buf[y * w + x]; c++; }
      }
      cell[by * SIG + bx] = c ? Math.round(s / c) : 0;
    }
  }
  return Buffer.from(cell).toString('hex');
}

/**
 * Сходство двух подписей по «зависанию»: 1 = кадры идентичны.
 * Считаем по средней абсолютной разнице — она чувствительна именно к тому,
 * что нужно: живая сцена всегда шевелится хотя бы на единицы яркости.
 */
export function signatureSimilarity(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return 0;
  const a = Buffer.from(hexA, 'hex');
  const b = Buffer.from(hexB, 'hex');
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  return 1 - diff / (a.length * 255);
}

/**
 * Корреляция подписей — для смены ракурса.
 *
 * Берём именно корреляцию, а не разницу яркостей: за сутки сцена меняет
 * освещение (день/ночь, включили свет), и по абсолютной разнице любая камера
 * выглядела бы «повёрнутой». Корреляция нормирует яркость и контраст и
 * реагирует на изменение СТРУКТУРЫ кадра — то есть на то, что камера смотрит
 * в другую сторону.
 */
export function signatureCorrelation(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return 0;
  const a = Buffer.from(hexA, 'hex');
  const b = Buffer.from(hexB, 'hex');
  const n = a.length;

  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;

  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return 0;
  return cov / Math.sqrt(va * vb);
}

/**
 * Определяет дефекты кадра. Чистая функция — вся логика решения тестируется
 * без ffmpeg.
 *
 * @param {object} m        — метрики текущего кадра (computeMetrics)
 * @param {object} ctx
 * @param {number} [ctx.baselineSharpness] — обычная резкость ЭТОЙ камеры (медиана истории)
 * @param {string} [ctx.prevHash]          — отпечаток предыдущего кадра (для «зависло»)
 * @param {string} [ctx.baseSignature]     — эталонная подпись (для «сменился ракурс»)
 * @param {object} [ctx.thresholds]
 * @returns {string[]} коды дефектов
 */
export function classifyDefects(m, ctx = {}) {
  const t = ctx.thresholds || qualityThresholds();
  const defects = [];

  // Яркость: любого из двух признаков достаточно. Проверять их вместе нельзя —
  // кадр с одной яркой лампой в тёмном цехе имеет высокую долю чёрного, но
  // среднюю яркость выше порога, и наоборот равномерно серый «туман» не даёт
  // почти чёрных пикселей. Реальные рабочие кадры объектов лежат в диапазоне
  // яркости 44–184, так что пороги 25 и 230 их не задевают.
  const isDark = m.mean < t.darkMean || m.darkRatio > t.darkRatio;
  const isBright = m.mean > t.brightMean || m.brightRatio > t.brightRatio;
  if (isDark) defects.push('dark');
  if (isBright) defects.push('overexposed');

  // Резкость и шум считаем ТОЛЬКО на нормально экспонированном кадре.
  // В чёрном и в засвеченном кадре градиентов нет по определению, поэтому
  // любой из них выглядит «расфокусированным» — и оператор получал бы заявку
  // «грязный объектив» там, где на самом деле камера ослепла от засветки.
  // Причина одна, называть её надо одним словом.
  if (!isDark && !isBright) {
    const base = ctx.baselineSharpness;

    // Абсолютный пол ловит откровенно мыльный кадр даже без истории (первые
    // прогоны), относительный — ухудшение у камеры, которая раньше показывала
    // чётко. Без второго правила расфокус на изначально мягкой сцене
    // (дальний план, туман) не заметить.
    const blurAbs = m.sharpness < t.blurAbs;
    const blurRel = base > 0 && m.sharpness < base * t.blurRel;
    if (blurAbs || blurRel) defects.push('blurry');

    // Шум: резкость резко ВЫШЕ собственной нормы. Реальная сцена так не
    // меняется, а «снег» и помехи дают именно такой скачок высокочастотной
    // энергии. Самый слабый из признаков: отличить помехи от «включили свет и
    // стало видно детали» одной цифрой нельзя, поэтому он только относительный
    // и, как и остальные, требует устойчивости в несколько прогонов подряд.
    else if (base > 0 && m.sharpness > base * t.noiseRel) {
      defects.push('noisy');
    }
  }

  // Зависшая картинка: кадр совпадает с предыдущим точно, до байта.
  // Почему без порога похожести — см. комментарий к frameHash().
  if (ctx.prevHash && m.frameHash && m.frameHash === ctx.prevHash) {
    defects.push('frozen');
  }

  // Смена ракурса: кадр перестал совпадать НИ С ОДНИМ эталоном.
  //
  // Раньше сравнивали с одним кадром пятидневной давности — и это давало
  // поток ложных заявок (18.08.2026: 11 камер за один прогон). Причина не в
  // пороге, а в том, что у сцены законно бывает несколько состояний: свет
  // включили/выключили, ночью встал ИК-фильтр, открыли ворота. Между такими
  // состояниями корреляция падает до нуля и ниже, хотя камера не двигалась.
  //
  // Поэтому эталон теперь не один, а десяток кадров за прошлые прогоны, и
  // берётся ЛУЧШЕЕ совпадение: если сегодняшний кадр похож хоть на одно из
  // прежних состояний сцены — камера смотрит туда же, куда и раньше. Реальный
  // разворот не совпадает ни с одним из них.
  const bases = Array.isArray(ctx.baseSignatures)
    ? ctx.baseSignatures.filter(Boolean)
    : (ctx.baseSignature ? [ctx.baseSignature] : []);
  if (bases.length > 0) {
    const best = Math.max(...bases.map((s) => signatureCorrelation(m.signature, s)));
    if (best < t.angleCorr) defects.push('angle-changed');
  }

  return defects;
}

/**
 * Полный разбор одного файла: декодирование + метрики + классификация.
 * @returns {Promise<{metrics, defects}|null>} null — если кадр не читается
 */
export async function analyzeFile(filePath, ctx = {}) {
  const buf = await decodeGray(filePath, ctx.ffmpegPath);
  if (!buf) return null;
  const metrics = computeMetrics(buf);
  return { metrics, defects: classifyDefects(metrics, ctx) };
}

/** Дефекты по-русски, через запятую — для письма и заявки. */
export function describeDefects(codes) {
  return (codes || []).map((c) => DEFECT_LABELS[c] || c).join(', ');
}
