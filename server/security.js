/**
 * security.js — защитная обвязка веб-сервера (аудит 16.09.2026).
 *
 * Всё, что здесь, — чистая логика без ввода-вывода, чтобы её проверяли тесты
 * и мог переиспользовать отладочный экземпляр. Сам сервер (app.js) только
 * вызывает эти функции.
 *
 *   • LoginThrottle — ограничение попыток входа. Без него подбор пароля шёл
 *     со скоростью scrypt (~10 попыток/с), а заодно грел единственное ядро ВМ.
 *   • securityHeaders — заголовки браузеру: не угадывать тип файла, не
 *     встраивать страницу в чужой iframe, не отдавать URL лишним, и CSP —
 *     скрипты только свои и Яндекс-карт.
 *   • scrubSensitive — чистка текста причин статуса от внутренних IP, путей и
 *     URL: чекеры пишут туда «connect ECONNREFUSED 10.x.x.x:554», а карта
 *     не должна быть картой сети заказчика.
 *   • publicPathFor — путь к файлу статики строго внутри public/.
 */
import { resolve, sep } from 'node:path';

// ── Ограничение попыток входа ────────────────────────────────────────────────
// Считаем неудачи отдельно по адресу клиента и по логину. По адресу — против
// перебора с одной машины; по логину — против распределённого перебора
// одного известного имени (порог выше, чтобы чужие неудачи не так легко
// запирали настоящего пользователя).
export const THROTTLE = {
  windowMs: 15 * 60 * 1000,  // окно, в котором копятся неудачи
  blockMs: 15 * 60 * 1000,   // на сколько запираем после превышения
  maxPerIp: 5,
  maxPerUser: 20,
};

export class LoginThrottle {
  constructor(opts = {}, now = () => Date.now()) {
    this.opts = { ...THROTTLE, ...opts };
    this.now = now;
    this.byIp = new Map();     // ip → { fails: [ts...], blockedUntil }
    this.byUser = new Map();
  }

  _entry(map, key) {
    let e = map.get(key);
    if (!e) { e = { fails: [], blockedUntil: 0 }; map.set(key, e); }
    return e;
  }

  _prune(e, now) {
    e.fails = e.fails.filter((t) => now - t < this.opts.windowMs);
  }

  /**
   * Можно ли пробовать войти. { ok: true } или { ok: false, retryAfterSec }.
   * Проверять ДО scrypt — заблокированная попытка не должна стоить процессора.
   */
  check(ip, username) {
    const now = this.now();
    let until = 0;
    for (const [map, key] of [[this.byIp, ip], [this.byUser, username]]) {
      if (!key) continue;
      const e = map.get(key);
      if (e && e.blockedUntil > now) until = Math.max(until, e.blockedUntil);
    }
    return until ? { ok: false, retryAfterSec: Math.ceil((until - now) / 1000) } : { ok: true };
  }

  /** Неудачный вход: копим и, если превысили, запираем. Возвращает, заперли ли. */
  fail(ip, username) {
    const now = this.now();
    let blocked = false;
    for (const [map, key, max] of [[this.byIp, ip, this.opts.maxPerIp], [this.byUser, username, this.opts.maxPerUser]]) {
      if (!key) continue;
      const e = this._entry(map, key);
      this._prune(e, now);
      e.fails.push(now);
      if (e.fails.length >= max) {
        e.blockedUntil = now + this.opts.blockMs;
        e.fails = [];
        blocked = true;
      }
    }
    return blocked;
  }

  /** Успешный вход снимает счётчики: человек просто опечатался. */
  success(ip, username) {
    this.byIp.delete(ip);
    if (username) this.byUser.delete(username);
  }

  /** Раз в час выбрасываем всё, что уже не действует, — иначе карта растёт. */
  purge() {
    const now = this.now();
    for (const map of [this.byIp, this.byUser]) {
      for (const [k, e] of map) {
        this._prune(e, now);
        if (!e.fails.length && e.blockedUntil <= now) map.delete(k);
      }
    }
  }
}

// ── Заголовки ────────────────────────────────────────────────────────────────
// CSP: скрипты — только свои и Яндекс-карт (никаких inline и eval), стили —
// свои и inline (Яндекс красит карту инлайн-стилями, без 'unsafe-inline' она не
// рисуется), картинки — свои, data: (значки устройств) и тайлы Яндекса.
// Домены Яндекса даны широко (*.yandex.ru / *.yandex.net / yastatic.net):
// API грузит модули и тайлы с десятка поддоменов, и точный список — это
// поломка карты при первой же смене их CDN. Защита от XSS от этого не
// страдает: чужой домен и inline-скрипт всё равно запрещены.
const YANDEX = 'https://*.yandex.ru https://*.yandex.net https://yastatic.net';

export const CSP = [
  "default-src 'self'",
  `script-src 'self' ${YANDEX}`,
  `style-src 'self' 'unsafe-inline' ${YANDEX}`,
  `img-src 'self' data: blob: ${YANDEX}`,
  `connect-src 'self' ${YANDEX}`,
  `font-src 'self' data: ${YANDEX}`,
  `frame-src ${YANDEX}`,
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Нарушения браузер шлёт сюда — сервер пишет их в лог веба.
  'report-uri /csp-report',
].join('; ');

/**
 * Режим CSP: 'report' — только докладывать (Content-Security-Policy-Report-Only),
 * 'enforce' — блокировать, 'off' — не слать. По умолчанию report: отрисовку
 * карты под CSP вживую проверить нельзя (ключ Яндекса ограничен по домену,
 * на 127.0.0.1 он не работает), а сломать карту у всех ради заголовка —
 * плохая сделка. Пожили в report, лог чист — переключаем на enforce в .env.
 */
