/**
 * isapi.js — Hikvision/HiWatch ISAPI client
 * Fetches camera statuses and recording config via HTTP digest auth.
 */

import crypto from 'crypto';
import * as log from './logger.js';

/** Cached digest auth params per baseUrl */
const digestCache = {};

/**
 * Makes a digest-auth request to ISAPI endpoint (GET or POST).
 */
export async function isapiRequest(baseUrl, path, user, pass, { method = 'GET', body = null } = {}) {
  const url = `${baseUrl}${path}`;
  const headers = { 'Accept': 'application/xml' };
  if (body) headers['Content-Type'] = 'application/xml';

  // Try cached auth first
  const cached = digestCache[baseUrl];
  if (cached) {
    cached.nc++;
    const authHeader = buildDigestHeader(cached, user, method, path);
    const resp = await fetch(url, { method, headers: { ...headers, 'Authorization': authHeader }, body });
    if (resp.ok) return await resp.text();
    if (resp.status !== 401) throw new Error(`ISAPI ${path} returned ${resp.status}`);
    // Nonce expired, fall through to re-auth
    delete digestCache[baseUrl];
  }

  // First request without auth to get the nonce
  const resp1 = await fetch(url, { method, headers, body });

  if (resp1.status !== 401) {
    if (resp1.ok) return await resp1.text();
    throw new Error(`Unexpected status ${resp1.status}`);
  }

  const wwwAuth = resp1.headers.get('www-authenticate');
  if (!wwwAuth || !wwwAuth.toLowerCase().startsWith('digest')) {
    throw new Error('Server does not support Digest auth');
  }

  const params = {
    realm: extractParam(wwwAuth, 'realm'),
    nonce: extractParam(wwwAuth, 'nonce'),
    qop: extractParam(wwwAuth, 'qop'),
    opaque: extractParam(wwwAuth, 'opaque'),
    nc: 1,
    ha1: md5(`${user}:${extractParam(wwwAuth, 'realm')}:${pass}`),
  };
  digestCache[baseUrl] = params;

  const authHeader = buildDigestHeader(params, user, method, path);
  const resp2 = await fetch(url, { method, headers: { ...headers, 'Authorization': authHeader }, body });

  if (!resp2.ok) throw new Error(`ISAPI ${path} returned ${resp2.status}`);
  return await resp2.text();
}

/**
 * Аналог isapiRequest, но возвращает Buffer (для бинарных endpoint'ов
 * вроде /Streaming/channels/<N>/picture). Использует тот же digestCache.
 *
 * @returns {Promise<Buffer>}
 */
export async function isapiGetBinary(baseUrl, path, user, pass) {
  const url = `${baseUrl}${path}`;

  // Сначала пробуем кэшированную auth
  const cached = digestCache[baseUrl];
  if (cached) {
    cached.nc++;
    const authHeader = buildDigestHeader(cached, user, 'GET', path);
    const resp = await fetch(url, { headers: { 'Authorization': authHeader } });
    if (resp.ok) return Buffer.from(await resp.arrayBuffer());
    if (resp.status !== 401) throw new Error(`ISAPI binary ${path} returned ${resp.status}`);
    delete digestCache[baseUrl];
  }

  const resp1 = await fetch(url, {});
  if (resp1.status !== 401) {
    if (resp1.ok) return Buffer.from(await resp1.arrayBuffer());
    throw new Error(`ISAPI binary unexpected status ${resp1.status}`);
  }

  const wwwAuth = resp1.headers.get('www-authenticate');
  if (!wwwAuth || !wwwAuth.toLowerCase().startsWith('digest')) {
    throw new Error('Server does not support Digest auth');
  }
  const params = {
    realm:  extractParam(wwwAuth, 'realm'),
    nonce:  extractParam(wwwAuth, 'nonce'),
    qop:    extractParam(wwwAuth, 'qop'),
    opaque: extractParam(wwwAuth, 'opaque'),
    nc: 1,
    ha1: md5(`${user}:${extractParam(wwwAuth, 'realm')}:${pass}`),
  };
  digestCache[baseUrl] = params;

  const authHeader = buildDigestHeader(params, user, 'GET', path);
  const resp2 = await fetch(url, { headers: { 'Authorization': authHeader } });
  if (!resp2.ok) throw new Error(`ISAPI binary ${path} returned ${resp2.status}`);
  return Buffer.from(await resp2.arrayBuffer());
}

