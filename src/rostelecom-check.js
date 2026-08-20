/**
 * rostelecom-check.js — Проверка камер Ростелеком.
 *
 * Стратегия:
 *   1. Авторизуемся на портале lk-b2b.camera.rt.ru через passport.rt.ru
 *   2. Получаем статусы камер из API /api/v4/user/dashboard.json
 *   3. Если портал недоступен — откатываемся на ping (только через VPN)
 *
 * Особенности passport.rt.ru:
 *   - Поля формы видимы визуально, но Playwright считает их невидимыми
 *   - Заполняем через JS (nativeInputValueSetter) чтобы React подхватил значения
 */

import { chromium } from 'playwright';
import { exec } from 'child_process';
import * as log from './logger.js';

const PORTAL_TIMEOUT = 40_000;  // макс. время на загрузку страницы
const LOGIN_TIMEOUT  = 30_000;  // макс. время на авторизацию
const API_WAIT       = 15_000;  // макс. время ожидания ответа API
const PING_TIMEOUT   = 3000;
const DEFAULT_RETRIES = 3;      // кол-во попыток входа на портал

// ─── Ping-проверка (запасной вариант, работает только через VPN) ──────────────

function pingHost(ip, timeoutMs = PING_TIMEOUT) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? `ping -n 1 -w ${timeoutMs} ${ip}`
      : `ping -c 1 -W ${Math.ceil(timeoutMs / 1000)} ${ip}`;
    exec(cmd, { timeout: timeoutMs + 2000 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(/TTL=|ttl=|1 received/i.test(stdout));
    });
  });
}

async function checkByPing(cameras, systemId) {
  log.info(`${systemId}:ping`, 'Откат на ping-проверку', { count: cameras.length });
  const results = [];
  for (const cam of cameras) {
    if (!cam.ip) {
      results.push({
        index: cam.index ?? results.length,
        id: (cam.index ?? results.length) + 1,
        name: cam.name || `Камера ${results.length + 1}`,
        online: null, recording: 'unknown', audio: 'unknown',
        notes: 'Нет IP для ping',
      });
      continue;
    }
    const alive = await pingHost(cam.ip);
    results.push({
      index: cam.index ?? results.length,
      id: (cam.index ?? results.length) + 1,
      name: cam.name || `Камера ${results.length + 1}`,
      online: alive, recording: 'unknown', audio: 'unknown',
      type: 'ping', ip: cam.ip,
      notes: alive ? `Online (ping ${cam.ip})` : `Не отвечает на ping (${cam.ip}). IP доступен только через VPN.`,
    });
  }
  return results;
}

// ─── Заполнение поля через JS (обход невидимости для Playwright) ──────────────

async function jsSetInput(page, selector, value) {
  await page.evaluate(({ sel, val }) => {
    const inp = document.querySelector(sel);
    if (!inp) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, val);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel: selector, val: value });
}

// ─── Проверка через портал RT ────────────────────────────────────────────────

