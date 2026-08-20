/**
 * rtsp-check.js — Camera status check via RTSP DESCRIBE + data flow probe.
 * Confirms the camera is actually streaming video, not just pingable.
 * For NVR-proxied channels, checks actual RTP data volume to detect "no signal".
 */

import net from 'net';
import crypto from 'crypto';
import * as log from './logger.js';

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

/**
 * Builds a Digest auth header from a 401 challenge.
 */
function buildDigestAuth(user, pass, method, uri, wwwAuth) {
  const realm = wwwAuth.match(/realm="([^"]+)"/)?.[1] || '';
  const nonce = wwwAuth.match(/nonce="([^"]+)"/)?.[1] || '';
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${nonce}:${ha2}`);
  return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
}

/**
 * Sends RTSP DESCRIBE with Digest auth to get stream info.
 * Returns { ok, resolution, codec, fps, audio, bitrate } or { ok: false, error }.
 */
function rtspDescribe(ip, path, user, pass, port = 554, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let data = '';
    let authed = false;
    let resolved = false;

    function finish(result) {
      if (!resolved) { resolved = true; resolve(result); }
    }

    const client = net.createConnection({ host: ip, port, timeout: timeoutMs }, () => {
      const uri = `rtsp://${ip}:${port}${path}`;
      client.write(`DESCRIBE ${uri} RTSP/1.0\r\nCSeq: 2\r\nAccept: application/sdp\r\n\r\n`);
    });

    client.on('data', (d) => {
      data += d.toString();

      if (!authed && data.includes('401') && data.includes('nonce=')) {
        authed = true;
        const uri = `rtsp://${ip}:${port}${path}`;
        const auth = buildDigestAuth(user, pass, 'DESCRIBE', uri, data);
        data = '';
        client.write(`DESCRIBE ${uri} RTSP/1.0\r\nCSeq: 3\r\nAccept: application/sdp\r\nAuthorization: ${auth}\r\n\r\n`);
        return;
      }

      if (data.includes('200 OK') && data.includes('v=0')) {
        client.destroy();
        finish(parseSdp(data));
        return;
      }

      if (authed && data.includes('401')) {
        client.destroy();
        finish({ ok: false, error: 'auth_failed' });
        return;
      }
    });

    client.on('close', () => finish({ ok: false, error: 'connection_closed' }));
    client.on('error', (e) => finish({ ok: false, error: e.message }));
    client.on('timeout', () => { client.destroy(); finish({ ok: false, error: 'timeout' }); });
    setTimeout(() => { client.destroy(); finish({ ok: false, error: 'timeout' }); }, timeoutMs + 1000);
  });
}

function parseSdp(data) {
  const resolution = data.match(/x-dimensions:(\d+,\d+)/)?.[1]?.replace(',', 'x') || '';
  const codec = data.match(/rtpmap:\d+ (H26[45]|MPEG4|MJPEG|VP[89])/i)?.[1] || '';
  const fps = data.match(/framerate:(\d+)/)?.[1] || '';
  const bitrate = parseInt(data.match(/a=bitrate:(\d+)/)?.[1] || '0');
  const hasAudio = /m=audio/.test(data);

  return { ok: true, resolution, codec, fps, audio: hasAudio, bitrate, error: null };
}

/**
 * Probes actual RTP data flow via TCP-interleaved RTSP.
 * Sends DESCRIBE → SETUP (TCP) → PLAY, counts bytes over probeDurationMs.
 * Returns total bytes received during probe period.
 */
function rtspProbeDataFlow(ip, path, user, pass, port = 554, probeDurationMs = 2000) {
  return new Promise((resolve) => {
    const uri = `rtsp://${ip}:${port}${path}`;
    let cseq = 1;
    let data = '';
    let authed = false;
    let setupDone = false;
    let playing = false;
    let done = false;
    let totalBytes = 0;

    function finish() {
      if (!done) { done = true; resolve(totalBytes); }
    }

    const client = net.createConnection({ host: ip, port, timeout: 15000 }, () => {
      client.write(`DESCRIBE ${uri} RTSP/1.0\r\nCSeq: ${cseq++}\r\nAccept: application/sdp\r\n\r\n`);
    });

    client.on('data', (d) => {
      if (playing) {
        totalBytes += d.length;
        return;
      }

      data += d.toString();

      // Auth challenge
      if (!authed && data.includes('401') && data.includes('nonce=')) {
        authed = true;
        const auth = buildDigestAuth(user, pass, 'DESCRIBE', uri, data);
        data = '';
        client.write(`DESCRIBE ${uri} RTSP/1.0\r\nCSeq: ${cseq++}\r\nAccept: application/sdp\r\nAuthorization: ${auth}\r\n\r\n`);
        return;
      }

      // Got SDP → SETUP with TCP interleaved
      if (authed && !setupDone && data.includes('200 OK') && data.includes('v=0')) {
        setupDone = true;
        const trackUri = `${uri}/trackID=0`;
        data = '';
        client.write(`SETUP ${trackUri} RTSP/1.0\r\nCSeq: ${cseq++}\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n`);
        return;
      }

      // SETUP response → PLAY
      if (setupDone && !playing && data.includes('200 OK') && data.includes('Session')) {
        const session = data.match(/Session:\s*([^;\r\n]+)/)?.[1]?.trim() || '';
        playing = true;
        data = '';
        client.write(`PLAY ${uri} RTSP/1.0\r\nCSeq: ${cseq++}\r\nSession: ${session}\r\nRange: npt=0.000-\r\n\r\n`);

        setTimeout(() => {
          client.write(`TEARDOWN ${uri} RTSP/1.0\r\nCSeq: ${cseq++}\r\nSession: ${session}\r\n\r\n`);
          setTimeout(() => { client.destroy(); finish(); }, 300);
        }, probeDurationMs);
        return;
      }
    });

    client.on('close', () => finish());
    client.on('error', () => finish());
    client.on('timeout', () => { client.destroy(); finish(); });
    setTimeout(() => { client.destroy(); finish(); }, probeDurationMs + 10000);
  });
}

