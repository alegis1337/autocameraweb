/**
 * tplink-tapo-check.js — Проверка Wi-Fi камер TP-Link Tapo.
 *
 * Главный сигнал — RTSP-поток через Camera Account, который активируется
 * в мобильном приложении Tapo. Один и тот же ffmpeg-вызов одновременно
 *   а) проверяет online,
 *   б) подтверждает, что камера снимает (recording),
 *   в) даёт свежий JPEG для last-good кэша / отчёта.
 *
 * Если RTSP недоступен (Camera Account отключён или порт 554 закрыт),
 * откатываемся на TCP-probe :443 — это значит Tapo-демон жив, но без
 * RTSP-аутентификации мы не можем подтвердить факт записи.
 *
 * Полная проверка SD-карты (свободное место, статус записи) делается
 * через HTTPS-API Tapo на :443, но новые модели требуют KLAP-handshake
 * (RSA + AES-128-CBC c session key). См. TODO ниже.
 */

import net from 'net';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as log from './logger.js';

const execFileP = promisify(execFile);

const TCP_TIMEOUT     = 3000;
const PING_TIMEOUT    = 2000;
const HTTPS_TIMEOUT   = 4000;
const RTSP_TIMEOUT_MS = 15_000;     // execFile hard-kill
const TAPO_PORT       = 443;
const RTSP_PORT       = 554;

const ROOT = path.resolve('.');
function lastGoodDirFor(sysId) {
  return path.join(ROOT, 'screenshots', 'last-good', sysId);
}

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function probeTcp(host, port, timeoutMs = TCP_TIMEOUT) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port, timeout: timeoutMs }, () => {
      sock.destroy(); resolve(true);
    });
    sock.on('error',   () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

function pingHost(host, timeoutMs = PING_TIMEOUT) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? `ping -n 1 -w ${timeoutMs} ${host}`
      : `ping -c 1 -W ${Math.ceil(timeoutMs / 1000)} ${host}`;
    exec(cmd, { timeout: timeoutMs + 2000 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(/TTL=|ttl=|1 received/i.test(stdout));
    });
  });
}

/** Tapo всегда отвечает JSON с `error_code` — отличает её от стороннего HTTPS. */
function verifyTapoHttps(host) {
  return new Promise((resolve) => {
    const req = https.request({
      host, port: TAPO_PORT, method: 'POST', path: '/',
      rejectUnauthorized: false, timeout: HTTPS_TIMEOUT,
      headers: { 'Content-Type': 'application/json', 'Content-Length': '2' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; if (buf.length > 4096) res.destroy(); });
      res.on('end',  () => resolve(/error_code/i.test(buf) ? 'tapo' : 'https-other'));
      res.on('error', () => resolve('https-other'));
    });
    req.on('timeout', () => { req.destroy(); resolve('no-https'); });
    req.on('error',   () => resolve('no-https'));
    req.write('{}'); req.end();
  });
}

/** Безопасный slug для имени файла кадра. */
function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'cam';
}

/** Собирает RTSP URL с URL-encoded user/pass (важно: в пароле может быть `:` / `@`). */
function buildRtspUrl(host, user, pass, rtspPath = '/stream1') {
  const u = encodeURIComponent(user);
  const p = encodeURIComponent(pass);
  return `rtsp://${u}:${p}@${host}:${RTSP_PORT}${rtspPath}`;
}

/**
 * Снимает один кадр через ffmpeg + RTSP/TCP. Один вызов делает три вещи:
 * проверяет коннект, подтверждает живой видеопоток (=камера снимает),
 * пишет JPEG в last-good.
 *
 * Возвращает:
 *   { ok: true,  path, sizeBytes }  — кадр валидный (>5 КБ)
 *   { ok: false, error }            — RTSP/auth/timeout/etc
 */
