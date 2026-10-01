/**
 * app.js — карта объектов: камеры и прочие устройства (v3.6).
 *
 * Схема перенесена из rinok/public/map.js: Yandex Maps JS API (ключ приходит из
 * /config.js), маркеры по точкам, балун со сводкой, справа — список всех точек.
 * Отличие: точка здесь = КАМЕРА (а не Wi-Fi AP), и показываем камеры объектов
 * из WEB_MAP_SYSTEMS.
 *
 * Рендер карты идёт в браузере зрителя, сама ВМ отдаёт только JSON и снимки.
 * Диагностику («требуют внимания», графики) на карте намеренно не показываем —
 * по просьбе: только сводка «работает / не работает» + снимок по клику.
 *
 * ВРЕМЕННЫЙ РЕДАКТОР (пометки «РЕДАКТОР»): админ включает режим, перетаскивает
 * камеры на их места, координаты сохраняются на сервере. Камеры без координат
 * раскладываются хаотично у центра своего объекта — их и растаскивают. После
 * расстановки весь помеченный код можно удалить, карта продолжит работать на
 * сохранённых точках.
 *
 * УСТРОЙСТВА (пометки «УСТРОЙСТВА», v3.6) — это НЕ временный код. Хабы,
 * регистраторы, коммутаторы, роутеры, телефоны и точки доступа мониторинг не
 * опрашивает: их отметки ставит админ и правит когда угодно. Тип устройства
 * показывает ФИГУРА маркера; цветов два — сетевое железо и рабочие места
 * (компьютеры, принтеры), оба не похожи на статусные цвета камер.
 * Убирая временный редактор камер, сам режим редактора и подсказку под шапкой
 * надо оставить: устройства ставятся из них.
 *
 * ТЕЛЕФОН (v3.10): на узком экране шапка сжимается, кнопки объектов листаются
 * лентой, а карта и список становятся вкладками (styles.css, блок «Телефон»).
 */

// Мониторинг обновляет данные раз в 15 минут — чаще опрашивать нечего, а на
// слабой ВМ каждый опрос это реальная работа сервера.
const POLL_MS = 60_000;

// Телефон: узкий экран или низкий (телефон боком). То же условие стоит в
// styles.css у блока «Телефон» — менять оба места вместе.
const PHONE_MQ = '(max-width: 760px), (max-height: 500px)';

// Площадь карты (px²), меньше которой карточка открывается не облачком над
// точкой, а панелью внизу во всю ширину. Порог по площади, а не по ширине:
// так же ведёт себя телефон, повёрнутый боком, а планшет и монитор — нет.
const BALLOON_PANEL_MAX_AREA = 400 * 900;

const state = {
  map: null,
  allCams: [],            // камеры показываемых объектов (из /api/status)
  cams: [],               // из них — попавшие под фильтр (то, что на экране)
  // 'all' | <id объекта> | 'none'. 'none' — камеры скрыты целиком: повторный
  // клик по «Все объекты» гасит слой камер, чтобы на карте остались одни
  // устройства (иначе показать их без камер было нельзя).
  system: 'all',
  floor: 'all',           // 'all' | 1 | 2 — этаж внутри выбранного объекта
  menuFor: null,          // id объекта, у которого раскрыт список этажей
  coords: new Map(),      // cam_key → [lat, lon]; считается по ВСЕМ камерам
  placemarks: new Map(),  // cam_key → ymaps.Placemark
  byKey: new Map(),       // cam_key → запись камеры (для балуна/статуса)
  role: null,             // 'admin' | 'viewer'
  editing: false,         // РЕДАКТОР: включён ли режим расстановки
  mapSystems: ['trassir'], // какие объекты показываем (WEB_MAP_SYSTEMS)
  sysCenters: new Map(),  // id объекта → [lat, lon] центра (из geo.txt)
  sysNames: new Map(),    // id объекта → имя объекта для списка и балуна
  fitted: false,          // границы под точки подогнаны (делается один раз)
  // УСТРОЙСТВА (не камеры)
  devices: [],            // все устройства видимых объектов (из /api/status)
  visDevices: [],         // из них — попавшие под фильтр
  devPlacemarks: new Map(), // id устройства → ymaps.Placemark
  showDevices: true,      // слой устройств включён
  placing: null,          // тип устройства, который ставим следующим кликом
  deviceTypes: {},        // id типа → подпись (приходит из /config.js)
  // Нейтральный дефолт; реальный центр площадки приходит из /config.js
  // (APP_CONFIG.mapCenter из .env) — координаты объекта в коде не держим.
  center: [55.751, 37.618],
};

const STATUS_LABEL = {
  online: 'работает',
  offline: 'не работает',
  'no-recording': 'нет записи',
  unknown: 'нет данных',
};

// Значки Яндекса по статусу — цвета совпадают с легендой в шапке.
const PRESET = {
  online: 'islands#greenDotIcon',
  offline: 'islands#redDotIcon',
  'no-recording': 'islands#orangeDotIcon',
  unknown: 'islands#grayDotIcon',
};

const isBroken = (s) => s === 'offline' || s === 'no-recording';

// ── УСТРОЙСТВА: фигуры маркеров ───────────────────────────────────────────────
// Тип устройства показывает ФИГУРА, а не цвет: цвета на этой карте уже заняты
// статусами камер (зелёный / красный / оранжевый / серый), и ещё восемь оттенков
// читались бы как «какие-то новые состояния». Поэтому цветов у устройств ровно
// два и оба нарочно не похожи на статусные: голубой — сетевое и охранное железо,
// сиреневый — рабочие места (компьютеры и принтеры, v3.10), чтобы их было видно
// отдельно от стоек и коммутаторов.
const DEVICE_COLOR = '#5cc8ff';
const DEVICE_COLORS = {
  pc:      '#c38fff',
  printer: '#c38fff',
};
const deviceColor = (type) => DEVICE_COLORS[type] || DEVICE_COLOR;