/** Minimum bytes in 2s to consider video actually flowing (15 KB).
 *  Real camera substreams give ~25+ KB/2s, while "no signal" placeholders are ~9 KB/2s. */
const MIN_VIDEO_BYTES = 15 * 1024;

/**
 * Checks a list of cameras via RTSP DESCRIBE + optional data flow probe.
 *
 * @param {Array<{ip: string, name: string, index: number, rtspPath?: string, viaNvr?: boolean}>} cameras
 * @param {string} user - RTSP username
 * @param {string} pass - RTSP password
 * @param {string} systemId
 * @param {object} opts - { nvrIp, nvrRtspUser, nvrRtspPass, probeVideo }
 * @returns {Promise<{cameras: Array, error: string|null}>}
 */
export async function checkCamerasByRtsp(cameras, user, pass, systemId = 'rtsp', { nvrIp, nvrRtspUser, nvrRtspPass, probeVideo = false } = {}) {
  const step = `${systemId}:rtsp`;
  log.info(step, 'Проверка камер по RTSP', { count: cameras.length, user, probe: probeVideo });

  const results = [];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let camIdx = 0; camIdx < cameras.length; camIdx++) {
    const cam = cameras[camIdx];
    if (camIdx > 0) await sleep(250); // unburden NVR between sequential RTSP sessions
    const rtspPath = cam.rtspPath || '/ch01/0';
    const targetIp = cam.viaNvr ? (nvrIp || cam.ip) : cam.ip;
    const targetUser = cam.viaNvr ? (nvrRtspUser || user) : user;
    const targetPass = cam.viaNvr ? (nvrRtspPass || pass) : pass;
    const desc = await rtspDescribe(targetIp, rtspPath, targetUser, targetPass);

    let online = desc.ok;
    let notes = '';
    let videoOk = null;

    if (desc.ok) {
      // bitrate:0 in SDP = definite no-signal
      if (desc.bitrate === 0) {
        online = false;
        notes = `Нет видеосигнала (${cam.viaNvr ? 'NVR ch' + (cam.nvrChannel || cam.index + 1) : cam.ip})`;
        videoOk = false;
      }
      // For viaNvr cameras with non-zero bitrate, probe actual data flow
      else if (cam.viaNvr && probeVideo) {
        const bytes = await rtspProbeDataFlow(targetIp, rtspPath, targetUser, targetPass);
        const kb = Math.round(bytes / 1024);
        videoOk = bytes >= MIN_VIDEO_BYTES;
        log.debug(step, `Probe ${cam.name}`, { kb, threshold: Math.round(MIN_VIDEO_BYTES / 1024), ok: videoOk });
        if (!videoOk) {
          online = false;
          notes = `Нет видеосигнала (${kb}KB/2s, NVR ch${cam.nvrChannel || cam.index + 1})`;
        }
      }

      if (online) {
        const parts = [cam.viaNvr ? `NVR ch${cam.nvrChannel || cam.index + 1}` : cam.ip];
        if (desc.codec) parts.push(desc.codec);
        if (desc.resolution) parts.push(desc.resolution);
        if (desc.fps) parts.push(`${desc.fps}fps`);
        if (desc.audio) parts.push('audio');
        notes = parts.join(', ');
      }
    } else if (desc.error === 'auth_failed') {
      notes = `RTSP auth failed (${cam.ip})`;
    } else {
      notes = `RTSP недоступен: ${desc.error} (${cam.ip})`;
    }

    results.push({
      index: cam.index,
      id: cam.index + 1,
      name: cam.name || `Камера ${cam.index + 1}`,
      online,
      recording: 'unknown',
      audio: desc.ok ? desc.audio : 'unknown',
      type: 'ip',
      resolution: desc.resolution || '',
      ip: cam.ip,
      // Сохраняем поля из config — нужны snapshots.js → snapRtsp() для
      // сборки RTSP URL (через NVR или напрямую на камеру)
      viaNvr:     cam.viaNvr,
      rtspPath:   cam.rtspPath,
      nvrChannel: cam.nvrChannel,
      videoOk,
      notes,
    });
  }

  const online = results.filter(c => c.online).length;
  const offline = results.filter(c => !c.online).length;
  log.info(step, 'RTSP проверка завершена', { online, offline, total: results.length });

  return { cameras: results, error: null };
}