async function grabRtspFrame(rtspUrl, outPath) {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // -update 1 — заставляем ffmpeg перезаписать одиночный JPEG (без шаблона
  // %d в имени, иначе ffmpeg ругается warning'ом, который не валит запись,
  // но в логах шумит).
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-y', '-i', rtspUrl,
    '-frames:v', '1', '-q:v', '2', '-update', '1',
    outPath,
  ];
  try {
    await execFileP(ffmpeg, args, { timeout: RTSP_TIMEOUT_MS, windowsHide: true });
    if (!fs.existsSync(outPath)) return { ok: false, error: 'ffmpeg не создал файл' };
    const size = fs.statSync(outPath).size;
    if (size < 5000) return { ok: false, error: `файл подозрительно мал (${size} б)` };
    return { ok: true, path: outPath, sizeBytes: size };
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    const tail = stderr ? stderr.split('\n').pop().slice(0, 200) : err.message.slice(0, 200);
    // Типичные ошибки:
    //   "401 Unauthorized" — неверный логин Camera Account
    //   "404 Not Found"    — неверный rtspPath
    //   "Connection timed out" / "Operation timed out" — порт 554 закрыт
    //   "Stream specifier ... matches no streams" — Tapo вернул пустой SDP
    let kind = 'rtsp';
    if (/401/.test(tail))                 kind = 'rtsp-auth';
    else if (/404/.test(tail))            kind = 'rtsp-path';
    else if (/timed out|timeout/i.test(tail)) kind = 'rtsp-timeout';
    return { ok: false, error: `${kind}: ${tail}` };
  }
}

// ─── Проверка одной камеры ──────────────────────────────────────────────────

async function checkOne(cam, rtspUser, rtspPass, sysId) {
  const host = cam.host;
  if (!host) return { online: 'unknown', recording: 'unknown', notes: 'не указан host' };

  // Главный путь: RTSP через Camera Account.
  // Один кадр = online + recording + свежий snapshot одной операцией.
  if (rtspUser && rtspPass) {
    const url = buildRtspUrl(host, rtspUser, rtspPass, cam.rtspPath || '/stream1');
    const fileName = `${String(cam.index ?? 0).padStart(2, '0')}-${slugify(cam.name)}.jpg`;
    const outPath  = path.join(lastGoodDirFor(sysId), fileName);

    const grab = await grabRtspFrame(url, outPath);
    if (grab.ok) {
      return {
        online: true,
        // Если RTSP отдаёт живой видеопоток — камера снимает; при включённой
        // в приложении записи на microSD это значит, что она пишет.
        // (Прямой проверки SD-карты без Tapo HTTPS API нет — см. TODO.)
        recording: true,
        snapshotPath: outPath,
        notes: `Online (RTSP ${cam.rtspPath || '/stream1'}, кадр ${Math.round(grab.sizeBytes / 1024)} КБ)`,
      };
    }

    // RTSP не удалось — пишем подробную причину, дальше пробуем TCP-fallback
    log.warn('tplink-tapo', `${cam.name}: ${grab.error}`);

    // Если 401 — креды Camera Account неверные. Делаем TCP-probe чтоб
    // отличить «дохлая камера» от «неверные креды» — но recording уже unknown.
    if (/^rtsp-auth/.test(grab.error)) {
      const tcp443 = await probeTcp(host, TAPO_PORT);
      return {
        online: tcp443,
        recording: 'unknown',
        notes: tcp443
          ? `Камера в сети, но Camera Account отвергает логин (${grab.error.slice(0, 80)})`
          : `Камера не в сети и RTSP отверг логин`,
      };
    }
  }

  // Fallback: TCP-probe 443 (Tapo HTTPS-демон) — даёт хотя бы online/offline
  const tcp443 = await probeTcp(host, TAPO_PORT);
  if (tcp443) {
    const kind = await verifyTapoHttps(host);
    const note = !rtspUser
      ? 'Online (TCP :443, нет Camera Account кредов в .env)'
      : kind === 'tapo'
        ? 'Online (Tapo HTTPS), но RTSP-поток не открылся'
        : 'Online (TCP :443), Tapo-протокол не подтверждён';
    return { online: true, recording: 'unknown', notes: note };
  }

  // Полный фейл: даже HTTPS-демон не отвечает
  const alive = await pingHost(host);
  if (alive) {
    return {
      online: false, recording: 'unknown',
      notes: 'Tapo-демон не отвечает (порт 443 закрыт, ping ok — камера зависла?)',
    };
  }
  return {
    online: false, recording: 'unknown',
    notes: `Нет связи с камерой (${host})`,
  };
}

