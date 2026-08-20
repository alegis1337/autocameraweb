/**
 * snapshots.js — Снятие кадра с камеры по типу системы.
 *
 * Поддерживаемые системы:
 *   • hikvision-multi               → ISAPI /Streaming/channels/101/picture
 *   • hiwatch / hikvision (NVR)     → ISAPI /Streaming/channels/<N>01/picture
 *   • ipanda-rtsp                   → ffmpeg grab one frame
 *   • trassir-sdk                   → SDK API /screenshot?channel=<guid>&sid=<sid>
 *
 * Не поддерживаем (будем класть localPath: null):
 *   • beward-smb, smb-recordings    — SMB-шары записей, не камеры
 *   • rt-portal                     — портал РТ, без отдельного API
 *
 * Каждый локальный файл сохраняется как:
 *   screenshots/<runId>/<systemId>/<index>-<safeName>.jpg
 *
 * Удаление локальных файлов — забота вызывающего кода (после загрузки на Я.Диск).
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as log from './logger.js';
import { isapiGetBinary } from './isapi.js';

const execFileP = promisify(execFile);

const trassirAgent = new https.Agent({ rejectUnauthorized: false });

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function safeName(s) {
  return String(s || 'cam').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60);
}

function snapshotsRoot() {
  return path.resolve('screenshots');
}

/**
 * Готовит локальный путь для скриншота. Создаёт нужные папки.
 */
export function localPathFor(runId, sysId, cam) {
  const dir = path.join(snapshotsRoot(), runId, sysId);
  fs.mkdirSync(dir, { recursive: true });
  const idx = (cam.index ?? 0).toString().padStart(2, '0');
  return path.join(dir, `${idx}-${safeName(cam.name)}.jpg`);
}

// ─── Захват кадра по типу системы ────────────────────────────────────────────

/**
 * Snapshot с одиночной Hikvision-камеры (hikvision-multi).
 * Используется отдельный host на каждую камеру.
 */
async function snapHikvisionMulti(sys, cam) {
  if (!cam.host) return { ok: false, error: 'нет cam.host' };
  const port  = cam.port || 80;
  const baseUrl = `http://${cam.host}:${port}`;
  const user = cam.user || (cam.userEnv ? process.env[cam.userEnv] : '') || '';
  const pass = cam.pass || (cam.passEnv ? process.env[cam.passEnv] : '') || '';
  if (!user || !pass) return { ok: false, error: 'нет логина/пароля' };

  // У одиночной камеры один канал — channel=101 (camera 1, mainstream)
  return await isapiSnapshot(baseUrl, 101, user, pass);
}

/**
 * Snapshot с камеры за NVR (hiwatch / hikvision NVR).
 * channel = <camera 1-based id>01.
 */
async function snapHikvisionNvr(sys, cam) {
  const baseUrl = String(sys.url || process.env[sys.urlEnv] || '').replace(/\/doc\/page\/login\.asp.*/, '').replace(/\/$/, '');
  if (!baseUrl) return { ok: false, error: 'нет baseUrl' };
  const user = sys.user || process.env[sys.userEnv] || '';
  const pass = process.env[sys.passEnv] || '';
  if (!user || !pass) return { ok: false, error: 'нет логина/пароля' };

  const camId = cam.id != null ? cam.id : (cam.index ?? 0) + 1;
  const channel = `${camId}01`;
  return await isapiSnapshot(baseUrl, channel, user, pass);
}

