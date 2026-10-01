/**
 * config.js — настройки веб-интерфейса (v3). Читаются из .env, в коде не зашиты.
 * Секретов здесь нет: всё, что уходит во фронт (ключ Yandex Maps JS API — он
 * и так виден в браузере), в репозиторий не хардкодится.
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

/** Список через запятую из .env → массив без пустот и лишних пробелов. */
export const parseList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  root: ROOT,
  publicDir: join(ROOT, 'public'),
  webDbPath: join(ROOT, 'state', 'web.db'),
  logDir: join(ROOT, 'logs'),

  // Какую группу объектов показывать на карте (имя группы — как в
  // config/systems.json). Пусто — показываем все: карта нужна не для всех
  // групп сразу, удалённые объекты на неё обычно не выносят.
  group: process.env.WEB_GROUP || '',

  siteName: process.env.WEB_SITE_NAME || 'Мониторинг видеонаблюдения',

  web: {
    host: process.env.WEB_HOST || '127.0.0.1',
    port: num(process.env.WEB_PORT, 8080),
    sessionTtlHours: num(process.env.WEB_SESSION_TTL_HOURS, 12),
    secureCookie: String(process.env.WEB_SECURE_COOKIE || '').toLowerCase() === 'true',
    // Режим Content-Security-Policy: report (по умолчанию) | enforce | off —
    // см. server/security.js → cspHeader.
    csp: ['report', 'enforce', 'off'].includes(String(process.env.WEB_CSP || '').toLowerCase())
      ? String(process.env.WEB_CSP).toLowerCase() : 'report',
    // Обратный прокси перед сервером (адреса через запятую): только от них
    // читаем X-Forwarded-For. Публичные адреса сайта (origin с портом) — для
    // проверки Origin у POST: за прокси Host на сервере не совпадает с тем,
    // что видит браузер. Пусто — прокси нет, всё как раньше.
    trustedProxies: new Set(parseList(process.env.WEB_TRUSTED_PROXIES)),
    publicOrigins: parseList(process.env.WEB_PUBLIC_ORIGINS)
      .map((s) => { try { return new URL(s).origin.toLowerCase(); } catch { return ''; } })
      .filter(Boolean),
  },

  // Данные старше этого — «устарели»: light-прогон ходит раз в 15 минут,
  // поэтому 40 минут молчания уже означают, что мониторинг встал.
  staleAfterSec: num(process.env.WEB_STALE_AFTER_SEC, 40 * 60),

  // Карта — Yandex Maps JS API. Ключ виден в браузере (норма для JS API), но в
  // репозиторий не хардкодим — берём из .env и инжектим во фронт через
  // /config.js. Ключ обязательно ограничить по домену-referer в кабинете Яндекса.
  map: {
    yandexApiKey: (process.env.YANDEX_API_KEY || '').trim(),
    // Центр/зум по умолчанию — пока у камер нет координат. Реальный центр
    // площадки задаётся в .env (MAP_CENTER_*): координаты объекта заказчика в
    // репозиторий не кладём (как и geo.txt). Дефолт здесь нейтральный.
    center: [num(process.env.MAP_CENTER_LAT, 55.751), num(process.env.MAP_CENTER_LON, 37.618)],
    zoom: num(process.env.MAP_ZOOM, 18),
    // Подложка: гибрид (спутник + подписи) удобнее всего для расстановки камер.
    // Требует покрытия и платного тарифа ключа; при недоступности — yandex#map.
    type: process.env.MAP_TYPE || 'yandex#hybrid',
    // Камеры каких объектов показывать на карте — список id через запятую
    // (WEB_MAP_SYSTEMS). Старое имя WEB_MAP_SYSTEM (ровно один объект) читаем
    // как запасное: .env на боевой машине правят руками, ломать его нельзя.
    systems: parseList(process.env.WEB_MAP_SYSTEMS || process.env.WEB_MAP_SYSTEM || 'trassir'),
  },

  // Камеры второго этажа (`<sysId>|<имя>` через запятую). Всё, чего нет
  // в списке, — первый этаж: второй этаж бывает у одного-двух объектов,
  // перечислять ради этого все камеры бессмысленно. Нужно там, где на одной
  // площадке стоят несколько объектов и точки ложатся кучей.
  floor2: new Set(parseList(process.env.WEB_FLOOR2_CAMERAS)),

  // Камеры, которых на карте быть не должно. Это заглушки, застрявшие в
  // monitor.db: при полном сбое ISAPI-опроса прогон записывает безымянную
  // камеру, БД даёт ей имя вида «Камера 1», и она навсегда остаётся на карте
  // как «нет данных». Здесь мы её просто не показываем; чинить сам источник
  // (src/index.js, src/timeline.js) — отдельная задача вне веба.
  hideCameras: new Set(parseList(process.env.WEB_HIDE_CAMERAS)),

  // ffmpeg — тот же, что у прогонов (FFMPEG_PATH): вебу он нужен, чтобы
  // уменьшать фотографии устройств (v3.9). Пусто — берём из PATH.
  ffmpegPath: (process.env.FFMPEG_PATH || '').trim(),
};
