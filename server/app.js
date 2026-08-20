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
import { join, normalize, extname } from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';
import { openWebDb } from './web-db.js';
import { login } from './auth.js';
import { buildStatus, buildCameraDetail, snapshotPathFor, isKnownCamera } from './status.js';
import { saveCameraPoint } from './camera-points.js';

const webDb = openWebDb();
// Раз в час подчищаем протухшие сессии.
setInterval(() => {
  try { webDb.purgeExpiredSessions(); } catch (e) { log.warn(`очистка сессий: ${e.message}`); }
}, 3600 * 1000).unref();

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

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

async function readBody(req, limit = 1 << 16) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('тело запроса слишком большое');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(res, urlPath) {
  // Защита от выхода за пределы public/.
  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const filePath = join(config.publicDir, rel);
  if (!filePath.startsWith(config.publicDir)) return send(res, 403, 'Forbidden');
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) return send(res, 403, 'Forbidden');
    const data = await readFile(filePath);
    res.writeHead(200, {
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
    res.writeHead(status, {
      'Content-Type': MIME[extname(name).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    send(res, 500, 'Не найден файл интерфейса: ' + name);
  }
}

async function handleLogin(req, res) {
  const form = new URLSearchParams(await readBody(req));
  const username = (form.get('username') || '').trim();
  const password = form.get('password') || '';
  const result = username && password ? login(webDb, username, password) : null;
  if (!result) {
    log.warn(`Неудачный вход: ${username || '(пусто)'}`);
    return send(res, 303, '', { Location: '/login?e=1' });
  }
  log.info(`Вход: ${result.username}`);
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
  })};\n`;
}

async function router(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  // --- публичные маршруты ---
  if (path === '/login' && method === 'GET') return serveFile(res, 'login.html');
  if (path === '/login' && method === 'POST') return handleLogin(req, res);
  if (path === '/logout' && method === 'POST') return handleLogout(req, res);
  if (path === '/healthz') return sendJson(res, 200, { ok: true });

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
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
      return res.end(data);
    } catch (e) {
      log.error(`snapshot: ${e.message}`);
      return send(res, 500, 'ошибка чтения снимка');
    }
  }

  // --- страницы и статика (требуют сессию) ---
  if (!user) {
    // Странице логина нужен свой css — пускаем только его, остальное за вход.
    if (path === '/styles.css') return serveStatic(res, path);
    return send(res, 303, '', { Location: '/login' });
  }

  if (path === '/' || path === '/index.html') return serveFile(res, 'index.html');
  if (path === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(configJs());
  }
  if (method === 'GET') return serveStatic(res, path);

  send(res, 404, 'Not Found');
}

const server = createServer((req, res) => {
  router(req, res).catch((e) => {
    log.error(`Необработанная ошибка запроса ${req.method} ${req.url}: ${e.message}`);
    if (!res.headersSent) send(res, 500, 'Internal Server Error');
  });
});

server.listen(config.web.port, config.web.host, () => {
  log.info(`Веб-карта слушает http://${config.web.host}:${config.web.port} (группа: ${config.group})`);
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