// ─── Главная функция (вызывается из index.js) ────────────────────────────────

/**
 * @param {object} sys
 * @param {string} sys.id
 * @param {string} [sys.rtspUserEnv]   — имя env-переменной с user Camera Account
 * @param {string} [sys.rtspPassEnv]   — имя env-переменной с pass Camera Account
 * @param {Array<{index, name, host, rtspPath?}>} sys.cameras
 */
export async function checkTplinkTapoSystem(sys) {
  const step = `${sys.id}:tapo`;
  const cams = sys.cameras || [];
  log.info(step, 'Проверка Tapo-камер', { count: cams.length });

  // Camera Account — общие на всю систему (так удобнее, у всех Tapo одного
  // объекта обычно один аккаунт). Можно при желании переопределять на уровне
  // камеры через cam.rtspUser / cam.rtspPass или cam.rtspUserEnv/rtspPassEnv
  // (последнее удобно когда Tapo живёт extra-камерой внутри hiwatch-NVR
  // системы, у которой на уровне system нет rtsp-полей).
  const rtspUserDefault = sys.rtspUserEnv ? process.env[sys.rtspUserEnv] : '';
  const rtspPassDefault = sys.rtspPassEnv ? process.env[sys.rtspPassEnv] : '';

  const results = [];
  for (const cam of cams) {
    const rtspUser = cam.rtspUser
                  || (cam.rtspUserEnv ? process.env[cam.rtspUserEnv] : '')
                  || rtspUserDefault;
    const rtspPass = cam.rtspPass
                  || (cam.rtspPassEnv ? process.env[cam.rtspPassEnv] : '')
                  || rtspPassDefault;
    const r = await checkOne(cam, rtspUser, rtspPass, sys.id);
    if (r.online !== true) {
      log.warn(step, `${cam.name} ${r.online === false ? 'offline' : 'unknown'}`, {
        host: cam.host, reason: r.notes,
      });
    }
    results.push({
      index: cam.index,
      id:    cam.id,
      name:  cam.name,
      host:  cam.host,
      rtspPath: cam.rtspPath,
      // Пробрасываем env-имена кредов, чтобы snapshots.js → snapTplinkTapo
      // мог собрать RTSP URL без зависимости от sys-полей (это нужно для
      // extra-камер внутри hiwatch-системы — у sys этих полей нет).
      rtspUserEnv: cam.rtspUserEnv,
      rtspPassEnv: cam.rtspPassEnv,
      rtspUser:    cam.rtspUser,
      rtspPass:    cam.rtspPass,
      online:    r.online,
      recording: r.recording,
      audio:     'unknown',
      snapshotPath: r.snapshotPath,
      notes: r.notes || '',
    });
  }

  const online    = results.filter(r => r.online === true).length;
  const offline   = results.filter(r => r.online === false).length;
  const recording = results.filter(r => r.recording === true).length;
  log.info(step, 'Готово', { online, offline, recording, total: results.length });

  return { cameras: results, error: null };
}

// TODO(recording-sd): прямая проверка SD-карты через Tapo HTTPS API.
//   У новых моделей C-серии требуется KLAP-handshake:
//     1. POST / с client_seed (16 random bytes) → server_seed + auth_hash
//     2. shared_key = SHA256(local_seed + remote_seed + sha256(user:pass))
//     3. дальше AES-128-CBC c IV=md5(...)
//     4. вызов `getSdCardStatus` через `multipleRequest`
//   Это ~250 строк crypto-кода и зависит от модели — отложено до отдельной
//   задачи. Сейчас recording=true приближённо: «RTSP-поток жив = камера
//   снимает = пишет, если microSD исправна».