// SVG-фигуры в системе координат 24×24. Новый тип устройства = строка здесь
// плюс строка в DEVICE_TYPES на сервере (server/map-devices.js); больше типы
// нигде не перечислены.
const DEVICE_SHAPES = {
  hub:    '<path d="M9.6 2.6h4.8v7h7v4.8h-7v7H9.6v-7h-7V9.6h7z"/>',            // крест
  nvr:    '<circle cx="12" cy="12" r="8.6"/>',                                  // кружок
  switch: '<path d="M12 2.9 21.8 20.4H2.2z"/>',                                 // треугольник
  router: '<rect x="3.6" y="3.6" width="16.8" height="16.8" rx="2.6"/>',        // квадрат
  // Телефон — единственная не геометрическая фигура: трубка узнаётся сразу, а
  // ещё один прямоугольник путался бы с роутером.
  phone:  '<path d="M7 2.7c1.1 0 2 .6 2.5 1.6l1 2.3c.4 1 .1 2.1-.7 2.7l-1 .8c.9 1.7 2.3 3.1 4 4l.8-1c.7-.8 1.8-1.1 2.8-.7l2.3 1c1 .4 1.6 1.4 1.6 2.5v2.2c0 1.5-1.3 2.7-2.8 2.5C9.4 19.7 4.3 14.6 3.2 5.5 3 4 4.2 2.7 5.7 2.7z"/>',
  ap:     '<path d="M12 2.2 21.8 12 12 21.8 2.2 12z"/>',                        // ромб
  // Рабочие места — тоже пиктограммы, а не фигуры: монитор на ножке и принтер
  // с листом читаются без подписи. Тёмные вставки (экран, щель для бумаги)
  // без контура — иначе на 13 px они сливаются в кляксу.
  pc:     '<path d="M3.5 3.5h17A1.5 1.5 0 0 1 22 5v10.5a1.5 1.5 0 0 1-1.5 1.5H14v2.5h3.5v2h-11v-2H10V17H3.5A1.5 1.5 0 0 1 2 15.5V5a1.5 1.5 0 0 1 1.5-1.5z"/>'
        + '<path fill="#0f1419" fill-opacity=".45" stroke="none" d="M4.2 5.2h15.6v9.6H4.2z"/>', // монитор
  printer: '<path d="M7 2.5h10V8h3a1.5 1.5 0 0 1 1.5 1.5V17h-4v4.5h-11V17h-4V9.5A1.5 1.5 0 0 1 4 8h3z"/>'
        + '<path fill="#0f1419" stroke="none" d="M6.5 13.4h11v1.5h-11z"/>',      // принтер
};

/** Подпись типа. Список типов приходит с сервера — в коде фронта его нет. */
const deviceLabel = (type) => state.deviceTypes[type] || type;

/** Маркер на карте: тёмный контур держит фигуру читаемой и на спутнике, и на схеме. */
function deviceIcon(type) {
  const shape = DEVICE_SHAPES[type] || DEVICE_SHAPES.nvr;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26">'
    + `<g fill="${deviceColor(type)}" stroke="#0f1419" stroke-width="1.4" stroke-linejoin="round">${shape}</g></svg>`;
  return {
    iconLayout: 'default#image',
    iconImageHref: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
    iconImageSize: [26, 26],
    iconImageOffset: [-13, -13],
  };
}

/**
 * Та же фигура значком в тексте — для списка справа и кнопок редактора. Цвет
 * передаётся переменной `--dev-color`: так он живёт в одном месте (здесь), а
 * CSS может его перебить — выбранная кнопка редактора красит значок белым.
 */
