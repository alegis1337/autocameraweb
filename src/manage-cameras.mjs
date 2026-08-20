/**
 * manage-cameras.mjs — CLI для управления списком камер в config/systems.json.
 *
 * ЭТАП 1: операции «список / серый / снять серый / удалить».
 * (Этапы 2–3 добавят add-camera и add-system с детектором типа.)
 *
 * Команды (вызываются из menu.ps1):
 *
 *   list-systems
 *     По строке: <sysId>|<sysName>|<grayCount>|<totalCount>
 *
 *   list <sysId>
 *     По строке: <position>|<label>|<status>|<kind>
 *       position — 1..N, используется для всех команд ниже
 *       status   — gray | active
 *       kind     — name (TRASSIR, cameraGuids key) | channel (1-based номер канала)
 *
 *   gray <sysId> <position>     — пометить камеру серой (НЕ удаляет из конфига).
 *                                  Скрипт перестаёт её проверять и в helpdesk не пишет.
 *                                  Идемпотентно: если уже серая — повторно ничего не делает.
 *   ungray <sysId> <position>   — снять «серый» (возвращает в обычную проверку).
 *   delete <sysId> <position>   — физически удалить камеру из systems.json.
 *
 * Семантика для разных типов систем:
 *
 *   • TRASSIR (sys.id === 'trassir' или type === 'trassir-sdk')
 *       gray   → добавить displayName в knownOffline + helpdeskIgnore
 *       delete → удалить запись из cameraGuids (и подчистить knownOffline)
 *
 *   • Системы с массивом cameras[] / channels[]
 *       gray   → добавить номер канала (index+1) в unusedChannels
 *       delete → splice из массива cameras/channels, plюс убрать из unusedChannels
 *
 *   • Системы только с maxChannelId (NVR, без явных camera-объектов)
 *       gray   → добавить номер канала в unusedChannels
 *       delete → ВНИМАНИЕ: для NVR-каналов «delete» эквивалентен «gray»
 *                (нельзя физически удалить канал из регистратора через конфиг).
 *                Помечаем как unused и пишем понятное сообщение в stdout.
 *
 * Вывод операций (для разбора в menu.ps1):
 *   ok|<action>|<label>          — успех
 *   noop|<action>|<label>        — действие не нужно (уже в нужном состоянии)
 *   error|<message>              — ошибка (sysId/position/неподходящий тип)
 */

import fs from 'fs';
import path from 'path';

const cmd    = process.argv[2];
const sysId  = process.argv[3];
const target = process.argv[4];

const configPath = path.resolve('config', 'systems.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}
function saveConfig(c) {
  const tmp = configPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), 'utf8');
  fs.renameSync(tmp, configPath);
}

// Унифицированная сортировка имён вида "201", "210", "RTSP3"
const cmpNames = (a, b) =>
  String(a).localeCompare(String(b), 'ru', { numeric: true, sensitivity: 'base' });

function isTrassirSys(sys) {
  return sys.id === 'trassir' || sys.type === 'trassir-sdk';
}

/**
 * Возвращает массив объектов вида { position, label, key, status, kind }
 * для всех камер системы. Используется list / gray / ungray / delete.
 */
function getItems(sys) {
  // ── TRASSIR: список из cameraGuids, серость через knownOffline ──
  if (isTrassirSys(sys)) {
    const guids = sys.cameraGuids || {};
    const names = Object.values(guids).filter(Boolean).slice().sort(cmpNames);
    const offline = sys.knownOffline || [];
    return names.map((name, i) => ({
      position: i + 1,
      label: name,
      key: name,
      status: offline.includes(name) ? 'gray' : 'active',
      kind: 'name',
    }));
  }

  // ── Остальные: cameras[] / channels[] / maxChannelId, серость через unusedChannels ──
  const unused = sys.unusedChannels || [];
  let cams;

  if (Array.isArray(sys.cameras) && sys.cameras.length > 0) {
    cams = sys.cameras.map((c, i) => ({
      ch: (c.index ?? i) + 1,
      label: c.name || `Канал ${(c.index ?? i) + 1}`,
    }));
  } else if (Array.isArray(sys.channels) && sys.channels.length > 0) {
    cams = sys.channels.map((c, i) => ({
      ch: (c.index ?? i) + 1,
      label: c.name || `Канал ${(c.index ?? i) + 1}`,
    }));
  } else if (Number.isInteger(sys.maxChannelId) && sys.maxChannelId > 0) {
    cams = [];
    for (let i = 1; i <= sys.maxChannelId; i++) {
      cams.push({ ch: i, label: `Камера ${i}` });
    }
  } else {
    return [];
  }

  cams.sort((a, b) => a.ch - b.ch);

  return cams.map((c, i) => ({
    position: i + 1,
    label: c.label,
    key: c.ch,
    status: unused.includes(c.ch) ? 'gray' : 'active',
    kind: 'channel',
  }));
}

