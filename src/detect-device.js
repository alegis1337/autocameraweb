/**
 * detect-device.js — определяет тип устройства по IP + (опционально) логину/паролю.
 *
 * Пробует протоколы по очереди (быстрые таймауты ~5 сек):
 *   1. Hikvision/HiWatch ISAPI (порт 80, Digest auth)
 *      → читает /ISAPI/System/deviceInfo (модель, vendor)
 *      → читает /ISAPI/System/Video/inputs/channels → число каналов
 *      → решает: NVR (>1 канал) или single camera (1 канал)
 *   2. TRASSIR SDK (порт 8080, HTTPS, login → sid → settings/channels)
 *      → читает список камер с GUID и displayName
 *   3. BEWARD (порт 80, Basic auth, /cgi-bin/images_cgi?cmd=snapshot)
 *   4. RTSP (порт 554) — fallback: если открыт RTSP, но ничего другого не известно
 *
 * Использование:
 *   import { detectDevice } from './detect-device.js';
 *   const info = await detectDevice('192.168.1.42', 80, 'admin', 'secret');
 *   // info = { ok: true, kind: 'hikvision-nvr', vendor, model, channelCount, ... }
 *
 * Вызов как CLI (для menu.ps1):
 *   node src/detect-device.js <ip> <port> <user> <pass>
 *   Печатает результат как JSON в stdout.
 */

import https from 'https';
import net from 'net';
import { isapiRequest } from './isapi.js';

const trassirAgent = new https.Agent({ rejectUnauthorized: false });

// ─── Утилиты ─────────────────────────────────────────────────────────────────

/** TCP-проба: открыт ли порт. timeoutMs — таймаут на коннект. */
function probePort(ip, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: ip, port, timeout: timeoutMs }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error',   () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// ─── 1. Hikvision/HiWatch ISAPI ──────────────────────────────────────────────

function parseXmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

async function detectHikvisionIsapi(ip, port, user, pass) {
  const baseUrl = `http://${ip}:${port}`;
  let xml;
  try {
    xml = await withTimeout(isapiRequest(baseUrl, '/ISAPI/System/deviceInfo', user, pass), 6000, 'isapi-deviceInfo');
  } catch (err) {
    return null;  // не ISAPI или нет авторизации
  }

  const model         = parseXmlTag(xml, 'model');
  const deviceName    = parseXmlTag(xml, 'deviceName');
  const deviceType    = parseXmlTag(xml, 'deviceType');
  const firmware      = parseXmlTag(xml, 'firmwareVersion');
  const serialNumber  = parseXmlTag(xml, 'serialNumber');

  // По модели и deviceType определяем NVR/Camera
  // NVR-маркеры: deviceType содержит 'NVR'/'DVR', model начинается с DS-7xxx, DS-8xxx, DS-9xxx, iDS-7
  // Camera-маркеры: model начинается с DS-2CD, DS-2DE, DS-I, IPC-, HWI-
  const m = model.toUpperCase();
  let kind;
  if (/NVR|DVR/i.test(deviceType) ||
      /^IDS-7|^DS-7[0-9]|^DS-[89][0-9]/i.test(m)) {
    kind = 'hikvision-nvr';
  } else if (/^DS-2|^DS-I|^IPC-|^HWI-/i.test(m)) {
    kind = 'hikvision-single';
  } else {
    // По умолчанию: если deviceInfo читается без ошибок — это что-то Hikvision-семейства
    kind = 'hikvision-unknown';
  }

  // Получаем число каналов (если NVR — реальное; если single — обычно 1)
  let channelCount = null;
  try {
    const chXml = await withTimeout(
      isapiRequest(baseUrl, '/ISAPI/System/Video/inputs/channels', user, pass),
      6000, 'isapi-channels',
    );
    const matches = chXml.match(/<VideoInputChannel\b/gi);
    if (matches) channelCount = matches.length;
  } catch { /* не критично */ }

  // Если channelCount пуст, fallback по kind
  if (channelCount == null) {
    channelCount = kind === 'hikvision-nvr' ? 16 : 1;
  }

  // Если kind == hikvision-unknown — додовариваем
  if (kind === 'hikvision-unknown') {
    kind = channelCount > 1 ? 'hikvision-nvr' : 'hikvision-single';
  }

  // Вендор: HiWatch / Hikvision / iPanda
  let vendor = 'Hikvision';
  if (/HWI-|HWN-|^HW/i.test(m) || /hiwatch/i.test(deviceName)) vendor = 'HiWatch';
  else if (/ipanda/i.test(deviceName) || /ipanda/i.test(model)) vendor = 'iPanda';

  return {
    ok: true, kind, vendor, model, deviceName, deviceType, firmware,
    serialNumber, channelCount,
    suggestedSystemType: kind === 'hikvision-nvr'
      ? (vendor === 'HiWatch' ? 'hiwatch' : 'hikvision')
      : 'hikvision-multi',
  };
}

