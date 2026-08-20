/**
 * hikvision-multi.js — Проверка набора одиночных Hikvision-камер.
 *
 * Каждая камера — самостоятельное устройство со своим IP/портом и кредами.
 * 1. /ISAPI/System/deviceInfo (digest) — онлайн/офлайн.
 * 2. /ISAPI/ContentMgmt/record/tracks  — активный track ID и Enable.
 * 3. /ISAPI/ContentMgmt/search (POST)  — самый свежий записанный сегмент;
 *    если endTime моложе MAX_STALE_HOURS — recording=true + recordingFresh=true.
 */

import crypto from 'crypto';
import * as log from './logger.js';
import { isapiRequest } from './isapi.js';

const TIMEOUT_MS = 12000;
const MAX_STALE_HOURS = 6;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function tag(xml, name) {
  const m = xml && xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? m[1] : null;
}

function ageString(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}м назад`;
  return `${Math.round(ms / 3600_000)}ч назад`;
}

async function checkRecording(baseUrl, user, pass) {
  // 1. tracks → найти активный
  let tracksXml;
  try {
    tracksXml = await withTimeout(
      isapiRequest(baseUrl, '/ISAPI/ContentMgmt/record/tracks', user, pass),
      TIMEOUT_MS,
    );
  } catch (err) {
    return { recording: 'unknown', extra: `tracks: ${err.message}` };
  }

  // Берём первый Track с Enable=true
  const trackBlocks = tracksXml.split('<Track ').slice(1);
  let activeTrackId = null;
  let scheduleHasRecord = false;
  for (const block of trackBlocks) {
    const enable = tag(block, 'Enable');
    if (enable !== 'true') continue;
    const id = parseInt(tag(block, 'id') || '0');
    if (!id) continue;
    activeTrackId = id;
    scheduleHasRecord = block.includes('<Record>true</Record>');
    break;
  }

  if (!activeTrackId) {
    return { recording: false, extra: 'запись отключена' };
  }
  if (!scheduleHasRecord) {
    return { recording: false, extra: 'нет расписания записи' };
  }

  // 2. CMSearch за последние MAX_STALE_HOURS часов
  const now = new Date();
  const start = new Date(now.getTime() - MAX_STALE_HOURS * 3600_000);
  const fmt = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
  const body = `<?xml version="1.0" encoding="UTF-8"?><CMSearchDescription><searchID>${crypto.randomUUID()}</searchID><trackIDList><trackID>${activeTrackId}</trackID></trackIDList><timeSpanList><timeSpan><startTime>${fmt(start)}</startTime><endTime>${fmt(now)}</endTime></timeSpan></timeSpanList><maxResults>40</maxResults><searchResultPostion>0</searchResultPostion><metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>`;

  let searchXml;
  try {
    searchXml = await withTimeout(
      isapiRequest(baseUrl, '/ISAPI/ContentMgmt/search', user, pass, { method: 'POST', body }),
      TIMEOUT_MS,
    );
  } catch (err) {
    return { recording: 'unknown', extra: `search: ${err.message}` };
  }

  const numMatches = parseInt(tag(searchXml, 'numOfMatches') || '0');
  if (numMatches === 0) {
    return { recording: false, extra: `нет записей за ${MAX_STALE_HOURS}ч` };
  }

  // Берём максимальный endTime среди всех matchItem
  const endTimes = [...searchXml.matchAll(/<endTime>([^<]+)<\/endTime>/g)]
    .map(m => new Date(m[1]).getTime())
    .filter(t => !isNaN(t));
  if (endTimes.length === 0) {
    return { recording: 'unknown', extra: 'не удалось распарсить endTime' };
  }
  const latest = Math.max(...endTimes);
  const ageMs = now.getTime() - latest;
  const fresh = ageMs < MAX_STALE_HOURS * 3600_000;
  return {
    recording: fresh,
    recordingFresh: fresh,
    recordingAge: ageString(ageMs),
    extra: fresh ? '' : `запись устарела (${ageString(ageMs)})`,
  };
}

async function checkOne(cam) {
  const port = cam.port || 80;
  const baseUrl = `http://${cam.host}:${port}`;
  try {
    const xml = await withTimeout(
      isapiRequest(baseUrl, '/ISAPI/System/deviceInfo', cam.user, cam.pass),
      TIMEOUT_MS,
    );
    const model      = tag(xml, 'model')      || '';
    const deviceName = tag(xml, 'deviceName') || '';
    const baseNotes  = [model, deviceName].filter(Boolean).join(' / ');

    const rec = await checkRecording(baseUrl, cam.user, cam.pass);
    const notesParts = [baseNotes, rec.extra].filter(Boolean);
    return {
      online: true,
      recording: rec.recording,
      recordingFresh: rec.recordingFresh,
      recordingAge: rec.recordingAge,
      notes: notesParts.join(' · '),
    };
  } catch (err) {
    const reason = err.message.includes('fetch failed') || err.message.includes('timeout')
      ? `нет соединения (${cam.host}:${port})`
      : err.message;
    return { online: false, recording: 'unknown', notes: reason };
  }
}

/**
 * @param {object} sys
 * @param {string} sys.id
 * @param {Array<{index,name,host,port,userEnv,passEnv,user?,pass?}>} sys.cameras
 */
export async function checkHikvisionMultiSystem(sys) {
  const step = `${sys.id}:isapi`;
  log.info(step, 'Проверка одиночных Hikvision-камер', { count: sys.cameras.length });

  const results = [];
  for (const cam of sys.cameras) {
    const user = cam.user || (cam.userEnv ? process.env[cam.userEnv] : '');
    const pass = cam.pass || (cam.passEnv ? process.env[cam.passEnv] : '');
    if (!user || !pass) {
      results.push({
        index: cam.index,
        name:  cam.name,
        online: 'unknown',
        recording: 'unknown',
        audio: 'unknown',
        notes: 'нет логина/пароля в .env',
      });
      continue;
    }
    const r = await checkOne({ host: cam.host, port: cam.port, user, pass });
    if (!r.online) log.warn(step, `${cam.name} offline`, { host: cam.host, port: cam.port, err: r.notes });
    results.push({
      index: cam.index,
      name:  cam.name,
      // Сохраняем host/port + ENV-имена кредсов из config (нужны для съёма
      // snapshot'а на v2 — snapshots.js берёт user/pass из process.env по ним)
      host:    cam.host,
      port:    cam.port,
      userEnv: cam.userEnv,
      passEnv: cam.passEnv,
      online: r.online,
      recording: r.recording,
      recordingFresh: r.recordingFresh,
      recordingAge: r.recordingAge,
      audio: 'unknown',
      notes: r.notes || '',
    });
  }

  const online  = results.filter(r => r.online === true).length;
  const offline = results.filter(r => r.online === false).length;
  const recOk   = results.filter(r => r.recording === true).length;
  log.info(step, 'Готово', { online, offline, recording: recOk, total: results.length });

  return { cameras: results, error: null };
}