// ─── Команды чтения ───────────────────────────────────────────────────────────

if (cmd === 'list-systems') {
  const config = loadConfig();
  for (const sys of config) {
    const items = getItems(sys);
    const gray  = items.filter(it => it.status === 'gray').length;
    console.log(`${sys.id}|${sys.name}|${gray}|${items.length}`);
  }
  process.exit(0);
}

if (cmd === 'list') {
  if (!sysId) { console.error('error|sysId не указан'); process.exit(1); }
  const config = loadConfig();
  const sys = config.find(s => s.id === sysId);
  if (!sys) { console.error(`error|Система не найдена: ${sysId}`); process.exit(1); }
  const items = getItems(sys);
  for (const it of items) {
    console.log(`${it.position}|${it.label}|${it.status}|${it.kind}`);
  }
  process.exit(0);
}

// ─── Helpers для команд изменения ─────────────────────────────────────────────

function findSysAndItem() {
  if (!sysId)  { console.error('error|sysId не указан');  process.exit(2); }
  if (!target) { console.error('error|position не указан'); process.exit(2); }
  const config = loadConfig();
  const sys = config.find(s => s.id === sysId);
  if (!sys) { console.error(`error|Система не найдена: ${sysId}`); process.exit(2); }

  const items = getItems(sys);
  const pos = parseInt(target, 10);
  const item = items.find(it => it.position === pos);
  if (!item) { console.error(`error|Нет камеры с позицией ${pos}`); process.exit(2); }

  return { config, sys, item };
}

function applyGray(sys, item) {
  if (item.kind === 'name') {
    // TRASSIR: knownOffline + helpdeskIgnore синхронно
    const list = Array.isArray(sys.knownOffline) ? sys.knownOffline.slice() : [];
    if (list.includes(item.key)) return false;
    list.push(item.key);
    list.sort(cmpNames);
    sys.knownOffline = list;
    sys.helpdeskIgnore = list.slice();
    return true;
  }
  // channel-based
  const list = Array.isArray(sys.unusedChannels) ? sys.unusedChannels.slice() : [];
  if (list.includes(item.key)) return false;
  list.push(item.key);
  list.sort((a, b) => a - b);
  sys.unusedChannels = list;
  return true;
}

function applyUngray(sys, item) {
  if (item.kind === 'name') {
    const list = Array.isArray(sys.knownOffline) ? sys.knownOffline.slice() : [];
    const idx = list.indexOf(item.key);
    if (idx < 0) return false;
    list.splice(idx, 1);
    sys.knownOffline = list;
    sys.helpdeskIgnore = list.slice();
    return true;
  }
  const list = Array.isArray(sys.unusedChannels) ? sys.unusedChannels.slice() : [];
  const idx = list.indexOf(item.key);
  if (idx < 0) return false;
  list.splice(idx, 1);
  sys.unusedChannels = list;
  return true;
}

/**
 * Физическое удаление. Возвращает строку:
 *   'deleted'        — реально вырезано из cameras/channels/cameraGuids
 *   'grayed-fallback' — нельзя удалить (NVR maxChannelId-only), пометили серым
 *   'noop'            — уже удалено/не существует
 */