async function checkViaPortal({ portalUrl, user, pass, systemId }) {
  const step = `${systemId}:rt-portal`;
  log.info(step, 'Попытка проверки через портал РТ', { url: portalUrl });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    // Перехватываем ответ API дашборда
    let dashboardData = null;
    page.on('response', async (resp) => {
      try {
        if (resp.url().includes('/api/v4/user/dashboard.json') && resp.status() === 200) {
          dashboardData = await resp.json();
          log.info(step, 'API dashboard перехвачен', { total: dashboardData?.total });
        }
      } catch { /* ошибка парсинга */ }
    });

    // Шаг 1: Переходим на портал
    log.info(step, 'Навигация на портал...');
    try {
      await page.goto(`${portalUrl}/main/cameras`, {
        waitUntil: 'domcontentloaded',
        timeout: PORTAL_TIMEOUT,
      });
    } catch {
      const url = page.url();
      if (url === 'about:blank' || url.includes('chrome-error')) {
        throw new Error('Портал недоступен (таймаут соединения)');
      }
      log.warn(step, 'Таймаут загрузки, но страница частично загружена');
    }

    // Шаг 2: Ждём редирект на passport.rt.ru
    try {
      await page.waitForURL('**/passport.rt.ru/**', { timeout: LOGIN_TIMEOUT });
      log.info(step, 'Редирект на passport.rt.ru');
    } catch {
      if (dashboardData) {
        log.info(step, 'Уже авторизован, данные получены');
      } else {
        throw new Error('Не произошёл редирект на страницу авторизации');
      }
    }

    // Шаг 3: Авторизация
    if (!dashboardData) {
      // Ждём полной загрузки страницы passport (JS-форма рендерится медленно)
      try {
        await page.waitForLoadState('load', { timeout: 30_000 });
      } catch {
        log.warn(step, 'Таймаут загрузки passport, пробуем найти форму...');
      }

      // Ждём input#username или любой input (форма может долго рендериться)
      try {
        await page.waitForSelector('input#username, input[type="text"]', {
          state: 'attached', timeout: 20_000,
        });
      } catch {
        throw new Error('Форма авторизации не загрузилась');
      }

      // Небольшая пауза чтобы React-форма полностью отрендерилась
      await page.waitForTimeout(2000);

      // Заполняем логин (input#username) через JS — Playwright не видит поле
      log.info(step, 'Заполняю форму авторизации...');
      await jsSetInput(page, 'input#username', user);
      await jsSetInput(page, 'input#password', pass);

      // Кликаем «Войти»
      await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent.trim() === 'Войти') { btn.click(); return; }
        }
        const form = document.querySelector('form');
        if (form) form.submit();
      });
      log.info(step, 'Форма отправлена, ожидание авторизации...');

      // Ждём возврат на портал
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(2000);
        const u = page.url();
        if (u.includes('camera.rt.ru') && !u.includes('passport')) {
          log.info(step, 'Авторизация успешна');
          break;
        }
        if (dashboardData) break;
      }
    }

    // Шаг 4: Ждём данные
    if (!dashboardData) {
      log.info(step, 'Ожидание данных камер...');
      const startWait = Date.now();
      while (!dashboardData && (Date.now() - startWait) < API_WAIT) {
        await page.waitForTimeout(1000);
      }
    }

    // Шаг 5: Прямой запрос если перехватчик не сработал
    if (!dashboardData) {
      log.info(step, 'Прямой запрос к API...');
      try {
        dashboardData = await page.evaluate(async () => {
          const r = await fetch('/api/v4/user/dashboard.json?limit=50&offset=0&with_total_count=false&dvr_mode=true');
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        });
      } catch (e) {
        log.warn(step, 'Прямой API-запрос не удался', { error: e.message });
      }
    }

    await browser.close();
    browser = null;

    if (!dashboardData?.dashboard) {
      throw new Error('API портала не вернул данные камер');
    }

    const apiCams = dashboardData.dashboard;
    log.info(step, 'Данные получены', { total: apiCams.length });

    // Имена камер API по порядку. Маппинг на config/systems.json идёт ПО ПОРЯДКУ
    // (i-я камера API → i-я камера конфига), поэтому при добавлении или удалении
    // камеры на портале позицию в конфиге иначе пришлось бы угадывать, а ошибка
    // тихо сдвинула бы статусы всех последующих камер.
    log.debug(step, 'Камеры API по порядку', {
      list: apiCams.map((c, i) => `${i}:${c.name || '?'}(${c.status || '?'}) uid=${c.uid || '-'}`).join(' | '),
    });

    // Возвращаем сырые данные API — маппинг на конфиг делается в основной функции
    return apiCams;

  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

// ─── Основная функция проверки ───────────────────────────────────────────────

/**
 * Маппит камеры API на конфигурацию: использует имена из конфига,
 * исключает неиспользуемые камеры по паттернам excludeApiNames.
 *
 * Сопоставление идёт по `rtUid` — это `uid` камеры на портале, он не зависит от
 * порядка выдачи и переживает добавление/удаление камер в личном кабинете.
 * Раньше маппили СТРОГО ПО ПОРЯДКУ (i-я камера API → i-я камера конфига), и
 * любая перестановка на портале молча сдвигала статусы всех последующих камер:
 * оператор получал заявки не на те объекты и не мог этого заметить. Порядок
 * оставлен запасным вариантом для камер, которым `rtUid` ещё не проставили.
 *
 * Камера с заданным `rtUid`, которой нет в выдаче портала, помечается «нет
 * данных»: подставить вместо неё соседнюю по порядку — та же тихая подмена,
 * от которой уходим. Честный пробел лучше правдоподобного вранья.
 */