// ─── 2. TRASSIR SDK ──────────────────────────────────────────────────────────

function trassirJson(host, port, pathQuery, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host, port, path: pathQuery, agent: trassirAgent,
      headers: { Accept: 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          // TRASSIR иногда оборачивает в /* ... */
          const m = buf.match(/^\s*(\{[\s\S]*?\})\s*(?:\/\*|$)/);
          resolve(JSON.parse(m ? m[1] : buf));
        } catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

async function detectTrassir(ip, port, user, pass) {
  const portToTry = port === 80 || !port ? 8080 : port;
  // Сначала проверим что 8080 открыт — если нет, не TRASSIR
  if (!(await probePort(ip, portToTry, 2000))) return null;

  let login;
  try {
    login = await trassirJson(ip, portToTry,
      `/login?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`);
  } catch {
    return null;
  }
  if (!login?.sid) return null;

  const sid = login.sid;

  // Список камер. У TRASSIR SDK канал — это объект с GUID.
  // Endpoint /channels?sid=... → массив объектов { guid, name, ... }
  let channels = [];
  try {
    const ch = await trassirJson(ip, portToTry, `/channels?sid=${sid}`);
    if (Array.isArray(ch?.channels)) channels = ch.channels;
    else if (Array.isArray(ch)) channels = ch;
  } catch { /* не критично — система всё равно TRASSIR */ }

  // Маппим в простой массив { guid, name }
  const cameras = channels.map((c) => ({
    guid: c.guid || c.id || c.channel_id || '',
    name: c.name || c.displayName || c.title || '',
  })).filter(c => c.guid && c.name);

  return {
    ok: true,
    kind: 'trassir',
    vendor: 'TRASSIR',
    suggestedSystemType: 'trassir-sdk',
    sid,
    portUsed: portToTry,
    channelCount: cameras.length,
    cameras,
  };
}

// ─── 3. BEWARD ───────────────────────────────────────────────────────────────

async function detectBeward(ip, port, user, pass) {
  const url = `http://${ip}:${port}/cgi-bin/images_cgi?cmd=snapshot`;
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  try {
    const resp = await withTimeout(
      fetch(url, { headers: { Authorization: auth } }),
      5000, 'beward'
    );
    if (resp.ok) {
      const ct = resp.headers.get('content-type') || '';
      if (/image|jpeg|jpg/i.test(ct)) {
        return { ok: true, kind: 'beward-camera', vendor: 'BEWARD', suggestedSystemType: 'beward', channelCount: 1 };
      }
    }
  } catch { /* not beward */ }
  return null;
}

// ─── Главная функция детектора ───────────────────────────────────────────────

/**
 * @returns {Promise<{
 *   ok:true, kind, vendor, model?, channelCount?, suggestedSystemType,
 *   cameras?: Array<{guid,name}>, ...
 * } | {
 *   ok:false, error:string, probedPorts: object,
 * }>}
 */
export async function detectDevice(ip, port = 80, user = '', pass = '') {
  // Проверяем что хост в принципе доступен
  const probed = {
    http:   await probePort(ip, Number(port) || 80, 2000),
    trassir: await probePort(ip, 8080, 1500),
    rtsp:   await probePort(ip, 554, 1500),
  };

  if (!probed.http && !probed.trassir && !probed.rtsp) {
    return { ok: false, error: `Хост ${ip} недоступен (нет ответа на :${port}, :8080, :554)`, probedPorts: probed };
  }

  // 1. Hikvision/HiWatch ISAPI — если порт HTTP открыт И есть креды
  if (probed.http && user && pass) {
    const r = await detectHikvisionIsapi(ip, Number(port) || 80, user, pass);
    if (r) return r;
  }

  // 2. TRASSIR SDK
  if (probed.trassir && user && pass) {
    const r = await detectTrassir(ip, 8080, user, pass);
    if (r) return r;
  }

  // 3. BEWARD
  if (probed.http && user && pass) {
    const r = await detectBeward(ip, Number(port) || 80, user, pass);
    if (r) return r;
  }

  // 4. RTSP fallback — если 554 открыт, но детектора не сработали
  if (probed.rtsp) {
    return {
      ok: true, kind: 'rtsp-generic', vendor: 'unknown',
      suggestedSystemType: 'ipanda-rtsp', channelCount: 1,
      notes: 'RTSP-сервер обнаружен. Тип устройства определить не удалось — потребуется указать вручную.',
    };
  }

  return {
    ok: false,
    error: 'Не удалось определить устройство. Попробуйте указать тип вручную.',
    probedPorts: probed,
  };
}

// ─── CLI (для menu.ps1) ──────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
    import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
  const [,, ip, port = '80', user = '', pass = ''] = process.argv;
  if (!ip) {
    console.error('Usage: node detect-device.js <ip> [port] [user] [pass]');
    process.exit(2);
  }
  detectDevice(ip, port, user, pass)
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); })
    .catch((e) => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(2); });
}