function applyDelete(sys, item) {
  if (item.kind === 'name') {
    // TRASSIR: вырезаем GUID
    const guids = sys.cameraGuids || {};
    const guid = Object.keys(guids).find(g => guids[g] === item.key);
    if (!guid) return 'noop';
    delete guids[guid];
    sys.cameraGuids = guids;

    // Подчистить knownOffline / helpdeskIgnore от этого имени
    if (Array.isArray(sys.knownOffline)) {
      sys.knownOffline = sys.knownOffline.filter(n => n !== item.key);
      sys.helpdeskIgnore = sys.knownOffline.slice();
    }
    return 'deleted';
  }

  // channel-based: пробуем найти физический cameras[] или channels[]
  const ch = item.key;
  if (Array.isArray(sys.cameras) && sys.cameras.length > 0) {
    const arr = sys.cameras;
    const idx = arr.findIndex(c => (c.index ?? -1) + 1 === ch);
    if (idx < 0) return 'noop';
    arr.splice(idx, 1);
    sys.cameras = arr;
  } else if (Array.isArray(sys.channels) && sys.channels.length > 0) {
    const arr = sys.channels;
    const idx = arr.findIndex(c => (c.index ?? -1) + 1 === ch);
    if (idx < 0) return 'noop';
    arr.splice(idx, 1);
    sys.channels = arr;
  } else if (Number.isInteger(sys.maxChannelId)) {
    // Нет cameras[] / channels[] — это NVR с диапазоном каналов.
    // Физически удалить нельзя, только пометить серым.
    const list = Array.isArray(sys.unusedChannels) ? sys.unusedChannels.slice() : [];
    if (!list.includes(ch)) {
      list.push(ch);
      list.sort((a, b) => a - b);
      sys.unusedChannels = list;
      return 'grayed-fallback';
    }
    return 'noop';
  } else {
    return 'noop';
  }

  // После splice из cameras[] — почистим unusedChannels от этого канала
  // и пересчитаем (т.к. индексы остальных могли сдвинуться, но мы храним
  // 1-based номера и эти номера остаются актуальны для оставшихся камер).
  if (Array.isArray(sys.unusedChannels)) {
    sys.unusedChannels = sys.unusedChannels.filter(n => n !== ch);
  }
  return 'deleted';
}

// ─── Команды изменения ────────────────────────────────────────────────────────

if (cmd === 'gray') {
  const { config, sys, item } = findSysAndItem();
  const changed = applyGray(sys, item);
  if (changed) saveConfig(config);
  console.log(`${changed ? 'ok' : 'noop'}|gray|${item.label}`);
  process.exit(0);
}

if (cmd === 'ungray') {
  const { config, sys, item } = findSysAndItem();
  const changed = applyUngray(sys, item);
  if (changed) saveConfig(config);
  console.log(`${changed ? 'ok' : 'noop'}|ungray|${item.label}`);
  process.exit(0);
}

if (cmd === 'delete') {
  const { config, sys, item } = findSysAndItem();
  const res = applyDelete(sys, item);
  if (res === 'deleted' || res === 'grayed-fallback') saveConfig(config);
  if (res === 'grayed-fallback') {
    console.log(`ok|grayed-fallback|${item.label}`);
  } else {
    console.log(`${res === 'deleted' ? 'ok' : 'noop'}|delete|${item.label}`);
  }
  process.exit(0);
}

// ─── Команды добавления (этап 2/3) ───────────────────────────────────────────
//
// Все три ниже принимают путь к JSON-файлу с параметрами — так проще передать
// сложные структуры из PowerShell (там нет нормального JSON-encoding в args).