/** Общий вызов /Streaming/channels/<channel>/picture. */
async function isapiSnapshot(baseUrl, channel, user, pass) {
  try {
    const buf = await isapiGetBinary(baseUrl, `/ISAPI/Streaming/channels/${channel}/picture`, user, pass);
    if (!buf || buf.length < 200) return { ok: false, error: 'пустой ответ' };
    return { ok: true, buffer: buf };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Snapshot через ffmpeg от RTSP-потока.
 * Один кадр (-frames:v 1), TCP-транспорт, тайм-аут 8 сек.
 */
async function snapRtsp(sys, cam, localPath) {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

  // Строим RTSP URL. Креды читаем сначала через env (rtspUserEnv/rtspPassEnv,
  // nvrRtspUserEnv/nvrRtspPassEnv), fallback — буквальные sys.rtspUser/Pass.
  const envOr = (envKey, literal) => (envKey && process.env[envKey]) || literal;
  let rtspUrl;
  if (cam.rtspPath) {
    // Через NVR (Hikvision-формат): rtsp://<логин>:<пароль>@<IP NVR>/Streaming/Channels/N01
    // (пример записан скобками, а не user:pass@host: pre-commit hook считает
    //  такую строку утёкшими кредами в URL и блокирует коммит)
    if (cam.viaNvr && sys.nvrIp) {
      const u = envOr(sys.nvrRtspUserEnv, sys.nvrRtspUser)
             || envOr(sys.rtspUserEnv,    sys.rtspUser)
             || 'admin';
      const p = envOr(sys.nvrRtspPassEnv, sys.nvrRtspPass)
             || envOr(sys.rtspPassEnv,    sys.rtspPass)
             || '';
      rtspUrl = `rtsp://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${sys.nvrIp}${cam.rtspPath}`;
    } else if (cam.ip) {
      const u = envOr(sys.rtspUserEnv, sys.rtspUser) || 'admin';
      const p = envOr(sys.rtspPassEnv, sys.rtspPass) || '';
      rtspUrl = `rtsp://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${cam.ip}${cam.rtspPath}`;
    }
  }
  if (!rtspUrl) return { ok: false, error: 'не получилось собрать RTSP URL' };

  // В ffmpeg 8 убрали -stimeout / -rw_timeout как глобальные опции —
  // ограничиваемся жёстким timeout от execFile (15с).
  // -q:v 2 — высокое качество JPEG (1=best, 31=worst). При q=5 миниатюры
  //          выглядели заметно мыльно при увеличении — q=2 даёт чёткую картинку.
  const args = [
    '-rtsp_transport', 'tcp',
    '-y',
    '-i', rtspUrl,
    '-frames:v', '1',
    '-q:v', '2',
    '-loglevel', 'error',
    localPath,
  ];

  try {
    await execFileP(ffmpeg, args, { timeout: 15_000, windowsHide: true });
    if (!fs.existsSync(localPath) || fs.statSync(localPath).size < 200) {
      return { ok: false, error: 'ffmpeg создал пустой/слишком маленький файл' };
    }
    return { ok: true, fromFile: true };
  } catch (err) {
    // execFileP при non-zero exit добавляет stderr в err.stderr
    const stderr = (err.stderr || '').toString().trim();
    const reason = stderr
      ? stderr.split('\n').slice(-2).join(' | ').slice(0, 200)
      : err.message.slice(0, 200);
    return { ok: false, error: `ffmpeg: ${reason}` };
  }
}

/**
 * Snapshot для TP-Link Tapo: тот же RTSP+ffmpeg, что и iPanda, но URL
 * собирается из Camera Account (sys.rtspUserEnv / sys.rtspPassEnv).
 * Главное отличие — Tapo по умолчанию слушает /stream1 (HD), без NVR-обвязки.
 */
async function snapTplinkTapo(sys, cam, localPath) {
  const ffmpeg   = process.env.FFMPEG_PATH || 'ffmpeg';
  // Креды Camera Account: сначала per-camera (extra-камера в hiwatch-системе),
  // потом per-system (отдельная Tapo-система с общими кредами).
  const rtspUser = cam.rtspUser
                || (cam.rtspUserEnv ? process.env[cam.rtspUserEnv] : '')
                || (sys.rtspUserEnv ? process.env[sys.rtspUserEnv] : '');
  const rtspPass = cam.rtspPass
                || (cam.rtspPassEnv ? process.env[cam.rtspPassEnv] : '')
                || (sys.rtspPassEnv ? process.env[sys.rtspPassEnv] : '');
  if (!rtspUser || !rtspPass) {
    return { ok: false, error: 'нет Camera Account кредов (rtspUserEnv/rtspPassEnv)' };
  }
  if (!cam.host) return { ok: false, error: 'нет cam.host' };

  const u = encodeURIComponent(rtspUser);
  const p = encodeURIComponent(rtspPass);
  const rtspPath = cam.rtspPath || '/stream1';
  const rtspUrl = `rtsp://${u}:${p}@${cam.host}:554${rtspPath}`;

  const args = [
    '-rtsp_transport', 'tcp',
    '-y', '-i', rtspUrl,
    '-frames:v', '1', '-q:v', '2',
    '-update', '1',
    '-loglevel', 'error',
    localPath,
  ];
  try {
    await execFileP(ffmpeg, args, { timeout: 15_000, windowsHide: true });
    if (!fs.existsSync(localPath) || fs.statSync(localPath).size < 200) {
      return { ok: false, error: 'ffmpeg создал пустой/слишком маленький файл' };
    }
    return { ok: true, fromFile: true };
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    const reason = stderr ? stderr.split('\n').slice(-2).join(' | ').slice(0, 200)
                          : err.message.slice(0, 200);
    return { ok: false, error: `ffmpeg: ${reason}` };
  }
}

/**
 * Кэш sid TRASSIR per host:port. Хранит Promise<sid>, чтобы N параллельных
 * snapTrassir для одной системы делали ровно один login.
 */
const trassirSidCache = new Map();

function loginTrassir(host, port, user, pass) {
  const loginPath = `/login?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
  return trassirJson(host, port, loginPath).then((json) => {
    if (!json.sid) throw new Error('login: пустой sid');
    return json.sid;
  });
}

async function getTrassirSid(host, port, user, pass) {
  const key = `${host}:${port}`;
  if (!trassirSidCache.has(key)) {
    // Кладём промис в кэш ДО await — все одновременные вызовы получат его
    trassirSidCache.set(key, loginTrassir(host, port, user, pass).catch((err) => {
      // При ошибке убираем из кэша, чтобы следующий вызов мог попробовать ещё
      trassirSidCache.delete(key);
      throw err;
    }));
  }
  return trassirSidCache.get(key);
}

/**
 * Snapshot через TRASSIR SDK.
 * Login кэшируется per host:port — все 22 камеры одного TRASSIR'а используют
 * один sid (полученный одним запросом).
 */
async function snapTrassir(sys, cam) {
  const host = sys.host;
  const port = sys.port || 8080;
  const user = process.env[sys.userEnv] || sys.user || '';
  const pass = process.env[sys.passEnv] || sys.pass || '';
  if (!host || !user || !pass) return { ok: false, error: 'нет host/login' };

  // Найти guid камеры в sys.cameraGuids: значение = name → ключ = guid
  const guids = sys.cameraGuids || {};
  const guid = Object.entries(guids).find(([_, v]) => v === cam.name)?.[0];
  if (!guid) return { ok: false, error: `guid не найден в cameraGuids для "${cam.name}"` };

  // Login (через кэш — один раз на host:port)
  let sid;
  try {
    sid = await getTrassirSid(host, port, user, pass);
  } catch (err) {
    return { ok: false, error: `login: ${err.message}` };
  }

  // Screenshot
  try {
    const buf = await trassirBinary(host, port, `/screenshot?channel=${guid}&sid=${sid}`);
    if (!buf || buf.length < 200) return { ok: false, error: 'пустой screenshot' };
    return { ok: true, buffer: buf };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Snapshot Ростелекома: batch через Playwright.
 *
 * CDN Ростелекома режет fetch не из самого Chromium (IP-binding + Origin).
 * Поэтому открываем портал в headless-браузере, дожидаемся пока сам React
 * подгрузит thumbnails (по 1 на камеру), перехватываем response.body для
 * каждой и складываем в Map<uid, Buffer>.
 *
 * Делаем это ОДИН РАЗ на прогон через кэш rostelecomBatchCache —
 * 7 параллельных snapRostelecom получают одну общую Promise.
 */
const rostelecomBatchCache = new Map();  // sys.id → Promise<Map<uid, Buffer>>

async function fetchRostelecomBatchOnce(sys, portalUrl, user, pass) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1920, height: 1080 },
    });
    const page = await ctx.newPage();

    // Перехватчик thumbnails
    const buffers = new Map();    // uid → Buffer
    page.on('response', async (resp) => {
      try {
        const u = resp.url();
        if (!/cdn\.camera\.rt\.ru\/image\//.test(u)) return;
        if (resp.status() !== 200) return;
        const m = u.match(/\/image\/[^/]+\/([0-9a-f-]+)\//);
        if (!m || buffers.has(m[1])) return;
        const buf = await resp.body();
        if (buf.length > 200) buffers.set(m[1], buf);
      } catch { /* пропускаем */ }
    });

    // Login flow (зеркалит rostelecom-check.js с увеличенными таймаутами).
    // Прошлая версия с timeout=20с на waitForSelector регулярно фейлилась —
    // passport.rt.ru рендерится React-формой ~10-20 сек.
    await page.goto(`${portalUrl}/main/cameras`, {
      waitUntil: 'domcontentloaded', timeout: 60_000,
    }).catch(() => {});

    await page.waitForURL('**/passport.rt.ru/**', { timeout: 60_000 }).catch(() => {});

    // Сначала ждём load (React успеет смонтировать форму)
    await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});

    // Потом ищем поле логина — много времени, чтобы пережить медленный рендер
    await page.waitForSelector('input#username, input[type="text"]', {
      state: 'attached', timeout: 45_000,
    });
    await page.waitForTimeout(2000);

    // jsSetInput-аналог: passport.rt.ru видим только через React-setter
    await page.evaluate(({ u, p }) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const set = (sel, val) => {
        const inp = document.querySelector(sel);
        if (!inp) return;
        setter.call(inp, val);
        inp.dispatchEvent(new Event('input',  { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('input#username', u);
      set('input#password', p);
      const b = [...document.querySelectorAll('button')]
        .find(x => x.textContent.trim() === 'Войти');
      if (b) b.click(); else document.querySelector('form')?.submit();
    }, { u: user, p: pass });

    // Ждём возврат на портал (до 60 сек)
    let returned = false;
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(1000);
      const u = page.url();
      if (u.includes('camera.rt.ru') && !u.includes('passport')) {
        returned = true;
        break;
      }
    }
    if (!returned) {
      throw new Error('не вернулись на портал после логина');
    }

    // Дать порталу время подгрузить все thumbnails. Ждём пока соберём
    // ожидаемое число камер (sys.cameras.length) или максимум 60 сек.
    const expect = sys.cameras?.length || 8;
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(1000);
      if (buffers.size >= expect) break;
    }

    if (buffers.size === 0) {
      throw new Error('портал не отдал ни одной миниатюры');
    }
    return buffers;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function fetchRostelecomBatch(sys) {
  const portalUrl = process.env[sys.portalUrlEnv] || sys.portalUrl || 'https://lk-b2b.camera.rt.ru';
  const user      = process.env[sys.userEnv]      || sys.user || '';
  const pass      = process.env[sys.passEnv]      || sys.pass || '';
  if (!user || !pass) throw new Error('нет учётки RT_PORTAL_USER/PASS');

  const maxAttempts = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const buffers = await fetchRostelecomBatchOnce(sys, portalUrl, user, pass);
      if (attempt > 1) {
        log.info('snapshot', `RT batch: получено с попытки ${attempt}/${maxAttempts}`);
      }
      return buffers;
    } catch (err) {
      lastErr = err;
      log.warn('snapshot', `RT batch попытка ${attempt}/${maxAttempts}: ${err.message}`);
      if (attempt < maxAttempts) {
        // Пауза между попытками — даём порталу «отдохнуть»
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  throw lastErr;
}

async function snapRostelecom(sys, cam) {
  if (!cam.uid) return { ok: false, error: 'нет cam.uid (rostelecom-check не сохранил)' };

  // Один batch-fetch per system; все 7 камер этого sys ждут общий promise.
  let batchPromise = rostelecomBatchCache.get(sys.id);
  if (!batchPromise) {
    batchPromise = fetchRostelecomBatch(sys);
    rostelecomBatchCache.set(sys.id, batchPromise);
  }

  let buffers;
  try {
    buffers = await batchPromise;
  } catch (err) {
    return { ok: false, error: `RT batch fetch: ${err.message}` };
  }

  const buf = buffers.get(cam.uid);
  if (!buf) return { ok: false, error: `снимок ${cam.uid.slice(0, 8)}... не пойман порталом` };
  return { ok: true, buffer: buf };
}

function trassirJson(host, port, pathQuery, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host, port, path: pathQuery, agent: trassirAgent, headers: { Accept: 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const m = buf.match(/^\s*(\{[\s\S]*?\})\s*(?:\/\*|$)/);
          resolve(JSON.parse(m ? m[1] : buf));
        } catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

function trassirBinary(host, port, pathQuery, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host, port, path: pathQuery, agent: trassirAgent }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

// ─── Главный API ─────────────────────────────────────────────────────────────

/**
 * Захватывает кадр одной камеры. Сохраняет JPEG в локальный путь.
 *
 * @param {string} runId — общий идентификатор прогона (для папки)
 * @param {object} sys   — система целиком (со всеми config-полями)
 * @param {object} cam   — камера из sys.cameras (с host/port/index)
 * @returns {Promise<{ok:boolean, localPath?:string, error?:string}>}
 */
export async function captureSnapshot(runId, sys, cam) {
  const localPath = localPathFor(runId, sys.id, cam);
  // Для extra-камер (например, Tapo, припаркованная в hiwatch-системе)
  // протокол кадра — это её собственный тип, а не тип контейнера.
  const snapType = cam._extraType || sys.type;

  let result;
  switch (snapType) {
    case 'hikvision-multi':
      result = await snapHikvisionMulti(sys, cam);
      break;
    case 'hiwatch':
    case 'hikvision':
      result = await snapHikvisionNvr(sys, cam);
      break;
    case 'ipanda-rtsp':
      result = await snapRtsp(sys, cam, localPath);
      break;
    case 'trassir-sdk':
      result = await snapTrassir(sys, cam);
      break;
    case 'rt-portal':
      result = await snapRostelecom(sys, cam);
      break;
    case 'tplink-tapo':
      result = await snapTplinkTapo(sys, cam, localPath);
      break;
    default:
      return { ok: false, error: `тип системы ${snapType} не поддерживает снимки` };
  }

  // Если получили буфер — пишем на диск
  if (result.ok && result.buffer && !result.fromFile) {
    fs.writeFileSync(localPath, result.buffer);
  }

  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, localPath };
}

/**
 * Параллельно снимает кадры для всех ONLINE камер. Не диагностирует, не
 * лезет в Я.Диск — только пишет JPEG в screenshots/<runId>/.
 *
 * @param {Array}  systemResults
 * @param {string} runId
 * @param {object} options
 * @param {number} options.concurrency    — default 5
 * @param {boolean} options.includeOffline — пробовать снимать offline-камеры
 *   тоже (для daily-режима). У TRASSIR/Hikvision NVR при offline-канале
 *   часто возвращается «no signal» placeholder — полезно как доказательство
 *   в отчёте. У Rostelecom — портал тоже отдаёт placeholder через CDN, его
 *   batch перехватит. У RTSP-камер обычно просто timeout — ну и ладно.
 * @returns {Promise<Array<{sysId, camIndex, camName, localPath, error}>>}
 */
export async function captureAll(systemResults, runId, options = {}) {
  const concurrency    = options.concurrency || 5;
  const includeOffline = options.includeOffline === true;
  const targets = [];
  for (const sys of systemResults) {
    if (sys.error) continue;
    for (const cam of sys.cameras) {
      if (!includeOffline && cam.online !== true) continue;       // light: только online
      if (includeOffline && cam.online == null) continue;         // unknown — всё равно нечего
      const unused = sys.unusedChannels || [];
      const ch = cam.id != null ? cam.id : (cam.index ?? 0) + 1;
      if (unused.includes(ch)) continue;
      // Тип «камеры» для снапшота. Для extra-камер (например, Tapo внутри
      // hiwatch-NVR) берём из cam._extraType — у них своё API.
      const snapType = cam._extraType || sys.type;
      // SMB-системы хранят файлы записей, видеопотока для grab'а нет.
      // Раньше captureSnapshot честно ругался «не поддерживает» 10 раз за
      // прогон — отсекаем их здесь, чтобы не плодить warning'и и не тратить
      // worker'ы concurrency-пула.
      if (snapType === 'smb-recordings' || snapType === 'beward-smb') continue;
      targets.push({ sys, cam });
    }
  }

  log.info('snapshot', `Готовлю снимки`, { count: targets.length, concurrency, includeOffline });

  const out = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < targets.length) {
      const idx = cursor++;
      const { sys, cam } = targets[idx];
      try {
        const r = await captureSnapshot(runId, sys, cam);
        if (!r.ok) {
          log.warn('snapshot', `${sys.id}/${cam.name}: ${r.error}`);
        }
        out[idx] = {
          sysId:     sys.id,
          camIndex:  cam.index,
          camName:   cam.name,
          localPath: r.ok ? r.localPath : null,
          error:     r.ok ? null         : r.error,
        };
      } catch (err) {
        log.warn('snapshot', `${sys.id}/${cam.name}: ${err.message}`);
        out[idx] = { sysId: sys.id, camIndex: cam.index, camName: cam.name, localPath: null, error: err.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Удаляет всю папку screenshots/<runId>/ после успешной заливки на Я.Диск.
 */
export function cleanupRun(runId) {
  const dir = path.join(snapshotsRoot(), runId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