export function cspHeader(mode = 'report') {
  if (mode === 'off') return {};
  return mode === 'enforce'
    ? { 'Content-Security-Policy': CSP }
    : { 'Content-Security-Policy-Report-Only': CSP };
}

/** Заголовки, которые ставим на КАЖДЫЙ ответ. */
export function securityHeaders(cspMode = 'report') {
  return {
    ...cspHeader(cspMode),
    'X-Content-Type-Options': 'nosniff',
    // SAMEORIGIN, а не DENY: этап 4 предполагает публикацию внутри сети
    // заказчика, и встраивание в свой же портал ломать не хочется.
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Геолокация нужна кнопке «моё местоположение» на карте — только себе.
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
  };
}

// ── Чистка чувствительного из текста ─────────────────────────────────────────
// Чекеры пишут в причину статуса то, что удобно инженеру в письме: IP NVR,
// UNC-путь шары, URL. Для веба это лишнее — по причине «нет связи» и так всё
// понятно, а адрес превращает карту камер в карту сети.
const SENSITIVE = [
  /\b(?:rtsp|https?|ftp|smb):\/\/\S+/gi,               // URL с адресом внутри
  /\\\\[^\s\\]+(?:\\[^\s\\]*)*/g,                       // \\host\share\...
  /\b[A-Za-z]:\\[^\s]*/g,                               // C:\путь
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g,          // IPv4[:порт]
];

export function scrubSensitive(text) {
  let s = String(text ?? '');
  for (const re of SENSITIVE) s = s.replace(re, '<адрес скрыт>');
  // Схлопываем пустые скобки, оставшиеся после вырезания: «(<адрес скрыт>)»
  // читается нормально, а вот «( )» — нет.
  return s.replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
}

// ── Статика ──────────────────────────────────────────────────────────────────
/**
 * Абсолютный путь к файлу статики или null, если запрос выводит за public/.
 * Сравниваем с разделителем на конце: без него `public2/` прошёл бы как
 * «начинается с public».
 */
export function publicPathFor(urlPath, publicDir) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  if (p.includes('\0')) return null;
  const root = resolve(publicDir);
  const full = resolve(root, '.' + sep + p.replace(/^[/\\]+/, ''));
  if (full === root) return null;                       // сам каталог — не файл
  return full.startsWith(root + sep) ? full : null;
}

/**
 * Одна строка лога из отчёта CSP браузера. Формат отчёта — { "csp-report":
 * { "document-uri", "violated-directive", "blocked-uri", ... } }. Берём три
 * поля и режем длину: в лог должно попасть «что и где», а не весь JSON.
 */
export function formatCspReport(body) {
  let r;
  try { r = JSON.parse(body); } catch { return null; }
  r = r && (r['csp-report'] || r);
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const pick = (k) => String(r[k] ?? '').slice(0, 200);
  const directive = pick('violated-directive') || pick('effective-directive');
  if (!directive) return null;                          // не отчёт CSP, а что-то постороннее
  return `CSP: ${directive} заблокировал ${pick('blocked-uri') || '?'} на ${pick('document-uri') || '?'}`;
}

/**
 * Проверка Origin у POST-запросов — страховка от CSRF поверх SameSite=Lax:
 * браузер шлёт Origin на любой POST, и чужой сайт подделать его не может.
 * Без заголовка (curl, старые клиенты) — пропускаем: cookie у них всё равно
 * нет, а ломать честные запросы незачем. «null» (песочница, file://) —
 * отказ: своих форм оттуда не бывает.
 *
 * За обратным прокси Host на сервере — адрес ВМ, а Origin в браузере —
 * публичный адрес сайта; они не совпадут никогда. Поэтому вторая проверка —
 * список публичных адресов из .env (WEB_PUBLIC_ORIGINS). Именно список, а не
 * доверие X-Forwarded-Host: заголовок подставит любой клиент из локальной
 * сети, а строку в .env — только администратор.
 */
export function originAllowed(originHeader, hostHeader, publicOrigins = []) {
  if (!originHeader) return true;
  let u;
  try { u = new URL(originHeader); } catch { return false; }
  if (u.host === String(hostHeader || '')) return true;
  return publicOrigins.includes(normalizeOrigin(originHeader));
}

/** «https://Site.example:8081/» → «https://site.example:8081» — чтобы сравнивать строками. */
export function normalizeOrigin(s) {
  try { return new URL(String(s)).origin.toLowerCase(); } catch { return ''; }
}

/**
 * Адрес клиента для лога и лимита попыток. Обычно — адрес сокета. Если запрос
 * пришёл от доверенного прокси (WEB_TRUSTED_PROXIES) и тот прислал
 * X-Forwarded-For, берём из цепочки крайний справа адрес, который не прокси:
 * это тот, кто действительно постучался. Прокси без X-Forwarded-For —
 * возвращаем null: считать всех его клиентов одним адресом нельзя, иначе пять
 * чужих ошибок заперли бы вход всем (лимит тогда работает только по логину).
 * От недоверенного адреса X-Forwarded-For не читаем — его пишет кто угодно.
 */
export function clientIpFrom(socketIp, forwardedFor, trustedProxies = new Set()) {
  const sock = String(socketIp || '');
  if (!trustedProxies.has(sock)) return sock;
  const chain = String(forwardedFor || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!trustedProxies.has(chain[i])) return chain[i];
  }
  return null;
}
