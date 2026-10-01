/**
 * app.js — веб-сервер карты видеонаблюдения (v3).
 *
 * Встроенный node:http, без express: единственная зависимость проекта, которую
 * пришлось бы тянуть, ради десятка маршрутов не нужна.
 *
 * Живёт на той же машине, что и прогоны мониторинга: monitor.db читает напрямую
 * и только на чтение, наружу отдаёт отфильтрованный статус под логином.
 *
 * Запуск: npm run web   (или node server/app.js)
 *
 * Схема перенесена из проекта wifi-monitor («рынок»), server/app.js.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';
import { openWebDb } from './web-db.js';
import { login } from './auth.js';
import { buildStatus, buildCameraDetail, snapshotPathFor, isKnownCamera, knownSystemIds } from './status.js';
import { saveCameraPoint } from './camera-points.js';
import { DEVICE_TYPES, saveDevice, deleteDevice, readDevices, addDevicePhoto, removeDevicePhoto } from './map-devices.js';
import { MAX_UPLOAD_BYTES, photoPath, safePhotoName, storePhotoFromBuffer, deletePhotoFile } from './device-photos.js';
import { LoginThrottle, securityHeaders, publicPathFor, originAllowed, formatCspReport, clientIpFrom } from './security.js';

const webDb = openWebDb();
// Ограничение попыток входа (аудит 16.09.2026): неудачи считаются по адресу
// клиента и по логину, после порога вход запирается на четверть часа.
const throttle = new LoginThrottle();
// Раз в час подчищаем протухшие сессии и отработавшие счётчики попыток.
setInterval(() => {
  try { webDb.purgeExpiredSessions(); } catch (e) { log.warn(`очистка сессий: ${e.message}`); }
  throttle.purge();
}, 3600 * 1000).unref();

// Адрес клиента: из сокета; за доверенным прокси (WEB_TRUSTED_PROXIES) — из
// его X-Forwarded-For. null — прокси без X-Forwarded-For, клиент неизвестен.
const clientIp = (req) => clientIpFrom(req.socket?.remoteAddress, req.headers['x-forwarded-for'], config.web.trustedProxies);
const ipLabel = (ip) => ip || '(за прокси, без X-Forwarded-For)';

class BodyTooLarge extends Error {}
let lastCspLog = 0;

const COOKIE = 'autocamera_sid';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(sid, maxAgeSec) {
  const attrs = [`${COOKIE}=${sid}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (config.web.secureCookie) attrs.push('Secure');
  return attrs.join('; ');
}

function clearCookie() {
  const attrs = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.web.secureCookie) attrs.push('Secure');
  return attrs.join('; ');
}

function currentUser(req) {
  const sid = parseCookies(req)[COOKIE];
  if (!sid) return null;
  const s = webDb.getSession(sid);
  return s ? { sid, username: s.username, role: s.role } : null;
}

/** writeHead с защитными заголовками — на каждый ответ, включая статику и ошибки. */
function head(res, status, headers = {}) {
  res.writeHead(status, { ...securityHeaders(config.web.csp), ...headers });
}