function deviceGlyph(type, size = 13) {
  return `<svg class="dev-ico" viewBox="0 0 24 24" width="${size}" height="${size}" style="--dev-color:${deviceColor(type)}" aria-hidden="true">`
    + `<g fill="currentColor">${DEVICE_SHAPES[type] || DEVICE_SHAPES.nvr}</g></svg>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtAge(sec) {
  if (sec === null || sec === undefined) return 'нет данных';
  if (sec < 90) return `${sec} с назад`;
  const m = Math.round(sec / 60);
  if (m < 90) return `${m} мин назад`;
  return `${Math.round(m / 60)} ч назад`;
}

function fmtTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Балун камеры: объект, статус, с какого времени, причина и снимок last-good.
// Снимок грузится только при открытии балуна (src подставляется здесь) — не для
// всего списка сразу, чтобы не гонять десятки картинок.
function balloonHtml(cam) {
  const shot = cam.has_snapshot
    ? `<img class="card-shot" src="/api/snapshot?key=${encodeURIComponent(cam.cam_key)}" alt="Последний снимок" loading="lazy" data-title="${escapeHtml(cam.camera)}">`
    : '<div class="card-noshot">Снимка нет — камера ещё ни разу не отдала кадр</div>';
  // Объектов на карте несколько, поэтому подписываем, чей это кадр.
  const sysName = state.sysNames.get(cam.system_id);
  return `<div class="card">
    <h3>${escapeHtml(cam.camera)}</h3>
    ${sysName ? `<div class="card-sys">${escapeHtml(sysName)}</div>` : ''}
    <div class="card-line"><span class="badge ${cam.status}">${STATUS_LABEL[cam.status] || cam.status}</span>${cam.since ? ' с ' + fmtTs(cam.since) : ''}</div>
    ${cam.reason ? `<div class="card-reason">${escapeHtml(cam.reason)}</div>` : ''}
    ${shot}
  </div>`;
}

// Балун устройства. Зрителю — только «что это и где», админу в режиме
// редактора здесь же карточка правки: имя, тип, объект, этаж, удаление.
// Отдельного экрана настроек нет намеренно — устройство правят там же, где
// видят, а список типов приходит с сервера.
function deviceBalloonHtml(dev) {
  const sysName = dev.system_id ? state.sysNames.get(dev.system_id) : '';
  const where = [deviceLabel(dev.type), sysName, dev.floor === 2 ? '2 этаж' : '']
    .filter(Boolean).map(escapeHtml).join(' · ');
  const photos = devicePhotosHtml(dev);

  if (!state.editing) {
    return `<div class="card card-dev">
      <h3>${escapeHtml(dev.name)}</h3>
      <div class="card-sys">${where}</div>
      ${photos}
    </div>`;
  }

  const opts = (list, cur) => list
    .map(([v, label]) => `<option value="${escapeHtml(v)}"${String(v) === String(cur) ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');
  const sysOptions = [['', '— без объекта —'], ...state.mapSystems.map((id) => [id, state.sysNames.get(id) || id])];

  return `<div class="card card-dev">
    <h3>${escapeHtml(dev.name)}</h3>
    <div class="card-sys">${where}</div>
    ${photos}
    <form class="dev-form" data-id="${escapeHtml(dev.id)}">
      <label>Название<input name="name" maxlength="60" value="${escapeHtml(dev.name)}"></label>
      <label>Тип<select name="type">${opts(Object.entries(state.deviceTypes), dev.type)}</select></label>
      <label>Объект<select name="system_id">${opts(sysOptions, dev.system_id || '')}</select></label>
      <label>Этаж<select name="floor">${opts([['1', '1 этаж'], ['2', '2 этаж']], dev.floor || 1)}</select></label>
      <div class="dev-actions">
        <button type="submit">Сохранить</button>
        <label class="dev-photo-add" title="Добавить фотографию устройства (JPEG)">+ фото<input type="file" accept="image/jpeg" data-id="${escapeHtml(dev.id)}" hidden></label>
        <button type="button" class="dev-del">Удалить</button>
      </div>
    </form>
  </div>`;
}

// ФОТО устройства (v3.9): миниатюры в балуне, по клику — во весь экран
// (лайтбокс). Файлы отдаёт сервер по паре «id устройства + имя из его списка»,
// поэтому в разметке нет путей — только эти два параметра. В редакторе у
// каждой миниатюры крестик удаления.
function photoUrl(dev, f) {
  return `/api/device-photo?id=${encodeURIComponent(dev.id)}&f=${encodeURIComponent(f)}`;
}

function devicePhotosHtml(dev) {
  const list = Array.isArray(dev.photos) ? dev.photos : [];
  if (!list.length) return '';
  return `<div class="card-photos">${list.map((f) => `<span class="card-photo-wrap">
      <img class="card-photo" src="${photoUrl(dev, f)}" alt="Фото: ${escapeHtml(dev.name)}" loading="lazy"
           data-full="${photoUrl(dev, f)}" data-title="${escapeHtml(dev.name)}">
      ${state.editing ? `<button type="button" class="card-photo-del" title="Удалить фото" data-id="${escapeHtml(dev.id)}" data-f="${escapeHtml(f)}">×</button>` : ''}
    </span>`).join('')}</div>`;
}

function openLightbox(src, title) {
  const box = document.getElementById('lightbox');
  if (!box) return;
  box.querySelector('img').src = src;
  box.querySelector('.lb-title').textContent = title || '';
  box.hidden = false;
}

function closeLightbox() {
  const box = document.getElementById('lightbox');
  if (!box || box.hidden) return;
  box.hidden = true;
  box.querySelector('img').src = '';
}

/** Загрузить фото к устройству: тело запроса — сам файл, без multipart. */
async function uploadDevicePhoto(id, file) {
  if (!file) return;
  if (!/jpe?g$/i.test(file.name) && file.type !== 'image/jpeg') {
    setHint('Нужен файл JPEG (снимок с телефона подойдёт)');
    return;
  }
  setHint(`Загружаю фото (${Math.round(file.size / 1024)} КБ)…`);
  try {
    const res = await fetch(`/api/device-photo?id=${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    const i = state.devices.findIndex((d) => d.id === data.device.id);
    if (i >= 0) state.devices[i] = data.device;
    applyFilters();
    setHint(`Фото добавлено: ${data.device.name}`);
  } catch (e) {
    console.error('photo upload:', e);
    setHint('Не удалось загрузить фото: ' + e.message);
  }
}

async function deleteDevicePhoto(id, f) {
  try {
    const res = await fetch('/api/device-photo-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, f }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    const i = state.devices.findIndex((d) => d.id === data.device.id);
    if (i >= 0) state.devices[i] = data.device;
    applyFilters();
    setHint('Фото удалено');
  } catch (e) {
    console.error('photo delete:', e);
    setHint('Не удалось удалить фото: ' + e.message);
  }
}

// Хаотичная раскладка камеры без координат: точки по спирали золотого сечения
// вокруг центра СВОЕГО объекта. Центр объекта — из geo.txt; без него камеры
// разных площадок легли бы одной кучей и растащить их было бы невозможно.
// Радиус небольшой (десятки метров) — админ расставит по местам в редакторе.
function scatter(center, i) {
  const golden = 2.399963;                 // равномерная спираль
  const r = 0.00012 * Math.sqrt(i + 1);    // ~13 м · sqrt(i)
  const a = i * golden;
  return [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)];
}

// Координаты всех камер считаем ОДИН раз за опрос и по полному списку, а не по
// видимым: номер в спирали должен зависеть только от самой камеры. Иначе после
// переключения объекта нерасставленная камера получала бы другой номер и прыгала
// бы по карте — в режиме редактора это особенно мешает.
function computeCoords() {
  const perSystem = new Map();   // сколько камер объекта уже разложено спиралью
  state.coords = new Map();
  for (const c of state.allCams) {
    if (Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
      state.coords.set(c.cam_key, [c.lat, c.lon]);
      continue;
    }
    // Номер в спирали занимают только камеры без координат — иначе в раскладке
    // появлялись бы дыры от уже расставленных камер.
    const idx = perSystem.get(c.system_id) || 0;
    perSystem.set(c.system_id, idx + 1);
    state.coords.set(c.cam_key, scatter(state.sysCenters.get(c.system_id) || state.center, idx));
  }
}

// ── Правый список камер (сгруппирован по объектам) ──────────────────────────────
function renderSidebar() {
  const listEl = document.getElementById('sb-list');

  const rowHtml = (c) => {
    const st = c.status || 'unknown';
    return `<button type="button" class="sb-row ${st}" data-key="${escapeHtml(c.cam_key)}" title="${escapeHtml(c.camera)}">
      <span class="sb-dot ${st}"></span>
      <span class="sb-main">
        <span class="sb-name">${escapeHtml(c.camera)}</span>
        <span class="sb-sub">${STATUS_LABEL[st] || st}${c.reason ? ' · ' + escapeHtml(c.reason) : ''}</span>
      </span>
    </button>`;
  };

  // Порядок групп — как в WEB_MAP_SYSTEMS: он задан осознанно (главный
  // объект первым), алфавит бы его перемешал.
  const html = state.mapSystems.map((sysId) => {
    const cams = state.cams.filter((c) => c.system_id === sysId);
    if (!cams.length) return '';
    const name = state.sysNames.get(sysId) || sysId;
    const down = cams.filter((c) => isBroken(c.status)).length;
    return `<div class="sb-group">
      <div class="sb-group-head">
        <span class="sb-group-name">${escapeHtml(name)}</span>
        <span class="sb-group-count${down ? ' has-down' : ''}">${down ? down + ' из ' + cams.length + ' не работают' : cams.length}</span>
      </div>
      ${cams.map(rowHtml).join('')}
    </div>`;
  }).join('');

  // УСТРОЙСТВА идут отдельной группой в конце: это не камеры, у них нет
  // статуса, и мешать их со статусными строками означало бы предлагать искать
  // среди них поломку. Строка нужна, чтобы найти устройство на карте по имени —
  // среди сотни точек глазами это дольше.
  const devHtml = state.visDevices.length ? `<div class="sb-group">
      <div class="sb-group-head">
        <span class="sb-group-name">Устройства</span>
        <span class="sb-group-count">${state.visDevices.length}</span>
      </div>
      ${state.visDevices.map((d) => {
        const sysName = d.system_id ? state.sysNames.get(d.system_id) : '';
        const sub = [deviceLabel(d.type), sysName].filter(Boolean).map(escapeHtml).join(' · ');
        return `<button type="button" class="sb-row sb-dev" data-dev="${escapeHtml(d.id)}" title="${escapeHtml(d.name)}">
          <span class="sb-devico">${deviceGlyph(d.type)}</span>
          <span class="sb-main">
            <span class="sb-name">${escapeHtml(d.name)}</span>
            <span class="sb-sub">${sub}</span>
          </span>
        </button>`;
      }).join('')}
    </div>` : '';

  // Камеры скрыты нарочно — так и пишем, иначе пустой список читался бы как
  // «камер нет вообще».
  const hiddenNote = state.system === 'none' ? '<div class="sb-empty">Камеры скрыты — нажмите «Все объекты»</div>' : '';
  listEl.innerHTML = (hiddenNote + html + devHtml) || '<div class="sb-empty">Нет камер</div>';
  document.getElementById('sb-count').textContent = state.cams.length ? `(${state.cams.length})` : '';
  document.getElementById('mob-count').textContent = state.cams.length ? `· ${state.cams.length}` : '';
}

// Создать недостающие маркеры, убрать исчезнувшие. Позицию берём один раз при
// создании: дальше опрос её не сбрасывает (иначе перетащенная камера прыгала бы).
function syncPlacemarks() {
  if (!state.map) return;
  const seen = new Set();

  state.cams.forEach((c) => {
    seen.add(c.cam_key);
    if (state.placemarks.has(c.cam_key)) return;

    const pm = new ymaps.Placemark(
      state.coords.get(c.cam_key) || state.center,
      { hintContent: c.camera },
      { preset: PRESET[c.status] || PRESET.unknown, balloonCloseButton: true, draggable: state.editing },
    );
    // РЕДАКТОР: сохранить позицию после перетаскивания.
    pm.events.add('dragend', () => onDragEnd(c.cam_key, pm));
    state.placemarks.set(c.cam_key, pm);
    state.map.geoObjects.add(pm);
  });

  for (const [key, pm] of state.placemarks) {
    if (!seen.has(key)) { state.map.geoObjects.remove(pm); state.placemarks.delete(key); }
  }
}

// УСТРОЙСТВА: маркеры устройств. В отличие от камер, позицию и фигуру обновляем
// и у существующих маркеров: то и другое админ меняет прямо в карточке, и
// маркер должен догонять её сразу, не дожидаясь перезагрузки страницы.
function syncDevices() {
  if (!state.map) return;
  const seen = new Set();

  for (const d of state.visDevices) {
    seen.add(d.id);
    let pm = state.devPlacemarks.get(d.id);
    if (!pm) {
      pm = new ymaps.Placemark([d.lat, d.lon], {}, {
        ...deviceIcon(d.type), balloonCloseButton: true, draggable: state.editing,
      });
      pm.events.add('dragend', () => onDeviceDrag(d.id, pm));
      state.devPlacemarks.set(d.id, pm);
      state.map.geoObjects.add(pm);
    } else {
      pm.options.set(deviceIcon(d.type));
      const cur = pm.geometry.getCoordinates();
      if (cur[0] !== d.lat || cur[1] !== d.lon) pm.geometry.setCoordinates([d.lat, d.lon]);
    }
    pm.properties.set({
      hintContent: `${escapeHtml(d.name)} — ${escapeHtml(deviceLabel(d.type))}`,
      balloonContent: deviceBalloonHtml(d),
    });
  }

  for (const [id, pm] of state.devPlacemarks) {
    if (!seen.has(id)) { state.map.geoObjects.remove(pm); state.devPlacemarks.delete(id); }
  }
}

/**
 * Какие устройства показывать. Фильтры те же, что у камер: иначе при выборе
 * объекта на карте остались бы висеть чужие хабы и коммутаторы.
 * Устройство без объекта видно всегда — его не к чему отнести.
 */
function visibleDevices() {
  return state.devices.filter((d) => {
    if (d.system_id && !state.mapSystems.includes(d.system_id)) return false;
    // Со скрытыми камерами объект не выбран — устройства показываем все.
    if (objectSelected() && d.system_id && d.system_id !== state.system) return false;
    if (state.floor !== 'all' && (d.floor || 1) !== state.floor) return false;
    return true;
  });
}

// Подогнать карту под все точки — ОДИН раз после первой загрузки. Площадки
// бывают разнесены на сотни метров: при зуме на одну из них остальные
// остались бы за краем экрана. Дальше карту не трогаем —
// зритель мог подвинуть её сам, дёргать каждую минуту нельзя.
function fitOnce() {
  if (state.fitted || !state.map || !state.placemarks.size) return;
  state.fitted = true;
  const bounds = state.map.geoObjects.getBounds();
  if (!bounds) return;
  state.map.setBounds(bounds, { checkZoomRange: true, zoomMargin: 40 });
}

// Обновить цвет/подсказку/балун существующих маркеров и счётчики шапки. Позиции
// не трогаем. Работает и без карты (тогда только считает счётчики и список).
function refreshMarkers() {
  // «Нет данных» в шапке не считаем: счётчик убрали — серые точки и так видны
  // на карте и в списке, а к действию он не звал.
  let ok = 0, down = 0;
  for (const c of state.cams) {
    if (c.status === 'online') ok++;
    else if (isBroken(c.status)) down++;
    const pm = state.placemarks.get(c.cam_key);
    if (!pm) continue;
    pm.options.set('preset', PRESET[c.status] || PRESET.unknown);
    const sysName = state.sysNames.get(c.system_id);
    pm.properties.set({
      balloonContent: balloonHtml(c),
      hintContent: `${escapeHtml(c.camera)}${sysName ? ' · ' + escapeHtml(sysName) : ''} — ${STATUS_LABEL[c.status] || c.status}`,
    });
  }
  document.getElementById('cnt-ok').textContent = ok;
  document.getElementById('cnt-down').textContent = down;
}

// ── Фильтры: объект, внутри него — этаж ───────────────────────────────────────
// Площадок пять, и смотреть их удобнее по одной. Кнопки живут в шапке: отдельная
// строка под шапкой съедала высоту у карты ради шести кнопок. Этажи — не ещё
// один ряд кнопок, а выпадающий список под кнопкой объекта:
// список висит поверх карты, поэтому высота шапки не меняется вообще и
// интерфейс при выборе объекта не сдвигается.

const brokenCount = (cams) => cams.filter((c) => isBroken(c.status)).length;

/** Выбран конкретный объект (не «все» и не «камеры скрыты»). */
const objectSelected = () => state.system !== 'all' && state.system !== 'none';

/**
 * Пересобрать экран под текущий фильтр.
 * @param {boolean} fit — подогнать карту под видимые точки (только по клику
 *   пользователя: на опросе двигать карту нельзя, зритель мог увести её сам).
 */
function applyFilters({ fit = false } = {}) {
  const ofSystem = state.system === 'all' ? state.allCams
    : state.system === 'none' ? []
    : state.allCams.filter((c) => c.system_id === state.system);

  // Этаж фильтрует только внутри объекта: со «всеми объектами» списка этажей
  // нет, и фильтр обязан быть выключен — иначе «2 этаж» скрыл бы 72 камеры
  // одноэтажных площадок ради пяти.
  if (!hasFloors(state.system)) state.floor = 'all';
  state.cams = state.floor === 'all' ? ofSystem : ofSystem.filter((c) => (c.floor || 1) === state.floor);

  // УСТРОЙСТВА: считаем видимые всегда, а показываем — если слой включён.
  // Число на кнопке слоя должно оставаться честным и при выключенном слое.
  const devs = visibleDevices();
  state.visDevices = state.showDevices ? devs : [];

  syncPlacemarks();
  syncDevices();
  refreshMarkers();
  renderSidebar();
  renderObjects();
  renderDeviceToggle(devs.length);
  // Кнопки могли только что появиться и перенести шапку на вторую строку —
  // блок карты стал другой высоты, и карте надо сказать об этом явно, прямо
  // здесь. Полагаться на ResizeObserver в этом месте нельзя: он доставляет
  // события только в цикле отрисовки, а вкладка может быть фоновой или скрытой.
  refitMap();
  if (fit) fitToVisible();
}

/** Пересчитать размер карты под её блок. Без этого карта остаётся прежней
 *  высоты, вылезает за окно и распирает страницу. */
function refitMap() {
  if (!state.map) return;
  try { state.map.container.fitToViewport(); } catch { /* карта ещё не готова */ }
}

// Подписи кнопок: на кнопке тип регистратора не нужен — короткое имя объекта
// читается быстрее, чем «Имя (TRASSIR)», а полное имя всё равно осталось в
// списке справа и в балуне. Хвост в скобках срезаем только если после этого
// имена объектов не начинают совпадать.
function shortSysNames(ids) {
  const short = new Map(ids.map((id) => [id, (state.sysNames.get(id) || id).replace(/\s*\([^)]*\)\s*$/, '').trim()]));
  const uniq = new Set(short.values());
  return uniq.size === ids.length ? short : new Map(ids.map((id) => [id, state.sysNames.get(id) || id]));
}

// Кнопки объектов. Порядок — как в WEB_MAP_SYSTEMS: он задан осознанно
// (главный объект первым), алфавит бы его перемешал.
function renderObjects() {
  const bar = document.getElementById('objects');
  const ids = state.mapSystems.filter((id) => state.allCams.some((c) => c.system_id === id));
  bar.hidden = ids.length < 2;          // один объект фильтровать незачем
  if (bar.hidden) return;

  const names = shortSysNames(ids);
  const one = (id, label) => {
    const cams = id === 'all' ? state.allCams : state.allCams.filter((c) => c.system_id === id);
    const btn = objectBtn(id, label, cams);
    // У объекта с этажами кнопка живёт в обёртке: к ней прицеплен выпадающий
    // список, и обёртка задаёт ему точку отсчёта (position: relative).
    return hasFloors(id)
      ? `<span class="obj-wrap">${btn}${state.menuFor === id ? floorMenu(cams) : ''}</span>`
      : btn;
  };

  bar.innerHTML = one('all', 'Все объекты') + ids.map((id) => one(id, names.get(id))).join('');
  placeFloorMenu();
}

/**
 * Телефон: лента фильтров прокручивается и обрезала бы выпадающий список
 * этажей, поэтому там он `position: fixed`, а координаты под кнопкой ставим
 * отсюда. На широком экране список absolute и сюда не попадает.
 */
function placeFloorMenu() {
  const menu = document.querySelector('#objects .obj-menu');
  if (!menu || getComputedStyle(menu).position !== 'fixed') return;
  const r = menu.parentElement.getBoundingClientRect();
  // У fixed проценты считаются от окна, поэтому «не уже кнопки» — здесь.
  menu.style.minWidth = `${Math.round(r.width)}px`;
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)))}px`;
}

// Кнопка объекта: подпись, число камер и красный значок с числом неработающих.
// Значок обязателен: счётчики шапки считают только видимые камеры, и без него
// поломка на невыбранном объекте была бы не видна вовсе.
function objectBtn(id, label, cams) {
  const down = brokenCount(cams);
  const active = state.system === id;
  // «Все объекты» при скрытых камерах — выключатель в положении «выкл»: вместо
  // числа камер пишем «скрыты», иначе пустая карта выглядела бы как поломка.
  const off = id === 'all' && state.system === 'none';
  // Выбранный этаж пишем прямо на кнопке: список закрывается сразу после
  // выбора, и иначе было бы непонятно, почему камер стало меньше.
  const floorMark = active && state.floor !== 'all' ? `<span class="obj-floor">· ${state.floor} эт.</span>` : '';
  const title = off ? 'Камеры скрыты — нажмите, чтобы показать'
    : id === 'all' && active ? 'Нажмите ещё раз, чтобы скрыть камеры' : '';
  return `<button type="button" class="obj-btn${active ? ' active' : ''}${off ? ' off' : ''}" data-sys="${escapeHtml(id)}"${title ? ` title="${title}"` : ''}>`
    + `${escapeHtml(label)}<span class="obj-count">· ${off ? 'скрыты' : cams.length}</span>${floorMark}`
    + (down ? `<span class="down-badge" title="Не работают камеры">${down}</span>` : '')
    + (hasFloors(id) ? '<span class="caret">▼</span>' : '')
    + '</button>';
}

// Второй этаж есть не у каждого объекта — там, где его нет, список этажей
// смысла не имеет. Спрашиваем сами данные (поле floor из /api/status,
// собирается по WEB_FLOOR2_CAMERAS), а не зашитый список объектов: добавят
// этаж ещё одной площадке — список появится сам, без правки фронта.
function hasFloors(sysId) {
  return sysId !== 'all' && state.allCams.some((c) => c.system_id === sysId && c.floor === 2);
}

/**
 * Выпадающий список этажей под кнопкой объекта.
 * @param {Array} cams — камеры объекта ДО фильтра по этажу: числа в списке
 *   должны показывать, сколько там камер вообще, а не сколько видно сейчас.
 */
function floorMenu(cams) {
  const item = (value, label, list) => {
    const down = brokenCount(list);
    return `<button type="button" class="floor-item${state.floor === value ? ' active' : ''}" data-floor="${value}">`
      + `${label}<span class="obj-count">· ${list.length}</span>`
      + (down ? `<span class="down-badge" title="Не работают камеры">${down}</span>` : '')
      + '</button>';
  };
  return `<div class="obj-menu" role="menu">`
    + item('all', 'Все этажи', cams)
    + [1, 2].map((f) => item(f, `${f} этаж`, cams.filter((c) => (c.floor || 1) === f))).join('')
    + '</div>';
}

// Подогнать карту под видимые точки. Вызывается только при смене объекта:
// площадки разнесены на сотни метров, и без этого выбор объекта оставлял бы
// зрителя смотреть на пустое место.
function fitToVisible() {
  if (!state.map || !state.placemarks.size) return;
  const bounds = state.map.geoObjects.getBounds();
  if (bounds) state.map.setBounds(bounds, { checkZoomRange: true, zoomMargin: 40 });
}

// Клик по строке списка: подвести карту к камере и открыть её балун.
function locate(camKey) {
  const pm = state.placemarks.get(camKey);
  if (!pm || !state.map) return;
  state.map.panTo(pm.geometry.getCoordinates(), { flying: true });
  if (pm.balloon) pm.balloon.open();
}

// ── РЕДАКТОР расстановки ────────────────────────────────────────────────────────
// Временная здесь только перетаскивание КАМЕР. Сам режим и подсказка нужны и
// дальше: из них ставят устройства (см. раздел «УСТРОЙСТВА» ниже).
function setEditing(on) {
  state.editing = on;
  for (const pm of state.placemarks.values()) pm.options.set('draggable', on);
  for (const pm of state.devPlacemarks.values()) pm.options.set('draggable', on);
  const btn = document.getElementById('edit-toggle');
  btn.classList.toggle('active', on);
  btn.textContent = on ? 'Выйти из редактора' : 'Режим редактора';
  const hint = document.getElementById('edit-hint');
  hint.hidden = !on;
  state.placing = null;                 // вышли из режима — постановка снята
  // В редакторе слой устройств включаем принудительно: иначе поставленное
  // устройство просто не появилось бы на карте.
  if (on) state.showDevices = true;
  setHint(EDIT_HINT);
  renderDeviceTools();
  applyFilters();                       // балуны устройств переключаются на карточку правки
}

const EDIT_HINT = 'Режим редактора: перетащите камеры на их места — позиции сохраняются автоматически.';

/** Текст подсказки под шапкой (кнопки устройств рядом с ним не трогаем). */
function setHint(msg) {
  const el = document.getElementById('edit-msg');
  if (el) { el.textContent = msg; el.title = msg; }   // обрезан многоточием — целиком при наведении
}

async function onDragEnd(camKey, pm) {
  const [lat, lon] = pm.geometry.getCoordinates();
  try {
    const res = await fetch('/api/camera-position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: camKey, lat, lon }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const c = state.byKey.get(camKey);
    if (c) { c.lat = lat; c.lon = lon; } // чтобы опрос не считал камеру «без координат»
    // И в готовую раскладку — иначе при переключении объекта до следующего
    // опроса маркер пересоздался бы на старом месте.
    state.coords.set(camKey, [lat, lon]);
    setHint(`Сохранено: ${camKey.split('|').pop()}`);
  } catch (e) {
    console.error('save position:', e);
    setHint('Не удалось сохранить позицию: ' + e.message);
  }
}
// ── /РЕДАКТОР ───────────────────────────────────────────────────────────────────

// ── УСТРОЙСТВА: слой, постановка и правка ─────────────────────────────────────
// Постоянная часть интерфейса. Устройств может быть сколько угодно: выбрал тип,
// кликаешь по карте — точка ставится сразу, тип остаётся выбранным (обычно
// ставят несколько однотипных подряд). Перетаскивание, переименование, смена
// типа/объекта/этажа и удаление — в карточке устройства.

/** Кнопка слоя устройств в шапке. Прячем, когда устройств нет и не ставим. */
function renderDeviceToggle(total) {
  const btn = document.getElementById('dev-toggle');
  if (!btn) return;
  btn.hidden = !total && !state.editing;
  if (btn.hidden) return;
  btn.classList.toggle('active', state.showDevices);
  btn.innerHTML = `Устройства<span class="obj-count">· ${total}</span>`;
}

/** Кнопки типов в подсказке редактора. Список типов приходит с сервера. */
function renderDeviceTools() {
  const box = document.getElementById('dev-tools');
  if (!box) return;
  box.innerHTML = Object.entries(state.deviceTypes).map(([type, label]) =>
    `<button type="button" class="dev-btn${state.placing === type ? ' armed' : ''}" data-type="${escapeHtml(type)}" style="--dev-color:${deviceColor(type)}">`
    + `${deviceGlyph(type)}${escapeHtml(label)}</button>`).join('');
}

/** Выбрать тип для постановки; повторный клик по тому же типу — отменить. */
function armPlacement(type) {
  state.placing = state.placing === type ? null : type;
  renderDeviceTools();
  setHint(state.placing
    // Про повторное нажатие на тип — ради телефона: Esc там нажать нечем.
    ? `Нажмите на карту — поставим: ${deviceLabel(state.placing)}. Отмена — Esc или ещё раз кнопка типа.`
    : EDIT_HINT);
}

/** Имя по умолчанию: «Коммутатор 3». Номера сквозные по типу, чтобы не совпадали. */
function nextDeviceName(type) {
  const n = state.devices.filter((d) => d.type === type).length + 1;
  return `${deviceLabel(type)} ${n}`;
}

/**
 * К какому объекту отнести поставленную точку. Выбран объект — к нему; со
 * «всеми объектами» берём ближайший центр площадки, иначе устройство осталось
 * бы «ничьим» и не пряталось бы фильтром. Объект всегда можно поменять в карточке.
 */
function systemForPoint(lat, lon) {
  if (objectSelected()) return state.system;
  let best = '';
  let bestD = Infinity;
  for (const [id, c] of state.sysCenters) {
    if (!state.mapSystems.includes(id)) continue;
    const d = (c[0] - lat) ** 2 + (c[1] - lon) ** 2;
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

/** Создать/обновить устройство на сервере и подхватить ответ в текущий экран. */
async function sendDevice(payload) {
  try {
    const res = await fetch('/api/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    const i = state.devices.findIndex((d) => d.id === data.device.id);
    if (i >= 0) state.devices[i] = data.device; else state.devices.push(data.device);
    applyFilters();
    setHint(`Сохранено: ${data.device.name}`);
    return data.device;
  } catch (e) {
    console.error('device save:', e);
    setHint('Не удалось сохранить устройство: ' + e.message);
    return null;
  }
}

async function removeDevice(id) {
  try {
    const res = await fetch('/api/device-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.devices = state.devices.filter((d) => d.id !== id);
    applyFilters();
    setHint('Устройство удалено');
  } catch (e) {
    console.error('device delete:', e);
    setHint('Не удалось удалить устройство: ' + e.message);
  }
}

/** Перетащили устройство — сохраняем новую точку. */
function onDeviceDrag(id, pm) {
  const [lat, lon] = pm.geometry.getCoordinates();
  sendDevice({ id, lat, lon });
}

/** Клик по карте в режиме постановки. Тип остаётся выбранным — ставим дальше. */
function onMapClick(e) {
  if (!state.editing || !state.placing) return;
  // Клик по существующему маркеру всплывает до карты. Ставить точку поверх
  // него не надо — человек открывал карточку, а не добавлял устройство.
  // Сверяем цель со своими маркерами, а не с картой: так проверка не зависит
  // от того, что именно Яндекс кладёт в target.
  const target = e.get('target');
  for (const pm of state.devPlacemarks.values()) if (pm === target) return;
  for (const pm of state.placemarks.values()) if (pm === target) return;
  const [lat, lon] = e.get('coords');
  sendDevice({
    type: state.placing,
    name: nextDeviceName(state.placing),
    system_id: systemForPoint(lat, lon),
    floor: state.floor === 2 ? 2 : 1,
    lat, lon,
  });
}

/** Клик по строке устройства в списке: подвести карту и открыть карточку. */
function locateDevice(id) {
  const pm = state.devPlacemarks.get(id);
  if (!pm || !state.map) return;
  state.map.panTo(pm.geometry.getCoordinates(), { flying: true });
  if (pm.balloon) pm.balloon.open();
}
// ── /УСТРОЙСТВА ───────────────────────────────────────────────────────────────

async function poll() {
  try {
    const res = await fetch('/api/status', { headers: { Accept: 'application/json' } });
    if (res.status === 401) { location.href = '/login'; return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    // Имена и центры объектов нужны раньше камер: по центру раскладываются
    // камеры без координат.
    const systems = data.systems || [];
    state.sysNames = new Map(systems.map((s) => [s.id, s.name]));
    state.sysCenters = new Map(
      systems
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
        .map((s) => [s.id, [s.lat, s.lon]]),
    );

    state.allCams = (data.cameras || []).filter((c) => state.mapSystems.includes(c.system_id));
    state.byKey = new Map(state.allCams.map((c) => [c.cam_key, c]));
    // УСТРОЙСТВА приходят тем же опросом: их немного, отдельная ручка сэкономила
    // бы байты, но развела бы карту и её отметки по времени.
    state.devices = Array.isArray(data.devices) ? data.devices : [];

    computeCoords();
    applyFilters();            // раскладывает точки, список и кнопки фильтров
    fitOnce();

    const el = document.getElementById('updated');
    const age = fmtAge(data.data_age_sec);
    // Подпись «Обновлено:» в своём span — на телефоне её прячем ради места.
    el.innerHTML = data.stale
      ? `<span class="stale">Данные устарели (${age})</span>`
      : `<span class="upd-label">Обновлено: </span>${age}`;
  } catch (e) {
    document.getElementById('updated').textContent = 'ошибка обновления';
    console.error('poll:', e);
  }
}

// Yandex Maps запоминает размер контейнера в момент создания и сам его больше
// не пересчитывает. А контейнер меняется уже после инициализации: строка кнопок
// объектов появляются после первого опроса, шапка переносится на вторую строку
// при узком окне. Карта оставалась прежней высоты,
// вылезала за окно и распирала страницу — появлялся второй скроллбар, шапка
// уезжала вверх, и список камер выглядел обрезанным.
//
// Известные случаи (появилась/исчезла строка кнопок) закрыты явным вызовом
// refitMap() в applyFilters. Наблюдатель — страховка на всё остальное: перенос
// шапки на вторую строку при узком окне, изменение размера окна, будущие
// элементы интерфейса. Он ловит сам факт изменения блока, поэтому места менять
// не придётся. Событий не даёт, пока вкладка не рисует кадры, — поэтому именно
// страховка, а не основной механизм.
function watchMapSize() {
  if (!state.map) return;
  // Изменение окна — самый частый случай, поэтому подписываемся на него и
  // напрямую, не надеясь только на наблюдатель.
  window.addEventListener('resize', refitMap);
  if (typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(refitMap).observe(document.getElementById('map'));
}

function initMap() {
  const cfg = window.APP_CONFIG || {};
  state.map = new ymaps.Map('map', {
    center: state.center,
    zoom: cfg.mapZoom || 18,
    // Гибрид (спутник + подписи) удобнее для расстановки; переключатель слоёв
    // оставлен — схему/спутник можно выбрать вручную.
    type: cfg.mapType || 'yandex#hybrid',
    controls: ['zoomControl', 'fullscreenControl', 'typeSelector', 'geolocationControl'],
  });
  // ТЕЛЕФОН: карточка на маленькой карте — панелью внизу (облачко над точкой
  // закрывало бы полэкрана и уезжало за край). Наследуют все метки карты.
  state.map.options.set('balloonPanelMaxMapArea', BALLOON_PANEL_MAX_AREA);
  // Ползунок зума во всю высоту и «Слои» с подписью съедают узкую карту;
  // на телефоне зумят щипком, кнопки +/− и значок слоёв остаются.
  if (window.matchMedia(PHONE_MQ).matches) {
    state.map.controls.get('zoomControl').options.set('size', 'small');
    state.map.controls.get('typeSelector').options.set('size', 'small');
  }
  // УСТРОЙСТВА: клик по карте ставит выбранный тип. В обычном режиме обработчик
  // ничего не делает — проверка внутри.
  state.map.events.add('click', onMapClick);
}

function loadYandex(apiKey) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(apiKey)}&lang=ru_RU`;
    s.onload = () => ymaps.ready(resolve);
    s.onerror = () => reject(new Error('не удалось загрузить Yandex Maps'));
    document.head.appendChild(s);
  });
}

function showMapError(msg) {
  document.getElementById('map').innerHTML = `<div class="map-msg">${escapeHtml(msg)}</div>`;
}

function applySiteName() {
  const name = (window.APP_CONFIG && window.APP_CONFIG.siteName) || 'Мониторинг видеонаблюдения';
  document.title = name;
  const titleEl = document.querySelector('.topbar .title');
  if (titleEl) titleEl.textContent = name;
}

/**
 * ТЕЛЕФОН: вкладка «Карта» или «Список». Список лежит поверх карты, карта под
 * ним сохраняет размер. На широком экране атрибут ни на что не влияет.
 */
function setView(view) {
  document.body.dataset.view = view;
  for (const b of document.querySelectorAll('#mob-tabs button')) b.classList.toggle('active', b.dataset.view === view);
}

function bindUi() {
  // Строки списка перерисовываются каждый опрос — делегирование.
  document.getElementById('sb-list').addEventListener('click', (e) => {
    const row = e.target.closest('.sb-row');
    if (!row) return;
    // На телефоне список закрывает карту — сначала возвращаемся к ней,
    // иначе открытую карточку было бы не видно.
    setView('map');
    if (row.dataset.dev) locateDevice(row.dataset.dev);
    else locate(row.dataset.key);
  });
  document.getElementById('mob-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (btn) setView(btn.dataset.view);
  });
  // ТЕЛЕФОН: открытый список этажей едет вместе со своей кнопкой.
  document.getElementById('filters').addEventListener('scroll', placeFloorMenu, { passive: true });
  window.addEventListener('resize', placeFloorMenu);
  // Переключение объекта: карту подводим к выбранной площадке — они разнесены
  // на сотни метров, иначе после клика зритель смотрел бы на пустое место.
  document.getElementById('objects').addEventListener('click', (e) => {
    // Этаж — фильтр внутри уже выбранного объекта, поэтому карту не двигаем:
    // площадка и так в кадре, а зум на три камеры второго этажа только сбил бы
    // привычный вид.
    const item = e.target.closest('.floor-item');
    if (item) {
      state.floor = item.dataset.floor === 'all' ? 'all' : Number(item.dataset.floor);
      state.menuFor = null;                     // выбрали — список закрываем
      applyFilters();
      return;
    }

    const btn = e.target.closest('.obj-btn');
    if (!btn) return;
    const id = btn.dataset.sys;
    // Повторный клик по уже выбранному объекту только открывает/закрывает
    // список этажей — фильтр при этом не меняется.
    if (id === state.system && hasFloors(id)) {
      state.menuFor = state.menuFor === id ? null : id;
      renderObjects();
      return;
    }
    // «Все объекты» — ещё и выключатель слоя камер: повторный клик по уже
    // активной кнопке прячет камеры (на карте остаются одни устройства),
    // следующий — возвращает. Карту при этом не двигаем: точек, под которые
    // её подгонять, нет, а возврат из «скрыты» — тот же «все объекты».
    if (id === 'all' && state.system === 'all') {
      state.system = 'none';
      state.floor = 'all';
      state.menuFor = null;
      applyFilters();
      return;
    }
    state.system = id;
    state.floor = 'all';                        // новый объект показываем целиком
    state.menuFor = hasFloors(id) ? id : null;  // есть этажи — сразу предлагаем выбрать
    applyFilters({ fit: true });
  });

  // Клик мимо и Esc закрывают список — привычное поведение выпадающего меню.
  document.addEventListener('click', (e) => {
    if (state.menuFor && !e.target.closest('.obj-wrap')) { state.menuFor = null; renderObjects(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeLightbox();
    if (state.menuFor) { state.menuFor = null; renderObjects(); }
    // Esc снимает и выбранный тип устройства — иначе следующий клик по карте
    // поставил бы лишнюю точку.
    if (state.placing) armPlacement(state.placing);
  });
  // РЕДАКТОР: переключение режима.
  document.getElementById('edit-toggle').addEventListener('click', () => setEditing(!state.editing));

  // УСТРОЙСТВА: слой, выбор типа для постановки и карточка правки в балуне.
  document.getElementById('dev-toggle').addEventListener('click', () => {
    state.showDevices = !state.showDevices;
    applyFilters();
  });
  document.getElementById('dev-tools').addEventListener('click', (e) => {
    const btn = e.target.closest('.dev-btn');
    if (btn) armPlacement(btn.dataset.type);
  });
  // Балун Яндекса живёт в обычном DOM, поэтому его форму ловим делегированием
  // на документе: содержимое балуна пересобирается на каждый опрос, и вешать
  // обработчики на сами элементы было бы бессмысленно.
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('.dev-form');
    if (!form) return;
    e.preventDefault();
    const fd = new FormData(form);
    sendDevice({
      id: form.dataset.id,
      name: fd.get('name'),
      type: fd.get('type'),
      system_id: fd.get('system_id'),
      floor: Number(fd.get('floor')),
    }).then((dev) => {
      // Сохранили — карточку закрываем (просьба пользователя: правят обычно
      // одно поле и идут к следующей точке, а на телефоне панель карточки
      // закрывает полкарты). При ошибке карточка остаётся открытой, чтобы
      // можно было поправить и нажать ещё раз.
      const pm = dev && state.devPlacemarks.get(dev.id);
      if (pm && pm.balloon.isOpen()) pm.balloon.close();
    });
  });
  document.addEventListener('click', (e) => {
    const del = e.target.closest('.dev-del');
    if (!del) return;
    const form = del.closest('.dev-form');
    // Спрашиваем подтверждение: удаление отметки не отменить, а кнопка стоит
    // рядом с «Сохранить».
    if (form && confirm('Удалить устройство с карты?')) removeDevice(form.dataset.id);
  });

  // ФОТО: миниатюра открывает лайтбокс, крестик (в редакторе) удаляет,
  // выбор файла в карточке — загружает. Всё делегированием: балун
  // пересобирается каждый опрос.
  document.addEventListener('click', (e) => {
    const del = e.target.closest('.card-photo-del');
    if (del) {
      if (confirm('Удалить это фото?')) deleteDevicePhoto(del.dataset.id, del.dataset.f);
      return;
    }
    const img = e.target.closest('.card-photo');
    if (img) { openLightbox(img.dataset.full, img.dataset.title); return; }
    // Снимок камеры — тоже во весь экран: на телефоне в карточке он мелкий.
    const shot = e.target.closest('.card-shot');
    if (shot) { openLightbox(shot.src, shot.dataset.title); return; }
    if (e.target.closest('#lightbox')) closeLightbox();
  });
  document.addEventListener('change', (e) => {
    const input = e.target.closest('.dev-photo-add input[type=file]');
    if (!input) return;
    const file = input.files && input.files[0];
    input.value = '';                     // тот же файл можно выбрать повторно
    uploadDevicePhoto(input.dataset.id, file);
  });
}

async function main() {
  applySiteName();
  const cfg = window.APP_CONFIG || {};
  // mapSystems — список объектов; mapSystem (единственное число) понимаем ради
  // старого .env, где переменная задавала ровно один объект.
  const list = Array.isArray(cfg.mapSystems) && cfg.mapSystems.length
    ? cfg.mapSystems
    : (cfg.mapSystem ? [cfg.mapSystem] : null);
  state.mapSystems = list && list.length ? list : ['trassir'];
  if (Array.isArray(cfg.mapCenter) && cfg.mapCenter.length === 2) state.center = cfg.mapCenter;
  // Типы устройств задаёт сервер (server/map-devices.js) — во фронте их списка нет.
  state.deviceTypes = (cfg.deviceTypes && typeof cfg.deviceTypes === 'object') ? cfg.deviceTypes : {};

  bindUi();
  renderDeviceTools();

  const key = cfg.yandexApiKey || '';
  if (!key) {
    // Без ключа карту не поднять, но список камер должен работать.
    showMapError('YANDEX_API_KEY не задан в .env — карта недоступна. Список камер справа работает.');
    await poll();
    setInterval(poll, POLL_MS);
    return;
  }

  try {
    await Promise.all([
      loadYandex(key),
      fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then((me) => { state.role = me && me.role; }).catch(() => {}),
    ]);
    initMap();
    watchMapSize();
    // РЕДАКТОР: кнопку показываем только админу.
    if (state.role === 'admin') document.getElementById('edit-toggle').hidden = false;
    await poll();
    setInterval(poll, POLL_MS);
  } catch (e) {
    console.error(e);
    showMapError('Ошибка инициализации карты: ' + e.message);
  }
}

main();
