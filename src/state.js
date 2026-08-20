/**
 * state.js — Хранение состояния камер между прогонами для дедупликации
 * helpdesk-заявок.
 *
 * Сохраняет каждый объект "сломанная камера" с timestamp первой поломки
 * и последнего наблюдения. По состоянию вычисляются три множества:
 *   newlyBroken — камеры, которые сломались впервые (или сменили причину);
 *   recovered   — камеры, которые были сломаны, теперь снова работают;
 *   stillBroken — лежат давно, в helpdesk о них больше не пишем.
 *
 * Файл: state/helpdesk-state.json (gitignored).
 */

import fs from 'fs';
import path from 'path';

const STATE_DIR  = path.resolve('state');
const STATE_FILE = path.join(STATE_DIR, 'helpdesk-state.json');

/**
 * Уникальный ключ камеры: "<systemId>|<имя_или_метка_камеры>".
 * helpdesk-обработка раньше использовала только системы и имена камер,
 * у нас уже есть и то и другое в объекте broken-camera.
 */
export const cameraKey = (item) => `${item.systemId || item.system}|${item.camera}`;

/**
 * Читает helpdesk-state. Если файла нет или он повреждён — возвращает
 * пустой state.
 */
export function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { lastRun: null, cameras: {} };
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lastRun: parsed.lastRun || null,
      cameras: parsed.cameras || {},
    };
  } catch {
    return { lastRun: null, cameras: {} };
  }
}

/**
 * Атомарно сохраняет state (write tmp + rename).
 */
export function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

/**
 * Полностью обнуляет state. Используется флагом --reset-state.
 */
export function resetState() {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

/**
 * Сравнивает текущее множество сломанных камер с предыдущим state и
 * возвращает три категории. Мутирует state (lastRun + cameras).
 *
 * @param {object} state          — результат loadState()
 * @param {Array}  currentBroken  — массив объектов от collectBrokenCameras()
 *                                  (требует поле systemId, см. reporter.js)
 * @returns {{newlyBroken:Array, recovered:Array, stillBroken:Array}}
 */
export function diffAndUpdate(state, currentBroken) {
  const now = new Date().toISOString();
  const currentKeys = new Set(currentBroken.map(cameraKey));

  const newlyBroken = [];
  const stillBroken = [];
  const recovered   = [];

  // 1. Идём по текущим сломанным
  for (const item of currentBroken) {
    const key  = cameraKey(item);
    const prev = state.cameras[key];

    if (!prev) {
      // Камера сломалась впервые — отправить в helpdesk
      newlyBroken.push({ ...item, _firstBrokenAt: now });
      state.cameras[key] = {
        systemId: item.systemId,
        system:   item.system,
        group:    item.group,
        camera:   item.camera,
        status:   'broken',
        reason:   item.status,
        notes:    item.notes,
        since:    now,
        lastSeen: now,
      };
      continue;
    }

    if (prev.status !== 'broken') {
      // Раньше была восстановлена/неизвестна — снова сломалась
      newlyBroken.push({ ...item, _firstBrokenAt: now });
      state.cameras[key] = {
        ...prev,
        status:   'broken',
        reason:   item.status,
        notes:    item.notes,
        since:    now,
        lastSeen: now,
      };
      continue;
    }

    if (prev.reason !== item.status) {
      // Статус сменился (OFFLINE → "нет записи" или наоборот) — это новое
      // событие для helpdesk: причина проблемы изменилась
      newlyBroken.push({ ...item, _statusChanged: true, _previousStatus: prev.reason });
      state.cameras[key] = {
        ...prev,
        reason:   item.status,
        notes:    item.notes,
        lastSeen: now,
      };
      continue;
    }

    // Та же поломка, что и в прошлом прогоне. Само по себе письмо она не
    // вызывает, но может дойти до напоминания — см. pickReminders().
    stillBroken.push({ ...item, _brokenSince: prev.since, _notifiedAt: prev.notifiedAt || prev.since });
    state.cameras[key] = {
      ...prev,
      notes:    item.notes,
      lastSeen: now,
    };
  }

  // 2. Ищем восстановленные — те, что были broken, но не пришли в этот раз
  for (const [key, prev] of Object.entries(state.cameras)) {
    if (prev.status !== 'broken') continue;
    if (currentKeys.has(key)) continue;

    recovered.push({
      systemId: prev.systemId,
      system:   prev.system,
      group:    prev.group,
      camera:   prev.camera,
      previousStatus: prev.reason,
      previousNotes:  prev.notes,
      brokenSince:    prev.since,
      recoveredAt:    now,
    });
    // Помечаем как восстановленную (не удаляем — остаётся история)
    state.cameras[key] = {
      ...prev,
      status:      'active',
      recoveredAt: now,
      lastSeen:    now,
    };
  }

  state.lastRun = now;
  return { newlyBroken, recovered, stillBroken };
}

/**
 * Выбирает давно лежащие камеры, о которых пора напомнить.
 *
 * Зачем (17.08.2026). Письмо в helpdesk уходило только на НОВУЮ поломку, и
 * объект, лежащий вторые сутки, из письма исчезал совсем: 16.08 один из
 * объектов упал целиком, письмо ушло, 17.08 он всё ещё лежал — и по его группе
 * не пришло ничего. Теперь молчание ограничено по времени.
 *
 * Правило (решение пользователя от 18.08.2026):
 *   • объект, лежащий ЦЕЛИКОМ, — напоминаем каждое утро, пока не поднимут;
 *   • отдельная камера — раз в HELPDESK_RENOTIFY_DAYS дней.
 * Разница в том, что упавший объект — это ноль камер на площадке, и тут
 * ежедневное письмо оправдано; отдельная камера столько заявок в 1С не стоит.
 *
 * @param {Array} stillBroken — из diffAndUpdate (несёт `_notifiedAt`)
 * @param {object} opts
 * @param {Set}    opts.downSystems  — id объектов, упавших целиком
 * @param {number} opts.renotifyDays — сколько молчим по отдельной камере
 * @returns {Array} камеры, которые надо снова показать в письме
 */
export function pickReminders(stillBroken, { downSystems = new Set(), renotifyDays = 3, now = new Date() } = {}) {
  const nowMs = now.getTime();
  const due = [];

  for (const item of stillBroken) {
    if (downSystems.has(item.systemId)) {
      due.push({ ...item, _reminder: 'outage' });
      continue;
    }
    const last = Date.parse(item._notifiedAt || item._brokenSince || '');
    const days = Number.isFinite(last) ? (nowMs - last) / 86400_000 : Infinity;
    if (days >= renotifyDays) due.push({ ...item, _reminder: 'renotify', _daysSilent: Math.floor(days) });
  }

  return due;
}

/**
 * Отмечает камеры как «о них в это утро написали в helpdesk».
 *
 * Считаем именно факт упоминания в письме, а не «отправили напоминание»:
 * если камера попала в письмо заодно с новой поломкой соседа, напоминать о
 * ней через три дня незачем — оператор её только что видел. Мутирует state.
 *
 * @param {object} state — из loadState()
 * @param {Array}  items — камеры, попавшие в отправленные письма
 */
export function markNotified(state, items, now = new Date().toISOString()) {
  for (const item of items) {
    const rec = state.cameras[cameraKey(item)];
    if (rec) rec.notifiedAt = now;
  }
}
