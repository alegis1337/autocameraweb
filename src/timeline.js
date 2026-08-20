/**
 * timeline.js — Журнал событий за день (light/daily-режимы).
 *
 * Хранит за каждую дату:
 *   • массив events (offline/online/recording-stop/recording-start/...)
 *   • текущее «состояние» каждой камеры (для diff'а с очередным прогоном)
 *
 * Используется так:
 *   1. light-прогон каждые 15 мин:
 *        const tl = loadTodayTimeline();
 *        const newEvents = diffAndAppend(tl, systemResults, now);
 *        saveTimeline(tl);   // даже если newEvents пуст — обновили lastSeen
 *   2. daily-прогон (вечером):
 *        const tl = loadTodayTimeline();
 *        const summary = summarize(tl, now);   // массив { systemId, camera, downtimeMin, ... }
 *
 * Файл: state/timeline-YYYY-MM-DD.json (gitignored).
 *
 * Камера считается «broken», если cam.online === false ИЛИ cam.recording === false
 * (последнее — только если sys.expectedRecording !== false). Логика совпадает
 * с reporter.collectBrokenCameras().
 */

import fs from 'fs';
import path from 'path';
import { isUnusedChannel } from './reporter.js';

const TIMELINE_DIR = path.resolve('state');

function timelinePath(ymd) {
  return path.join(TIMELINE_DIR, `timeline-${ymd}.json`);
}