/** Читает JSON-файл и возвращает объект, или error+exit при ошибке. */
function readJsonFileOrExit(jsonPath) {
  if (!jsonPath || !fs.existsSync(jsonPath)) {
    console.error(`error|JSON-файл не найден: ${jsonPath}`);
    process.exit(2);
  }
  try { return JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
  catch (e) {
    console.error(`error|Не удалось распарсить JSON: ${e.message}`);
    process.exit(2);
  }
}

// add-system <jsonPath>
//   JSON-формат:  { id, name, group, type, ...поля специфичные для типа... }
//   Проверка: id должен быть уникальным. Если такой id уже есть — error.
if (cmd === 'add-system') {
  const data = readJsonFileOrExit(sysId);  // sysId здесь — это аргумент <jsonPath>
  if (!data.id || !data.name || !data.type) {
    console.error('error|JSON должен содержать id, name, type');
    process.exit(2);
  }
  const config = loadConfig();
  if (config.find(s => s.id === data.id)) {
    console.error(`error|Система с id="${data.id}" уже существует`);
    process.exit(2);
  }
  // Гарантируем дефолты, чтобы новый блок был совместим с уже сложившимися
  if (data.enabled === undefined) data.enabled = true;
  if (!data.displayMode)          data.displayMode = 'grid';
  if (!data.gridColumns)          data.gridColumns = 4;
  config.push(data);
  saveConfig(config);
  console.log(`ok|add-system|${data.id}|${data.name}`);
  process.exit(0);
}

// add-cam <sysId> <jsonPath>
//   JSON-формат: { name, ...поля камеры... } — например { name, host, port, userEnv, passEnv }
//   для hikvision-multi или { name, ip, rtspPath, viaNvr, nvrChannel } для ipanda-rtsp.
if (cmd === 'add-cam') {
  if (!sysId || !target) { console.error('error|Usage: add-cam <sysId> <jsonPath>'); process.exit(2); }
  const data = readJsonFileOrExit(target);
  if (!data.name) { console.error('error|JSON должен содержать name'); process.exit(2); }

  const config = loadConfig();
  const sys = config.find(s => s.id === sysId);
  if (!sys) { console.error(`error|Система не найдена: ${sysId}`); process.exit(2); }

  // Для TRASSIR — добавляем в cameraGuids (формат другой)
  if (isTrassirSys(sys)) {
    if (!data.guid) { console.error('error|Для TRASSIR требуется поле guid'); process.exit(2); }
    sys.cameraGuids = sys.cameraGuids || {};
    if (sys.cameraGuids[data.guid]) {
      console.error(`error|GUID ${data.guid} уже есть в этой системе`);
      process.exit(2);
    }
    sys.cameraGuids[data.guid] = data.name;
    saveConfig(config);
    console.log(`ok|add-cam|${data.name}`);
    process.exit(0);
  }

  // Иначе — массив cameras[]
  sys.cameras = Array.isArray(sys.cameras) ? sys.cameras : [];
  const nextIdx = sys.cameras.reduce((m, c) => Math.max(m, (c.index ?? -1) + 1), 0);
  const camRecord = { index: nextIdx, ...data };
  sys.cameras.push(camRecord);
  saveConfig(config);
  console.log(`ok|add-cam|${camRecord.name}|index=${nextIdx}`);
  process.exit(0);
}

// append-env <KEY> <value>
//   Дописывает строку KEY=value в .env (если KEY уже есть — заменяет).
//   Делает резервную копию .env.bak перед изменением.
if (cmd === 'append-env') {
  if (!sysId || target === undefined) {
    console.error('error|Usage: append-env <KEY> <value>');
    process.exit(2);
  }
  const key   = sysId;
  const value = target;
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    console.error('error|KEY должен быть в UPPER_SNAKE_CASE');
    process.exit(2);
  }
  const envPath = path.resolve('.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  // Резервная копия
  if (content) fs.writeFileSync(envPath + '.bak', content, 'utf8');

  // Если ключ уже есть — заменяем. Иначе append с newline.
  const reLine = new RegExp(`^${key}=.*$`, 'm');
  if (reLine.test(content)) {
    content = content.replace(reLine, `${key}=${value}`);
  } else {
    if (content && !content.endsWith('\n')) content += '\n';
    content += `${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, content, 'utf8');
  console.log(`ok|append-env|${key}`);
  process.exit(0);
}

console.error(`error|Неизвестная команда: ${cmd}. Доступны: list-systems, list, gray, ungray, delete, add-system, add-cam, append-env`);
process.exit(2);