function send(res, status, body, headers = {}) {
  head(res, status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

async function readBodyBytes(req, limit = 1 << 16) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new BodyTooLarge('тело запроса слишком большое');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readBody(req, limit = 1 << 16) {
  return (await readBodyBytes(req, limit)).toString('utf8');
}

async function serveStatic(res, urlPath) {
  // Файл строго внутри public/, иначе 403 (security.js → publicPathFor).
  const filePath = publicPathFor(urlPath, config.publicDir);
  if (!filePath) return send(res, 403, 'Forbidden');
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) return send(res, 403, 'Forbidden');
    const data = await readFile(filePath);
    head(res, 200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    send(res, 404, 'Not Found');
  }
}

async function serveFile(res, name, status = 200) {
  try {
    const data = await readFile(join(config.publicDir, name));
    head(res, status, {
      'Content-Type': MIME[extname(name).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    send(res, 500, 'Не найден файл интерфейса: ' + name);
  }
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  const form = new URLSearchParams(await readBody(req));
  // Длину логина режем: таких в БД нет, а в лог и счётчики ушёл бы мусор.
  const username = (form.get('username') || '').trim().slice(0, 64);
  const password = form.get('password') || '';

  // Сначала лимит, потом scrypt: запертая попытка не должна стоить процессора.
  const gate = throttle.check(ip, username);
  if (!gate.ok) {
    log.warn(`Вход заперт (лимит попыток): ${username || '(пусто)'} с ${ipLabel(ip)}, ещё ${gate.retryAfterSec} с`);
    return send(res, 303, '', { Location: '/login?e=2', 'Retry-After': String(gate.retryAfterSec) });
  }

  const result = username && password ? login(webDb, username, password) : null;
  if (!result) {
    const blocked = throttle.fail(ip, username);
    log.warn(`Неудачный вход: ${username || '(пусто)'} с ${ipLabel(ip)}${blocked ? ' — лимит исчерпан, вход заперт' : ''}`);
    return send(res, 303, '', { Location: blocked ? '/login?e=2' : '/login?e=1' });
  }
  throttle.success(ip, username);
  log.info(`Вход: ${result.username} с ${ipLabel(ip)}`);
  send(res, 303, '', {
    'Set-Cookie': sessionCookie(result.sid, config.web.sessionTtlHours * 3600),
    Location: '/',
  });
}

function handleLogout(req, res) {
  const u = currentUser(req);
  if (u) { webDb.deleteSession(u.sid); log.info(`Выход: ${u.username}`); }
  send(res, 303, '', { 'Set-Cookie': clearCookie(), Location: '/login' });
}

function configJs() {
  // Публичный конфиг фронта. Секретов нет: ключ Yandex Maps JS API и так виден
  // в браузере (его ограничивают по домену-referer, а не прячут).
  return `window.APP_CONFIG = ${JSON.stringify({
    siteName: config.siteName,
    yandexApiKey: config.map.yandexApiKey,
    mapCenter: config.map.center,
    mapZoom: config.map.zoom,
    mapType: config.map.type,
    mapSystems: config.map.systems,
    // Типы устройств на карте: подписи и порядок кнопок берёт фронт, чтобы
    // список типов жил в одном месте (server/map-devices.js).
    deviceTypes: DEVICE_TYPES,
  })};\n`;
}

async function router(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  // POST только со своей страницы: чужой сайт не отправит форму или JSON от
  // имени вошедшего зрителя (страховка поверх SameSite=Lax у cookie).
  if (method === 'POST' && !originAllowed(req.headers.origin, req.headers.host, config.web.publicOrigins)) {
    log.warn(`POST ${path} с чужим Origin ${req.headers.origin} (Host ${req.headers.host}) от ${ipLabel(clientIp(req))}`);
    return send(res, 403, 'Forbidden');
  }

  // --- публичные маршруты ---
  if (path === '/login' && method === 'GET') return serveFile(res, 'login.html');
  if (path === '/login' && method === 'POST') return handleLogin(req, res);
  if (path === '/logout' && method === 'POST') return handleLogout(req, res);
  if (path === '/healthz') return sendJson(res, 200, { ok: true });
  // Отчёты браузера о нарушениях CSP — в лог, без входа (их шлёт сам браузер,
  // cookie при этом может и не быть). Не больше строки в секунду: иначе
  // кто угодно мог бы забить лог веба мусором.
  if (path === '/csp-report' && method === 'POST') {
    const line = formatCspReport(await readBody(req, 8 * 1024));
    if (line && Date.now() - lastCspLog > 1000) { lastCspLog = Date.now(); log.warn(`${line} (клиент ${ipLabel(clientIp(req))})`); }
    return send(res, 204, '');
  }

  const user = currentUser(req);

  // --- API (требует сессию) ---
  if (path === '/api/status') {
    if (!user) return sendJson(res, 401, { error: 'требуется вход' });
    try {
      return sendJson(res, 200, buildStatus());
    } catch (e) {
      log.error(`status: ${e.message}`);
      return sendJson(res, 500, { error: 'ошибка чтения статуса' });
    }
  }

  if (path === '/api/me') {
    if (!user) return sendJson(res, 401, { error: 'требуется вход' });
    return sendJson(res, 200, { username: user.username, role: user.role });
  }

  // ─── ВРЕМЕННЫЙ РЕДАКТОР РАССТАНОВКИ (удалить после расстановки камер) ───
  // Сохранение позиции камеры на карте. Только admin: обычный зритель карту не
  // правит. Пишет state/camera-points.json (см. server/camera-points.js).
  if (path === '/api/camera-position' && method === 'POST') {
    if (!user) return sendJson(res, 401, { error: 'требуется вход' });
    if (user.role !== 'admin') return sendJson(res, 403, { error: 'нужны права администратора' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'битый JSON' }); }
    const key = String(body.key || '');
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    if (!key || !isKnownCamera(key)) return sendJson(res, 400, { error: 'неизвестная камера' });
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return sendJson(res, 400, { error: 'некорректные координаты' });
    }
    try {
      const point = saveCameraPoint(key, lat, lon);
      log.info(`Позиция камеры сохранена: ${key}`);
      return sendJson(res, 200, { ok: true, point });
    } catch (e) {
      log.error(`camera-position: ${e.message}`);
      return sendJson(res, 500, { error: 'не удалось сохранить' });
    }
  }
  // ─── /ВРЕМЕННЫЙ РЕДАКТОР ───

  // ─── Устройства на карте (не камеры) ───
  // Хабы, регистраторы, коммутаторы и прочее железо. Мониторинг их не
  // опрашивает, отметки ставит админ прямо на карте — отсюда две ручки на
  // запись. Только admin: зритель карту не правит. В отличие от редактора
  // расстановки камер, это ПОСТОЯННАЯ часть интерфейса.
  if (path === '/api/device' && method === 'POST') {
    if (!user) return sendJson(res, 401, { error: 'требуется вход' });
    if (user.role !== 'admin') return sendJson(res, 403, { error: 'нужны права администратора' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'битый JSON' }); }
    try {
      const device = saveDevice(body, { systemIds: knownSystemIds() });
      log.info(`Устройство сохранено: ${device.type} «${device.name}»`);
      return sendJson(res, 200, { ok: true, device });
    } catch (e) {
      // Текст ошибки нормализации человеческий — показываем его админу как есть.
      log.warn(`device: ${e.message}`);
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (path === '/api/device-delete' && method === 'POST') {
    if (!user) return sendJson(res, 401, { error: 'требуется вход' });
    if (user.role !== 'admin') return sendJson(res, 403, { error: 'нужны права администратора' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'битый JSON' }); }
    const id = String(body.id || '');
    if (!id) return sendJson(res, 400, { error: 'нужен id устройства' });
    try {
      const removed = deleteDevice(id);
      if (removed) {
        // Вместе с устройством уходят и его фото — иначе файлы копились бы вечно.
        for (const f of removed.photos || []) deletePhotoFile(f);
        log.info(`Устройство удалено: ${id}`);
      }
      return sendJson(res, 200, { ok: true, removed: !!removed });
    } catch (e) {
      log.error(`device-delete: ${e.message}`);
      return sendJson(res, 500, { error: 'не удалось удалить' });
    }
  }

  // ─── Фото устройств (v3.9) ───
  // Файл отдаём только по паре «устройство + имя из его списка»: имя с клиента
  // в путь не попадает, путь строит device-photos.js по своему шаблону.
  if (path === '/api/device-photo' && method === 'GET') {
    if (!user) return send(res, 401, 'требуется вход');
    const id = url.searchParams.get('id') || '';
    const f = safePhotoName(url.searchParams.get('f'));
    const dev = readDevices().find((d) => d.id === id);
    if (!dev || !f || !(dev.photos || []).includes(f)) return send(res, 404, 'фото нет');
    try {
      const data = await readFile(photoPath(f));
      // Имя файла уникально и не переиспользуется — кэшировать безопасно.
      head(res, 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
      return res.end(data);
    } catch (e) {
      log.error(`device-photo: ${e.message}`);
      return send(res, 404, 'фото нет');
    }
  }

  // Загрузка: тело запроса — сырой JPEG (не multipart: одна картинка, разбирать
  // формы незачем). Только admin, до MAX_UPLOAD_BYTES, всё перекодируется ffmpeg.
  if (path === '/api/device-photo' && method === 'POST') {
    if (!user) return sendJson(res, 401, { error: 'требуется вход' });
    if (user.role !== 'admin') return sendJson(res, 403, { error: 'нужны права администратора' });
    const id = url.searchParams.get('id') || '';
    if (!readDevices().some((d) => d.id === id)) return sendJson(res, 404, { error: 'устройство не найдено' });
    const buf = await readBodyBytes(req, MAX_UPLOAD_BYTES);
    let name;
    try {
      name = await storePhotoFromBuffer(id, buf);
    } catch (e) {
      log.warn(`device-photo upload: ${e.message}`);
      return sendJson(res, 400, { error: e.message.startsWith('это не JPEG') ? 'нужен файл JPEG' : 'не удалось обработать фото' });
    }
    try {
      const device = addDevicePhoto(id, name);
      log.info(`Фото добавлено: ${device.name} ← ${name}`);
      return sendJson(res, 200, { ok: true, device });
    } catch (e) {
      deletePhotoFile(name);                 // запись не обновилась — файл не нужен
      log.warn(`device-photo: ${e.message}`);
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (path === '/api/device-photo-delete' && method === 'POST') {
    if (!user) return sendJson(res, 401, { error: 'требуется вход' });
    if (user.role !== 'admin') return sendJson(res, 403, { error: 'нужны права администратора' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'битый JSON' }); }
    const id = String(body.id || '');
    const f = safePhotoName(body.f);
    if (!id || !f) return sendJson(res, 400, { error: 'нужны id устройства и имя фото' });
    try {
      const device = removeDevicePhoto(id, f);
      if (!device) return sendJson(res, 404, { error: 'устройство не найдено' });
      deletePhotoFile(f);
      log.info(`Фото удалено: ${device.name} — ${f}`);
      return sendJson(res, 200, { ok: true, device });
    } catch (e) {
      log.error(`device-photo-delete: ${e.message}`);
      return sendJson(res, 500, { error: 'не удалось удалить фото' });
    }
  }
  // ─── /Фото устройств ───
  // ─── /Устройства ───

  if (path === '/api/camera') {
    if (!user) return sendJson(res, 401, { error: 'требуется вход' });
    const camKey = url.searchParams.get('key');
    if (!camKey) return sendJson(res, 400, { error: 'нужен параметр key' });
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') || 30)));
    try {
      const detail = buildCameraDetail(camKey, { days });
      if (!detail) return sendJson(res, 404, { error: 'камера не найдена' });
      return sendJson(res, 200, detail);
    } catch (e) {
      log.error(`camera: ${e.message}`);
      return sendJson(res, 500, { error: 'ошибка чтения карточки' });
    }
  }

  // Снимок камеры из кэша last-good. Путь к файлу собирает сервер по cam_key —
  // произвольные пути с клиента сюда не приходят.
  if (path === '/api/snapshot') {
    if (!user) return send(res, 401, 'требуется вход');
    const camKey = url.searchParams.get('key');
    if (!camKey) return send(res, 400, 'нужен параметр key');
    try {
      const file = snapshotPathFor(camKey);
      if (!file) return send(res, 404, 'снимка нет');
      const data = await readFile(file);
      head(res, 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
      return res.end(data);
    } catch (e) {
      log.error(`snapshot: ${e.message}`);
      return send(res, 500, 'ошибка чтения снимка');
    }
  }

  // --- страницы и статика (требуют сессию) ---
  if (!user) {
    // Странице логина нужны свой css и скрипт (inline запрещён CSP) — пускаем
    // только их, остальное за вход.
    if (path === '/styles.css' || path === '/login.js') return serveStatic(res, path);
    return send(res, 303, '', { Location: '/login' });
  }

  if (path === '/' || path === '/index.html') return serveFile(res, 'index.html');
  if (path === '/config.js') {
    head(res, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(configJs());
  }
  if (method === 'GET') return serveStatic(res, path);

  send(res, 404, 'Not Found');
}

const server = createServer((req, res) => {
  router(req, res).catch((e) => {
    if (e instanceof BodyTooLarge) {
      if (!res.headersSent) send(res, 413, 'Payload Too Large');
      return;
    }
    log.error(`Необработанная ошибка запроса ${req.method} ${req.url}: ${e.message}`);
    if (!res.headersSent) send(res, 500, 'Internal Server Error');
  });
});

server.listen(config.web.port, config.web.host, () => {
  log.info(`Веб-карта слушает http://${config.web.host}:${config.web.port} (группа: ${config.group}, CSP: ${config.web.csp}, прокси: ${[...config.web.trustedProxies].join(', ') || 'нет'}, публичные origin: ${config.web.publicOrigins.join(', ') || 'нет'})`);
  if (!config.map.yandexApiKey) log.warn('YANDEX_API_KEY не задан в .env — карта не загрузится (список камер работает)');
  if (!webDb.listUsers().length) log.warn('Нет ни одной учётки — создайте: node server/add-user.js <логин> <пароль> admin');
});

function shutdown() {
  log.info('Остановка веб-сервера');
  server.close(() => { webDb.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