export function mapApiToConfig(apiCams, configCameras, excludeApiNames = [], step = '') {
  // Фильтруем неиспользуемые камеры (по подстроке в имени API)
  const filtered = apiCams.filter((cam) => {
    const apiName = cam.name || '';
    return !excludeApiNames.some((pattern) => apiName.includes(pattern));
  });

  const byUid = new Map();
  for (const cam of filtered) {
    if (cam.uid) byUid.set(String(cam.uid), cam);
  }

  // `rtUid` в systems.json — плейсхолдер `${..._UID}`, который разворачивает
  // config-loader из .env. Если переменную забыли задать, загрузчик оставляет
  // плейсхолдер как есть (и пишет warn). Такой «uid» за настоящий не принимаем:
  // иначе одна забытая строка в .env увела бы ВСЕ камеры в «нет данных». Лучше
  // откатиться на сопоставление по порядку — прежнее рабочее поведение.
  const uidOf = (cfgCam) => {
    const v = cfgCam.rtUid;
    if (!v || String(v).includes('${')) return null;
    return String(v);
  };

  // Отмечаем сопоставленные объекты по ссылке: так одна камера портала не
  // достанется двум записям конфига и видно, какие камеры остались лишними.
  const matched = new Set();
  const stats = { uid: 0, order: 0, missing: 0 };

  const result = configCameras.map((cfgCam, i) => {
    let apiCam = null;
    const wantUid = uidOf(cfgCam);

    if (wantUid) {
      apiCam = byUid.get(wantUid) || null;
      if (apiCam) stats.uid++;
    } else {
      // Старое поведение — по позиции. Позицию, уже занятую камерой с uid,
      // не забираем (это возможно, только пока uid проставлены не всем).
      const candidate = filtered[i] || null;
      apiCam = candidate && !matched.has(candidate) ? candidate : null;
      if (apiCam) stats.order++;
    }

    if (!apiCam) {
      stats.missing++;
      return {
        index: cfgCam.index,
        id: cfgCam.index + 1,
        name: cfgCam.name,
        online: null,
        recording: 'unknown',
        audio: 'unknown',
        type: 'rt-portal',
        notes: wantUid
          ? `Нет данных из API (камеры uid=${wantUid} нет на портале)`
          : 'Нет данных из API (камера не найдена)',
      };
    }
    matched.add(apiCam);

    const isOnline = apiCam.status === 'ok';
    return {
      index: cfgCam.index,
      id: cfgCam.index + 1,
      name: cfgCam.name,
      online: isOnline,
      recording: 'unknown',
      audio: 'unknown',
      type: 'rt-portal',
      rtId: apiCam.id,
      // UID нужен снапшоттеру (snapshots.js → snapRostelecom): по нему
      // достаём JPEG из map'ы перехваченных портальных thumbnails.
      uid:   apiCam.uid,
      notes: isOnline ? 'Online (портал РТ)' : `Offline — статус: ${apiCam.status || 'нет данных'}`,
    };
  });

  if (step) {
    log.info(step, 'Сопоставление камер портала', {
      поUid: stats.uid, поПорядку: stats.order, безДанных: stats.missing,
    });

    // Камеры, которые на портале есть, а в конфиге не заведены. Так в августе
    // 2026 обнаружилась лишняя камера: без этого предупреждения новая камера
    // просто не попадает ни в отчёт, ни в мониторинг, и заметить это нечем.
    const extra = filtered.filter((cam) => !matched.has(cam));
    if (extra.length) {
      log.warn(step, 'На портале есть камеры, которых нет в config/systems.json', {
        list: extra.map((c) => `${c.name || '?'} uid=${c.uid || '-'}`).join(' | '),
      });
    }
  }

  return result;
}

/**
 * Проверяет камеры Ростелеком. Пробует портал с retry, при неудаче — ping.
 */
export async function checkRostelecomSystem({
  id, portalUrl, user, pass,
  cameras = [], excludeApiNames = [], portalRetries = DEFAULT_RETRIES,
}) {
  const step = `${id}:rostelecom`;

  // Пробуем портал с повторными попытками
  if (portalUrl && user && pass) {
    for (let attempt = 1; attempt <= portalRetries; attempt++) {
      try {
        log.info(step, `Попытка ${attempt}/${portalRetries} входа на портал`);
        const apiCams = await checkViaPortal({ portalUrl, user, pass, systemId: id });
        const mapped = mapApiToConfig(apiCams, cameras, excludeApiNames, step);
        // Раньше здесь стояло «после фильтрации N», но N — это длина конфига, а
        // не результат фильтра: формулировка сбивала с толку при разборе, почему
        // новая камера портала не видна в отчёте.
        log.info(step, `Портал: камер в API ${apiCams.length}, камер в конфиге ${mapped.length}`);
        return { cameras: mapped, error: null, method: 'portal' };
      } catch (e) {
        log.warn(step, `Попытка ${attempt}/${portalRetries} не удалась: ${e.message}`);
        if (attempt < portalRetries) {
          log.info(step, 'Пауза 5 сек перед следующей попыткой...');
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
    log.warn(step, `Все ${portalRetries} попыток портала исчерпаны. Откат на ping.`);
  } else {
    log.info(step, 'Нет учётных данных портала, используем ping');
  }

  // Откат на ping
  const pingCams = await checkByPing(cameras, id);
  const online = pingCams.filter(c => c.online === true).length;
  const offline = pingCams.filter(c => c.online === false).length;
  log.info(step, 'Ping-проверка завершена', { online, offline, total: pingCams.length });

  return { cameras: pingCams, error: null, method: 'ping' };
}
