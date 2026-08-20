/**
 * trassir-check.js — Checks TRASSIR cameras via TRASSIR SDK HTTP API.
 *
 * TRASSIR exposes an HTTPS JSON API (default port 8080):
 *   GET /login?username=X&password=Y        → { sid, success }
 *   GET /channels?sid=...                   → list of { guid, name, ... }
 *   GET /settings/channels/{guid}/flags/signal?sid=...         → 1 / 0 / -1
 *   GET /settings/channels/{guid}/stats/kbps_main?sid=...      → real number
 *
 * Состояние записи не проверяем: на таких серверах запись motion-triggered,
 * значение флага recording_local мерцает и даёт ложные срабатывания.
 *
 * Certificate is self-signed, so TLS validation is disabled.
 */

import https from 'https';
import * as log from './logger.js';

const agent = new https.Agent({ rejectUnauthorized: false });

function trassirGet(host, port, pathQuery, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host, port, path: pathQuery, agent,
      headers: { 'Accept': 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        // TRASSIR appends a trailing /* ... */ comment block after JSON.
        const match = buf.match(/^\s*(\{[\s\S]*?\})\s*(?:\/\*|$)/);
        const jsonStr = match ? match[1] : buf;
        try {
          resolve(JSON.parse(jsonStr));
        } catch (err) {
          reject(new Error(`invalid JSON from ${pathQuery}: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout ${timeoutMs}ms`));
    });
  });
}

/**
 * Checks TRASSIR cameras via SDK API.
 *
 * @param {object} sys
 * @param {string} sys.host
 * @param {number} sys.port
 * @param {string} sys.user
 * @param {string} sys.pass
 * @returns {Promise<{cameras: Array, error: string|null}>}
 */
export async function checkTrassirSystem(sys) {
  const { host, port = 8080, user, pass, id, knownOffline = [], cameraGuids = {} } = sys;

  // Login
  let sid;
  try {
    const loginRes = await trassirGet(
      host, port,
      `/login?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`
    );
    if (loginRes.success !== 1 || !loginRes.sid) {
      return { cameras: [], error: `login failed: ${JSON.stringify(loginRes)}` };
    }
    sid = loginRes.sid;
    log.debug(id, 'TRASSIR login ok', { sid });
  } catch (err) {
    return { cameras: [], error: `login error: ${err.message}` };
  }

  // List channels
  let channels;
  try {
    const res = await trassirGet(host, port, `/channels?sid=${sid}`);
    channels = res.channels || [];
    log.debug(id, `TRASSIR channels: ${channels.length}`);
  } catch (err) {
    return { cameras: [], error: `channels error: ${err.message}` };
  }

  // Query each channel sequentially
  const cameras = [];
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    const base = `/settings/channels/${ch.guid}`;
    try {
      const [sigRes, kbpsRes] = await Promise.all([
        trassirGet(host, port, `${base}/flags/signal?sid=${sid}`),
        trassirGet(host, port, `${base}/stats/kbps_main?sid=${sid}`),
      ]);
      const signal = sigRes.value;
      const kbps = typeof kbpsRes.value === 'number' ? kbpsRes.value : 0;

      // signal: 1 = ok, 0 = no signal, -1 = unknown
      // Also require bitrate > 10 kbps to ensure actual data flow
      const online = signal === 1 && kbps > 10;

      const displayName = cameraGuids[ch.guid] || ch.name || `Канал ${i + 1}`;
      const isKnownOffline = knownOffline.includes(displayName);
      cameras.push({
        index: i,
        name: displayName,
        online:    isKnownOffline ? null : online,
        recording: null, // запись motion-triggered — не проверяем
        audio: 'unknown',
        notes: isKnownOffline
          ? 'не используется'
          : `${kbps.toFixed(0)} kbps` + (signal !== 1 ? ', нет сигнала' : ''),
      });
    } catch (err) {
      cameras.push({
        index: i,
        name: ch.name || `Канал ${i + 1}`,
        online: 'unknown',
        recording: 'unknown',
        audio: 'unknown',
        notes: `ошибка запроса: ${err.message}`,
      });
    }
  }

  return { cameras, error: null };
}