function buildDigestHeader(params, user, method, path) {
  const nc = params.nc.toString(16).padStart(8, '0');
  const cnonce = Math.random().toString(36).substring(2, 10);
  const ha2Str = `${method}:${path}`;

  const ha2 = crypto.createHash('md5').update(ha2Str).digest('hex');

  let response;
  if (params.qop) {
    response = crypto.createHash('md5').update(`${params.ha1}:${params.nonce}:${nc}:${cnonce}:${params.qop}:${ha2}`).digest('hex');
  } else {
    response = crypto.createHash('md5').update(`${params.ha1}:${params.nonce}:${ha2}`).digest('hex');
  }

  let header = `Digest username="${user}", realm="${params.realm}", nonce="${params.nonce}", uri="${path}", response="${response}"`;
  if (params.qop) header += `, qop=${params.qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (params.opaque) header += `, opaque="${params.opaque}"`;
  return header;
}

function extractParam(header, name) {
  const match = header.match(new RegExp(`${name}="?([^",]+)"?`));
  return match ? match[1] : '';
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * Simple XML tag value extractor (no XML parser dependency).
 */
function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? match[1] : null;
}

function extractAllBlocks(xml, tag) {
  const blocks = [];
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = regex.exec(xml)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

/**
 * Fetches all camera statuses from a Hikvision/HiWatch DVR/NVR via ISAPI.
 *
 * @param {string} baseUrl - e.g. "http://nvr.example.local"
 * @param {string} user
 * @param {string} pass
 * @returns {Promise<{cameras: Array, error: string|null}>}
 */
export async function fetchHikvisionStatus(baseUrl, user, pass, { maxChannelId = Infinity } = {}) {
  const step = 'isapi';
  const cameras = [];

  try {
    // 1. Analog/local channels
    log.info(step, 'Запрос каналов видеовхода', { url: baseUrl });
    const inputsXml = await isapiRequest(baseUrl, '/ISAPI/System/Video/inputs/channels', user, pass);
    const channels = extractAllBlocks(inputsXml, 'VideoInputChannel');

    for (const ch of channels) {
      const id = extractTag(ch, 'id');
      if (parseInt(id) > maxChannelId) continue;
      const name = extractTag(ch, 'name') || `Channel ${id}`;
      const resDesc = extractTag(ch, 'resDesc') || '';
      const online = resDesc !== 'NO VIDEO' && resDesc !== '';

      cameras.push({
        index: parseInt(id) - 1,
        id: parseInt(id),
        name,
        online,
        recording: 'unknown', // will be filled from tracks
        audio: 'unknown',
        type: 'analog',
        resolution: resDesc,
        notes: online ? resDesc : 'NO VIDEO',
      });
    }

    // 2. IP cameras status (skip if maxChannelId limits to analog only)
    if (maxChannelId === Infinity) try {
      const ipStatusXml = await isapiRequest(baseUrl, '/ISAPI/ContentMgmt/InputProxy/channels/status', user, pass);
      const ipChannels = extractAllBlocks(ipStatusXml, 'InputProxyChannelStatus');

      for (const ipCh of ipChannels) {
        const id = extractTag(ipCh, 'id');
        const online = extractTag(ipCh, 'online') === 'true';
        const detectResult = extractTag(ipCh, 'chanDetectResult') || '';
        const ipAddress = extractTag(ipCh, 'ipAddress') || '';

        // Find if already in cameras list or add new
        const existing = cameras.find(c => c.id === parseInt(id));
        if (existing) {
          existing.online = online;
          existing.type = 'ip';
          existing.notes = online ? `IP: ${ipAddress}, ${detectResult}` : `IP: ${ipAddress}, ${detectResult}`;
        } else {
          // Get name from InputProxy/channels
          cameras.push({
            index: parseInt(id) - 1,
            id: parseInt(id),
            name: `IPCamera (${ipAddress})`,
            online,
            recording: 'unknown',
            audio: 'unknown',
            type: 'ip',
            resolution: '',
            notes: `${detectResult}${ipAddress ? `, IP: ${ipAddress}` : ''}`,
          });
        }
      }
    } catch (err) {
      log.warn(step, 'IP камеры: не удалось получить статус', { error: err.message });
    }

    // 3. Recording tracks — check which channels have recording enabled
    try {
      const tracksXml = await isapiRequest(baseUrl, '/ISAPI/ContentMgmt/record/tracks', user, pass);
      const tracks = extractAllBlocks(tracksXml, 'Track');

      for (const track of tracks) {
        const srcChannel = extractTag(track, 'SrcChannel');
        if (!srcChannel) continue;
        const chId = parseInt(srcChannel);

        // Check if any schedule action has Record=true
        const hasRecord = track.includes('<Record>true</Record>');

        const cam = cameras.find(c => c.id === chId);
        if (cam) {
          cam.recording = hasRecord;
        }
      }
    } catch (err) {
      log.warn(step, 'Записи: не удалось получить треки', { error: err.message });
    }

    // 4. Check actual recording freshness via search
    const maxStaleHours = 6;
    log.info(step, 'Проверка свежести записей', { maxStaleHours });
    const now = new Date();
    const searchStart = new Date(now.getTime() - maxStaleHours * 3600_000);

    for (const cam of cameras) {
      if (!cam.online) continue; // offline cameras can't record
      const trackId = cam.id * 100 + 1; // e.g. channel 1 → track 101
      try {
        const searchXml = await isapiRequest(baseUrl, '/ISAPI/ContentMgmt/search', user, pass, {
          method: 'POST',
          body: `<?xml version="1.0" encoding="UTF-8"?><CMSearchDescription><searchID>${crypto.randomUUID()}</searchID><trackIDList><trackID>${trackId}</trackID></trackIDList><timeSpanList><timeSpan><startTime>${searchStart.toISOString().replace(/\.\d+Z/, 'Z')}</startTime><endTime>${now.toISOString().replace(/\.\d+Z/, 'Z')}</endTime></timeSpan></timeSpanList><maxResults>1</maxResults><searchResultPostion>0</searchResultPostion><metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>`,
        });

        const numMatches = parseInt(extractTag(searchXml, 'numOfMatches') || '0');
        if (numMatches > 0) {
          const endTimeStr = extractTag(searchXml, 'endTime');
          if (endTimeStr) {
            const endTime = new Date(endTimeStr);
            const ageMs = now.getTime() - endTime.getTime();
            const ageMin = Math.round(ageMs / 60000);
            if (ageMs < maxStaleHours * 3600_000) {
              cam.recordingFresh = true;
              cam.recordingAge = `${ageMin}м назад`;
            } else {
              cam.recordingFresh = false;
              cam.recordingAge = `${Math.round(ageMs / 3600_000)}ч назад`;
              cam.notes += cam.notes ? ', ' : '';
              cam.notes += `Запись устарела (${cam.recordingAge})`;
            }
          }
        } else {
          cam.recordingFresh = false;
          cam.recordingAge = 'нет записей';
          cam.notes += cam.notes ? ', ' : '';
          cam.notes += `Нет записей за ${maxStaleHours}ч`;
        }
      } catch {
        // Search not supported or failed — skip silently
      }
    }

    const freshCount = cameras.filter(c => c.recordingFresh === true).length;
    const staleCount = cameras.filter(c => c.recordingFresh === false).length;
    log.info(step, 'Записи проверены', { fresh: freshCount, stale: staleCount });

    // 5. Get IP camera names from InputProxy/channels
    try {
      const ipChXml = await isapiRequest(baseUrl, '/ISAPI/ContentMgmt/InputProxy/channels', user, pass);
      const ipChBlocks = extractAllBlocks(ipChXml, 'InputProxyChannel');

      for (const block of ipChBlocks) {
        const id = extractTag(block, 'id');
        const name = extractTag(block, 'name');
        if (id && name) {
          const cam = cameras.find(c => c.id === parseInt(id));
          if (cam) cam.name = name;
        }
      }
    } catch {
      // Not critical
    }

    const online = cameras.filter(c => c.online === true).length;
    const offline = cameras.filter(c => c.online === false).length;
    log.info(step, 'ISAPI: статусы получены', {
      total: cameras.length,
      online,
      offline,
    });

    return { cameras, error: null };

  } catch (err) {
    log.error(step, 'ISAPI: ошибка запроса', { error: err.message });
    return { cameras: [], error: err.message };
  }
}
