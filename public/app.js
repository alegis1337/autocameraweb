/**
 * app.js — карта камер объектов (v3.2).
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
 */

// Мониторинг обновляет данные раз в 15 минут — чаще опрашивать нечего, а на
// слабой ВМ каждый опрос это реальная работа сервера.
const POLL_MS = 60_000;

const state = {
  map: null,
  allCams: [],            // камеры показываемых объектов (из /api/status)
  cams: [],               // из них — попавшие под фильтр (то, что на экране)
  system: 'all',          // 'all' | <id объекта> — выбранный объект
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
    ? `<img class="card-shot" src="/api/snapshot?key=${encodeURIComponent(cam.cam_key)}" alt="Последний снимок" loading="lazy">`
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

  listEl.innerHTML = html || '<div class="sb-empty">Нет камер</div>';
  document.getElementById('sb-count').textContent = state.cams.length ? `(${state.cams.length})` : '';
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
  let ok = 0, down = 0, unknown = 0;
  for (const c of state.cams) {
    if (c.status === 'online') ok++;
    else if (isBroken(c.status)) down++;
    else unknown++;
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
  document.getElementById('cnt-unknown').textContent = unknown;
}

// ── Фильтры: объект, внутри него — этаж ───────────────────────────────────────
// Площадок пять, и смотреть их удобнее по одной. Кнопки живут в шапке: отдельная
// строка под шапкой съедала высоту у карты ради шести кнопок. Этажи — не ещё
// один ряд кнопок, а выпадающий список под кнопкой объекта:
// список висит поверх карты, поэтому высота шапки не меняется вообще и
// интерфейс при выборе объекта не сдвигается.

const brokenCount = (cams) => cams.filter((c) => isBroken(c.status)).length;

/**
 * Пересобрать экран под текущий фильтр.
 * @param {boolean} fit — подогнать карту под видимые точки (только по клику
 *   пользователя: на опросе двигать карту нельзя, зритель мог увести её сам).
 */
function applyFilters({ fit = false } = {}) {
  const ofSystem = state.system === 'all'
    ? state.allCams
    : state.allCams.filter((c) => c.system_id === state.system);

  // Этаж фильтрует только внутри объекта: со «всеми объектами» списка этажей
  // нет, и фильтр обязан быть выключен — иначе «2 этаж» скрыл бы 72 камеры
  // одноэтажных площадок ради пяти.
  if (!hasFloors(state.system)) state.floor = 'all';
  state.cams = state.floor === 'all' ? ofSystem : ofSystem.filter((c) => (c.floor || 1) === state.floor);

  syncPlacemarks();
  refreshMarkers();
  renderSidebar();
  renderObjects();
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
}

// Кнопка объекта: подпись, число камер и красный значок с числом неработающих.
// Значок обязателен: счётчики шапки считают только видимые камеры, и без него
// поломка на невыбранном объекте была бы не видна вовсе.
function objectBtn(id, label, cams) {
  const down = brokenCount(cams);
  const active = state.system === id;
  // Выбранный этаж пишем прямо на кнопке: список закрывается сразу после
  // выбора, и иначе было бы непонятно, почему камер стало меньше.
  const floorMark = active && state.floor !== 'all' ? `<span class="obj-floor">· ${state.floor} эт.</span>` : '';
  return `<button type="button" class="obj-btn${active ? ' active' : ''}" data-sys="${escapeHtml(id)}">`
    + `${escapeHtml(label)}<span class="obj-count">· ${cams.length}</span>${floorMark}`
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

// ── РЕДАКТОР расстановки (удалить после расстановки камер) ───────────────────────
function setEditing(on) {
  state.editing = on;
  for (const pm of state.placemarks.values()) pm.options.set('draggable', on);
  const btn = document.getElementById('edit-toggle');
  btn.classList.toggle('active', on);
  btn.textContent = on ? 'Выйти из редактора' : 'Режим редактора';
  const hint = document.getElementById('edit-hint');
  hint.hidden = !on;
  if (on) hint.textContent = 'Режим редактора: перетащите камеры на их места — позиции сохраняются автоматически.';
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
    const hint = document.getElementById('edit-hint');
    hint.textContent = `Сохранено: ${camKey.split('|').pop()}`;
  } catch (e) {
    console.error('save position:', e);
    document.getElementById('edit-hint').textContent = 'Не удалось сохранить позицию: ' + e.message;
  }
}
// ── /РЕДАКТОР ───────────────────────────────────────────────────────────────────

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

    computeCoords();
    applyFilters();            // раскладывает точки, список и кнопки фильтров
    fitOnce();

    const el = document.getElementById('updated');
    const age = fmtAge(data.data_age_sec);
    el.innerHTML = data.stale
      ? `<span class="stale">Данные устарели (${age})</span>`
      : `Обновлено: ${age}`;
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

function bindUi() {
  // Строки списка перерисовываются каждый опрос — делегирование.
  document.getElementById('sb-list').addEventListener('click', (e) => {
    const row = e.target.closest('.sb-row');
    if (row) locate(row.dataset.key);
  });
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
    if (e.key === 'Escape' && state.menuFor) { state.menuFor = null; renderObjects(); }
  });
  // РЕДАКТОР: переключение режима.
  document.getElementById('edit-toggle').addEventListener('click', () => setEditing(!state.editing));
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

  bindUi();

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
