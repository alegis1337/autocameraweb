/**
 * state.js — Хранение состояния камер между прогонами для дедупликации
 * helpdesk-заявок.
 *
 * Сохраняет каждый объект "сломанная камера" с timestamp первой поломки
 * и последнего наблюдения. По состоянию вычисляются три множества:
 *   newlyBroken — камеры, которые сломались впервые (или сменили причину);
 *   recovered   — камеры, которые были сломаны, теперь снова работают;
 *   stillBroken — лежат с прошлого прогона;
 *   unchecked   — лежали, но их объект в этот прогон опросить не удалось
 *                 (запись в state не меняется — см. CHECK_ERROR_STATUS).
 *
 * Механизм напоминаний (pickReminders / markNotified / notifiedAt) жил здесь
 * до 04.09.2026 и снят вместе с переходом на ежедневное письмо в helpdesk:
 * все сломанные камеры теперь и так перечисляются каждое утро. Код лежит
 * в archive/helpdesk-reminders/ вместе с инструкцией, как его вернуть.
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
 * Статус записи «опрос объекта упал целиком» (её кладёт collectBrokenCameras
 * вместо камер, когда чекер вернул ошибку, а не список). Живёт здесь, потому
 * что именно diffAndUpdate обязан её распознать: камеры такого объекта в
 * этот прогон не проверялись — ни сломанными, ни восстановленными их
 * считать нельзя.
 */
export const CHECK_ERROR_STATUS = 'ошибка проверки';

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
 * Объект, чей опрос упал целиком (запись со статусом CHECK_ERROR_STATUS),
 * своих камер в списке не имеет — но это не значит, что они заработали.
 * Раньше они уходили в recovered, и назавтра камера, лежавшая неделю,
 * попадала в письмо как «не работает с сегодня». Теперь их записи в
 * state не трогаются вовсе: дата поломки переживает сбой опроса, а в
 * `unchecked` возвращается, сколько таких камер осталось без ответа.
 *
 * @param {object} state          — результат loadState()
 * @param {Array}  currentBroken  — массив объектов от collectBrokenCameras()
 *                                  (требует поле systemId, см. reporter.js)
 * @returns {{newlyBroken:Array, recovered:Array, stillBroken:Array, unchecked:Array}}
 */
export function diffAndUpdate(state, currentBroken) {
  const now = new Date().toISOString();
  const currentKeys = new Set(currentBroken.map(cameraKey));
  const uncheckedSystems = new Set(
    currentBroken.filter((i) => i.status === CHECK_ERROR_STATUS).map((i) => i.systemId || i.system)
  );

  const newlyBroken = [];
  const stillBroken = [];
  const recovered   = [];
  const unchecked   = [];

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

    // Та же поломка, что и в прошлом прогоне. Отдельным событием она не
    // считается, но в ежедневное письмо в helpdesk попадает наравне с новыми:
    // оператор должен видеть полную картину по объекту.
    stillBroken.push({ ...item, _brokenSince: prev.since });
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

    // Объект не опрошен — про эту камеру в этот раз ничего не известно.
    if (uncheckedSystems.has(prev.systemId || prev.system)) {
      unchecked.push({ ...prev });
      continue;
    }

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
  return { newlyBroken, recovered, stillBroken, unchecked };
}