/** YYYY-MM-DD по локальному времени. */
export function todayYmd(date = new Date()) {
  const y  = date.getFullYear();
  const m  = String(date.getMonth() + 1).padStart(2, '0');
  const d  = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** HH:MM:SS по локальному времени. */
function hms(date = new Date()) {
  return date.toLocaleTimeString('ru-RU', { hour12: false });
}

/**
 * Уникальный ключ камеры в timeline-структуре.
 * Совпадает по схеме с state.cameraKey, чтобы при отладке было удобно сравнивать.
 */
export function cameraKey(systemId, cameraName) {
  return `${systemId}|${cameraName}`;
}

/**
 * Читает timeline за указанную дату. Если файла нет — возвращает пустой.
 */
export function loadTimeline(ymd = todayYmd()) {
  fs.mkdirSync(TIMELINE_DIR, { recursive: true });
  const file = timelinePath(ymd);
  if (!fs.existsSync(file)) {
    return { date: ymd, startedAt: null, lastRun: null, cameras: {}, events: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      date:      parsed.date      || ymd,
      startedAt: parsed.startedAt || null,
      lastRun:   parsed.lastRun   || null,
      cameras:   parsed.cameras   || {},
      events:    Array.isArray(parsed.events) ? parsed.events : [],
    };
  } catch {
    return { date: ymd, startedAt: null, lastRun: null, cameras: {}, events: [] };
  }
}

/** Сегодняшний timeline. */
export const loadTodayTimeline = () => loadTimeline(todayYmd());

/**
 * Атомарно сохраняет timeline.
 */
export function saveTimeline(timeline) {
  fs.mkdirSync(TIMELINE_DIR, { recursive: true });
  const file = timelinePath(timeline.date || todayYmd());
  const tmp  = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(timeline, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Удаляет timeline-файлы старше N дней.
 */
export function cleanOldTimelines(days = 30) {
  fs.mkdirSync(TIMELINE_DIR, { recursive: true });
  const cutoff = Date.now() - days * 86400_000;
  for (const f of fs.readdirSync(TIMELINE_DIR)) {
    if (!/^timeline-\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
    const full = path.join(TIMELINE_DIR, f);
    if (fs.statSync(full).mtimeMs < cutoff) {
      try { fs.unlinkSync(full); } catch { /* ignore */ }
    }
  }
}

// ─── Diff и события ───────────────────────────────────────────────────────────

/**
 * Извлекает «текущий статус» камеры. Возвращает один из:
 *   'online'           — всё в порядке
 *   'offline'          — cam.online === false
 *   'no-recording'     — online, но recording === false и ожидается запись
 *   'unknown'          — нет данных (cam.online == null / unknown)
 */
function statusOf(sys, cam) {
  if (cam.online === false) return 'offline';
  if (cam.online === true) {
    const expectRec = sys.expectedRecording !== false;
    if (expectRec && cam.recording === false) return 'no-recording';
    return 'online';
  }
  return 'unknown';
}

/**
 * Сравнивает текущее состояние с timeline и добавляет события.
 * Возвращает массив новых событий (для логирования).
 *
 * Мутирует timeline.cameras и timeline.events.
 *
 * @param {object} timeline       — результат loadTimeline()
 * @param {Array}  systemResults  — результат main-pipeline
 * @param {Date}   [now]
 */
export function diffAndAppend(timeline, systemResults, now = new Date()) {
  const nowIso = now.toISOString();
  const nowHms = hms(now);
  if (!timeline.startedAt) timeline.startedAt = nowIso;

  const newEvents = [];
  const seenKeys  = new Set();

  for (const sys of systemResults) {
    if (!sys || !Array.isArray(sys.cameras)) continue;
    for (const cam of sys.cameras) {
      // Серые/неиспользуемые камеры (unusedChannels, knownOffline для TRASSIR)
      // не должны попадать в журнал событий. Иначе они стабильно фиксируются
      // как offline и засоряют "Историю за день" и helpdesk-сводки.
      if (isUnusedChannel(sys, cam)) continue;

      const key = cameraKey(sys.id, cam.name || `Камера ${cam.index + 1}`);
      seenKeys.add(key);

      const newStatus = statusOf(sys, cam);
      const prev = timeline.cameras[key];
      const reason = cam.notes || '';

      if (!prev) {
        // Первое появление камеры в журнале за этот день
        timeline.cameras[key] = {
          systemId:   sys.id,
          system:     sys.name,
          group:      sys.group || '',
          camera:     cam.name || `Камера ${cam.index + 1}`,
          // index нужен monitor-db/веб-карте, чтобы найти снимок камеры в
          // screenshots/last-good/ (имя файла — "<index>-<имя>.jpg").
          index:      cam.index ?? null,
          status:     newStatus,
          since:      nowIso,
          lastSeen:   nowIso,
          lastReason: reason,
        };
        // Если первая запись — уже broken, фиксируем «offline-start»-событие
        if (newStatus === 'offline' || newStatus === 'no-recording') {
          const ev = {
            ts:       nowHms,
            tsIso:    nowIso,
            systemId: sys.id,
            system:   sys.name,
            camera:   timeline.cameras[key].camera,
            event:    newStatus === 'offline' ? 'offline' : 'no-recording',
            reason,
          };
          timeline.events.push(ev);
          newEvents.push(ev);
        }
        continue;
      }

      if (prev.status === newStatus) {
        // Статус не изменился — просто обновляем lastSeen
        prev.lastSeen = nowIso;
        if (reason) prev.lastReason = reason;
        continue;
      }

      // Статус сменился
      const wasBroken = prev.status === 'offline' || prev.status === 'no-recording';
      const isBroken  = newStatus === 'offline' || newStatus === 'no-recording';

      if (wasBroken && !isBroken && newStatus === 'online') {
        // Восстановление
        const sinceMs = new Date(prev.since).getTime();
        const downMin = Math.max(0, Math.round((now.getTime() - sinceMs) / 60_000));
        const ev = {
          ts:           nowHms,
          tsIso:        nowIso,
          systemId:     sys.id,
          system:       sys.name,
          camera:       prev.camera,
          event:        'online',
          prevEvent:    prev.status,
          downtimeMin:  downMin,
          downSinceTs:  hmsFromIso(prev.since),
        };
        timeline.events.push(ev);
        newEvents.push(ev);
      } else if (!wasBroken && isBroken) {
        // Падение
        const ev = {
          ts:       nowHms,
          tsIso:    nowIso,
          systemId: sys.id,
          system:   sys.name,
          camera:   prev.camera,
          event:    newStatus === 'offline' ? 'offline' : 'no-recording',
          reason,
        };
        timeline.events.push(ev);
        newEvents.push(ev);
      } else if (wasBroken && isBroken && prev.status !== newStatus) {
        // offline → no-recording или обратно
        const ev = {
          ts:        nowHms,
          tsIso:     nowIso,
          systemId:  sys.id,
          system:    sys.name,
          camera:    prev.camera,
          event:     newStatus,
          prevEvent: prev.status,
          reason,
        };
        timeline.events.push(ev);
        newEvents.push(ev);
      }

      // Обновляем состояние камеры
      timeline.cameras[key] = {
        ...prev,
        status:     newStatus,
        since:      nowIso,
        lastSeen:   nowIso,
        lastReason: reason,
      };
    }
  }

  timeline.lastRun = nowIso;
  return newEvents;
}

function hmsFromIso(iso) {
  try { return hms(new Date(iso)); } catch { return ''; }
}

// ─── Агрегация для daily-отчёта ──────────────────────────────────────────────

/**
 * Собирает по timeline.events таблицу простоев за день.
 *
 * Если камера ещё «лежит» на момент агрегации (нет события online после
 * последнего offline), интервал закрывается «сейчас».
 *
 * @returns {Array<{ systemId, system, camera, incidents,
 *                   intervals: Array<{from, to, ongoing}>,
 *                   currentlyDown }>}
 */
export function summarize(timeline, now = new Date()) {
  // Группируем события по камере
  const byCam = new Map();
  for (const ev of timeline.events) {
    const key = cameraKey(ev.systemId, ev.camera);
    if (!byCam.has(key)) byCam.set(key, []);
    byCam.get(key).push(ev);
  }

  const rows = [];
  for (const [key, events] of byCam.entries()) {
    const sorted = events.slice().sort((a, b) =>
      String(a.tsIso || '').localeCompare(String(b.tsIso || ''))
    );

    let incidents      = 0;
    let openOfflineIso = null;            // начало текущего «незакрытого» падения
    let openOfflineTs  = null;            // HH:MM:SS того же момента
    const intervals    = [];              // [{ from: "HH:MM", to: "HH:MM"|null, ongoing }]

    for (const ev of sorted) {
      if (ev.event === 'offline' || ev.event === 'no-recording') {
        if (!openOfflineIso) {
          openOfflineIso = ev.tsIso;
          openOfflineTs  = ev.ts;
          incidents++;
        }
        // если уже открыт — смена типа поломки, не считаем новым инцидентом
      } else if (ev.event === 'online') {
        if (openOfflineIso) {
          intervals.push({
            from:    openOfflineTs.slice(0, 5),  // HH:MM
            to:      ev.ts.slice(0, 5),
            ongoing: false,
          });
          openOfflineIso = null;
          openOfflineTs  = null;
        }
      }
    }

    let currentlyDown = false;
    if (openOfflineIso) {
      currentlyDown = true;
      intervals.push({
        from:    openOfflineTs.slice(0, 5),
        to:      null,                                      // ещё не закрылось
        ongoing: true,
      });
    }

    if (incidents === 0) continue;

    const [systemId, camera] = key.split('|');
    const meta = timeline.cameras[key] || {};
    rows.push({
      systemId,
      system:        meta.system || systemId,
      group:         meta.group  || '',
      camera,
      incidents,
      intervals,
      currentlyDown,
    });
  }

  // Сортируем: текущие сбои наверху, дальше — по числу инцидентов
  rows.sort((a, b) => {
    if (a.currentlyDown !== b.currentlyDown) return b.currentlyDown ? 1 : -1;
    return b.incidents - a.incidents;
  });
  return rows;
}

/**
 * Кратко форматирует длительность в минутах для отчёта (1ч 23м, 45м, и т.п.).
 */
export function formatDuration(min) {
  if (!min || min <= 0) return '<1 мин';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}

// ─── Период: загрузка диапазона timeline-файлов ──────────────────────────────

/** Итератор YYYY-MM-DD от fromYmd до toYmd включительно. */
function* iterYmdRange(fromYmd, toYmd) {
  const start = new Date(fromYmd + 'T00:00:00');
  const end   = new Date(toYmd   + 'T00:00:00');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    yield todayYmd(new Date(t));
  }
}

/**
 * Загружает все timeline-файлы за период [fromYmd .. toYmd] включительно.
 * Дни, в которые файла нет — пропускаются (как будто там нет инцидентов).
 *
 * @returns {{ ymd: string, timeline: object }[]}
 */
export function loadTimelinesRange(fromYmd, toYmd) {
  const out = [];
  for (const ymd of iterYmdRange(fromYmd, toYmd)) {
    const file = timelinePath(ymd);
    if (!fs.existsSync(file)) continue;
    out.push({ ymd, timeline: loadTimeline(ymd) });
  }
  return out;
}

/**
 * Из массива событий за один день строит { incidents, intervals, downMin }.
 * Используется как для summarize() (один день), так и для summarizePeriod() (по каждой дате).
 */
function buildDayBreakdown(events, dayBoundary) {
  let incidents      = 0;
  let openOfflineIso = null;
  let openOfflineTs  = null;
  const intervals    = [];
  let downMin        = 0;

  const sorted = events.slice().sort((a, b) =>
    String(a.tsIso || '').localeCompare(String(b.tsIso || ''))
  );

  for (const ev of sorted) {
    if (ev.event === 'offline' || ev.event === 'no-recording') {
      if (!openOfflineIso) {
        openOfflineIso = ev.tsIso;
        openOfflineTs  = ev.ts;
        incidents++;
      }
    } else if (ev.event === 'online') {
      if (openOfflineIso) {
        const min = Math.max(0, Math.round((new Date(ev.tsIso).getTime() - new Date(openOfflineIso).getTime()) / 60_000));
        downMin += min;
        intervals.push({
          from:    openOfflineTs.slice(0, 5),
          to:      ev.ts.slice(0, 5),
          ongoing: false,
        });
        openOfflineIso = null;
        openOfflineTs  = null;
      }
    }
  }

  // Незакрытый интервал — считаем до dayBoundary (конца дня)
  let currentlyDown = false;
  if (openOfflineIso) {
    currentlyDown = true;
    const endMs = dayBoundary.getTime();
    const min = Math.max(0, Math.round((endMs - new Date(openOfflineIso).getTime()) / 60_000));
    downMin += min;
    intervals.push({
      from:    openOfflineTs.slice(0, 5),
      to:      null,
      ongoing: true,
    });
  }

  return { incidents, intervals, downMin, currentlyDown };
}

/**
 * Агрегация инцидентов за период по всем загруженным timeline'ам.
 * Для каждой камеры возвращает суммарные показатели + breakdown по дням.
 *
 * @param {{ymd: string, timeline: object}[]} loaded — результат loadTimelinesRange
 * @returns {Array<{
 *   systemId, system, group, camera,
 *   incidents,               // суммарно за весь период
 *   totalDownMin,            // суммарный простой в минутах
 *   currentlyDown,           // была offline в последний день периода
 *   days: Array<{
 *     date: string,          // YYYY-MM-DD
 *     incidents: number,
 *     downMin: number,
 *     intervals: Array<{from, to, ongoing}>,
 *   }>
 * }>}
 */
export function summarizePeriod(loaded, now = new Date()) {
  // camKey → { meta, days: Map<ymd, { events: [], cameraMeta }> }
  const byCam = new Map();

  for (const { ymd, timeline } of loaded) {
    for (const ev of timeline.events || []) {
      const key = cameraKey(ev.systemId, ev.camera);
      if (!byCam.has(key)) {
        byCam.set(key, {
          meta: {
            systemId: ev.systemId,
            system:   ev.system,
            camera:   ev.camera,
            group:    timeline.cameras?.[key]?.group || '',
          },
          days: new Map(),
        });
      }
      const cam = byCam.get(key);
      if (!cam.days.has(ymd)) cam.days.set(ymd, []);
      cam.days.get(ymd).push(ev);
    }
    // Дополнительно подтягиваем group если был в cameras-секции
    for (const [k, info] of Object.entries(timeline.cameras || {})) {
      if (byCam.has(k) && !byCam.get(k).meta.group) {
        byCam.get(k).meta.group = info.group || '';
      }
    }
  }

  const lastYmd = loaded.length ? loaded[loaded.length - 1].ymd : todayYmd(now);
  const rows = [];

  for (const [key, info] of byCam.entries()) {
    let totalIncidents = 0;
    let totalDownMin   = 0;
    let currentlyDown  = false;
    const days = [];

    for (const [ymd, events] of [...info.days.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      // Конец дня = 23:59:59 этого дня (для last-ymd = now)
      const isLastDay = ymd === lastYmd;
      const dayEnd = isLastDay ? now : new Date(`${ymd}T23:59:59`);

      const dayInfo = buildDayBreakdown(events, dayEnd);
      if (dayInfo.incidents === 0) continue;

      totalIncidents += dayInfo.incidents;
      totalDownMin   += dayInfo.downMin;
      if (isLastDay && dayInfo.currentlyDown) currentlyDown = true;

      days.push({
        date:      ymd,
        incidents: dayInfo.incidents,
        downMin:   dayInfo.downMin,
        intervals: dayInfo.intervals,
      });
    }

    if (totalIncidents === 0) continue;

    rows.push({
      systemId:     info.meta.systemId,
      system:       info.meta.system || info.meta.systemId,
      group:        info.meta.group || '',
      camera:       info.meta.camera,
      incidents:    totalIncidents,
      totalDownMin,
      currentlyDown,
      days,
    });
  }

  // Сортируем: текущие сбои наверху, дальше — по суммарному простою (убыв.)
  rows.sort((a, b) => {
    if (a.currentlyDown !== b.currentlyDown) return b.currentlyDown ? 1 : -1;
    return b.totalDownMin - a.totalDownMin;
  });
  return rows;
}
