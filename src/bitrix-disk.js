/**
 * bitrix-disk.js — REST-клиент Битрикс24 Диска для загрузки скриншотов.
 *
 * Использует входящий webhook Битрикса (без OAuth-flow). URL вебхука кладётся
 * в .env как BITRIX_WEBHOOK_URL — формата:
 *   https://<portal>.bitrix24.ru/rest/<userId>/<webhookCode>/
 *
 * Webhook должен иметь право "Диск (disk)" (выбирается при создании в Битриксе).
 *
 * Структура папок на диске:
 *   <ROOT_FOLDER>/<YYYY-MM-DD>/<HHmm>/<systemId>/<index>-<name>.jpg
 *
 * ─── ENV ─────────────────────────────────────────────────────────────────────
 *   BITRIX_WEBHOOK_URL          — обязателен (без него фича пропускается)
 *   BITRIX_STORAGE_ID           — ID общего диска (узнаётся через CLI helper)
 *   BITRIX_ROOT_FOLDER_ID       — ID папки внутри storage, где создаются
 *                                  YYYY-MM-DD подпапки (если не задан, берём
 *                                  корень storage и создаём 'AutoCamera')
 *   SNAPSHOT_RETENTION_DAYS     — сколько дней хранить YYYY-MM-DD папки (default 30)
 *
 * ─── CLI helper ──────────────────────────────────────────────────────────────
 *   node src/bitrix-disk.js list-storages
 *     Выводит список всех хранилищ (общий диск, личные диски, диски групп) —
 *     по выводу выбираете нужный ID для BITRIX_STORAGE_ID.
 */

import fs from 'fs';
import path from 'path';

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function webhookBase() {
  const url = process.env.BITRIX_WEBHOOK_URL;
  if (!url) throw new Error('BITRIX_WEBHOOK_URL не задан в .env');
  // Гарантируем trailing slash — Битрикс ругается без него
  return url.endsWith('/') ? url : url + '/';
}

/**
 * Универсальный вызов метода Битрикса.
 * Все параметры передаются через body как application/x-www-form-urlencoded
 * (Битрикс понимает JSON тоже, но form-data надёжнее с массивами).
 *
 * @param {string} method — например "disk.storage.getlist"
 * @param {object} params — плоский объект; вложенные ключи: data[NAME]=...
 * @returns {Promise<any>} parsed result или throw Error
 */
async function callBitrix(method, params = {}) {
  const url = webhookBase() + encodeURIComponent(method);

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) body.append(`${k}[${i}]`, String(v[i]));
    } else if (v != null) {
      body.append(k, String(v));
    }
  }

  // Timeout: для лёгких методов 30с, для uploadfile (большой base64 в
  // теле запроса, TRASSIR HD-кадры дают ~700КБ после base64-кодирования)
  // — 90с. Webhook у Битрикса плохо переваривает крупные тела + 33%
  // оверхеда от base64.
  const REQUEST_TIMEOUT_MS = method === 'disk.folder.uploadfile' ? 90000 : 30000;

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', body, signal: ac.signal });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); }
      catch { throw new Error(`не-JSON ответ (${res.status}): ${text.slice(0, 200)}`); }

      if (json.error) {
        // Логические ошибки Битрикса — не ретраим
        const msg = `${json.error}: ${json.error_description || ''}`;
        throw new Error(msg);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return json.result;
    } catch (err) {
      lastErr = err.name === 'AbortError'
        ? new Error(`таймаут ${REQUEST_TIMEOUT_MS / 1000}с (${method})`)
        : err;
      // Логические ошибки Битрикса не ретраим
      if (/^[A-Z_]+:/.test(lastErr.message)) break;
      if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

// ─── Storage / Folder ────────────────────────────────────────────────────────

/**
 * Все доступные хранилища (общий диск, личные, диски групп).
 * @returns {Promise<Array<{ID, NAME, ENTITY_TYPE, ENTITY_ID, CODE}>>}
 */
export async function listStorages() {
  const result = await callBitrix('disk.storage.getlist');
  return Array.isArray(result) ? result : [];
}

/**
 * Содержимое папки. Возвращает только поля, которые нам нужны.
 * @returns {Promise<Array<{ID, NAME, TYPE, CREATE_TIME, UPDATE_TIME}>>}
 */
export async function listFolderChildren(folderId) {
  const result = await callBitrix('disk.folder.getchildren', { id: folderId });
  return Array.isArray(result) ? result : [];
}

/**
 * Возвращает корневую папку хранилища (ROOT_OBJECT_ID).
 */
async function storageRootFolderId(storageId) {
  const list = await callBitrix('disk.storage.get', { id: storageId });
  // disk.storage.get возвращает объект с ROOT_OBJECT_ID
  if (!list?.ROOT_OBJECT_ID) {
    throw new Error(`не получили ROOT_OBJECT_ID для storage ${storageId}`);
  }
  return list.ROOT_OBJECT_ID;
}

/**
 * Находит подпапку с заданным именем внутри родительской. null если нет.
 */
async function findChildFolder(parentId, name) {
  const items = await listFolderChildren(parentId);
  return items.find(it => it.TYPE === 'folder' && it.NAME === name) || null;
}

/**
 * Создаёт подпапку (если уже есть с таким именем — возвращает существующую).
 * Race-condition safe: при параллельных вызовах ловит DISK_OBJ_22000
 * ("Папка с таким именем уже есть") и читает существующую.
 * @returns {Promise<{ID, NAME}>}
 */
export async function ensureSubfolder(parentId, name) {
  const existing = await findChildFolder(parentId, name);
  if (existing) return existing;

  try {
    const created = await callBitrix('disk.folder.addsubfolder', {
      id: parentId,
      'data[NAME]': name,
    });
    if (created?.ID) return created;
  } catch (err) {
    // DISK_OBJ_22000 = "Папка с таким именем уже есть" (race с другим воркером)
    if (!/DISK_OBJ_22000|уже есть/i.test(err.message)) throw err;
  }
  // Параллельный воркер уже создал её — читаем
  const retry = await findChildFolder(parentId, name);
  if (retry) return retry;
  throw new Error(`не удалось создать папку ${name} в ${parentId}`);
}

/**
 * Гарантирует существование вложенной структуры папок относительно parentId.
 * Например ensureFolderPath(rootId, ['2026-05-08', '0900', 'ivms']).
 * @returns {Promise<string>} ID последней созданной/найденной папки
 */
export async function ensureFolderPath(parentId, parts) {
  let cur = parentId;
  for (const name of parts) {
    const folder = await ensureSubfolder(cur, name);
    cur = folder.ID;
  }
  return cur;
}

// ─── Операции с файлами ─────────────────────────────────────────────────────

/**
 * Ищет файл по имени в папке folderId. Возвращает объект файла или null.
 */
export async function findFileByName(folderId, name) {
  const items = await listFolderChildren(folderId);
  return items.find(it => it.TYPE === 'file' && it.NAME === name) || null;
}

/**
 * Переименовывает файл (в той же папке).
 */
export async function renameFile(fileId, newName) {
  return await callBitrix('disk.file.rename', { id: fileId, newName });
}

/**
 * Перемещает файл в другую папку.
 */
export async function moveFile(fileId, targetFolderId) {
  return await callBitrix('disk.file.moveto', { id: fileId, targetFolderId });
}

// ─── Загрузка файла ──────────────────────────────────────────────────────────

/**
 * Загружает локальный файл в указанную папку Битрикса.
 * @returns {Promise<{ID, NAME}>} — объект созданного файла
 */
export async function uploadFile(localPath, folderId, remoteName) {
  if (!fs.existsSync(localPath)) {
    throw new Error(`uploadFile: локальный файл не найден ${localPath}`);
  }
  const buf = fs.readFileSync(localPath);
  const base64 = buf.toString('base64');
  const name = remoteName || path.basename(localPath);

  // disk.folder.uploadfile принимает fileContent[] = [имя, base64-данные]
  const result = await callBitrix('disk.folder.uploadfile', {
    id: folderId,
    'data[NAME]': name,
    'fileContent[0]': name,
    'fileContent[1]': base64,
    generateUniqueName: 'Y',  // если такое имя есть — Битрикс добавит (1)
  });

  if (!result?.ID) {
    throw new Error(`uploadFile: пустой ответ от Битрикса`);
  }
  return result;
}

/**
 * Делает файл доступным по внешней публичной ссылке и возвращает её URL.
 * Используется метод disk.file.get — он сам отдаёт DOWNLOAD_URL (требует login)
 * и LINK (web-просмотр в Битриксе). Для публичной ссылки используем
 * disk.file.getExternalLink.
 */
export async function getExternalLink(fileId) {
  // disk.file.getExternalLink — генерирует публичную ссылку без авторизации
  try {
    const res = await callBitrix('disk.file.getExternalLink', { id: fileId });
    if (typeof res === 'string') return res;
    if (res?.url) return res.url;
  } catch (err) {
    // Метод может отсутствовать на старых порталах — fallback на LINK
  }
  // Fallback: получаем web-ссылку (требует входа в Битрикс, но видна сотрудникам)
  const file = await callBitrix('disk.file.get', { id: fileId });
  return file?.DETAIL_URL || file?.DOWNLOAD_URL || file?.LINK || '';
}

/**
 * Возвращает внутренний URL папки в Битрикс24-диске (DETAIL_URL).
 * Это «web-ссылка», по которой залогиненный в портале сотрудник попадает
 * прямо в папку (галерея со всеми скриншотами). Публичной её сделать нельзя
 * (Bitrix не даёт getExternalLink для папок) — но заказчик у нас работает
 * в B24 и обычно уже залогинен, поэтому этого хватает.
 */
export async function getFolderUrl(folderId) {
  try {
    const folder = await callBitrix('disk.folder.get', { id: folderId });
    return folder?.DETAIL_URL || folder?.LINK || '';
  } catch {
    return '';
  }
}

/**
 * Удаляет файл/папку (помечает как удалённый, в корзину).
 */
export async function deleteResource(id, isFolder = false) {
  const method = isFolder ? 'disk.folder.markdeleted' : 'disk.file.markdeleted';
  try {
    await callBitrix(method, { id });
  } catch (err) {
    // Уже удалён — игнорируем
    if (!/not.*found|deleted/i.test(err.message)) throw err;
  }
}

// ─── Retention ───────────────────────────────────────────────────────────────

/**
 * Чистит папки-даты старше N дней.
 *
 * Структура: <root>/<group>/<object>/<YYYY-MM-DD>/...
 * Обходит группы → объекты → ищет внутри подпапки с именем
 * формата "YYYY-MM-DD" и удаляет те, чья дата старше cutoff.
 *
 * @returns {Promise<{deleted:number, kept:number}>}
 */
export async function cleanupOlderThan(rootFolderId, days) {
  if (!days || days <= 0) return { deleted: 0, kept: 0 };
  const cutoff = Date.now() - days * 86400_000;

  let deleted = 0, kept = 0;
  const groups = await listFolderChildren(rootFolderId);

  for (const group of groups) {
    if (group.TYPE !== 'folder') continue;
    const objects = await listFolderChildren(group.ID);

    for (const obj of objects) {
      if (obj.TYPE !== 'folder') continue;
      const dates = await listFolderChildren(obj.ID);

      for (const d of dates) {
        if (d.TYPE !== 'folder') continue;
        const m = d.NAME.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) { kept++; continue; }
        const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
        if (isNaN(ts) || ts >= cutoff) { kept++; continue; }
        try {
          await deleteResource(d.ID, true);
          deleted++;
        } catch {
          kept++;
        }
      }
    }
  }
  return { deleted, kept };
}

// ─── Высокоуровневая обёртка ─────────────────────────────────────────────────

/**
 * Загружает свежий кадр в папку-дату объекта. Структура:
 *   <root>/<group>/<object>/<YYYY-MM-DD>/<cam>.jpg
 *
 * Если файл с таким именем уже есть в папке-дате (повторный прогон в тот
 * же день) — удаляет старый и загружает новый. Так в папке дня всегда
 * хранится самый последний кадр на сегодня, без накопления версий.
 *
 * Старые папки-даты целиком чистятся через cleanupOlderThan().
 *
 * @param {string}  localPath
 * @param {string[]} subPath   — ['<группа>', '<объект>', '2026-05-13']
 * @param {string}  fileName   — '201.jpg'
 * @param {object}  [options]
 * @param {Function}[options.onError] — (err, stage) => void
 * @returns {Promise<string|null>} — публичная ссылка на загруженный файл
 */
export async function uploadFreshSnapshot(localPath, subPath, fileName, options = {}) {
  const onError = options.onError || (() => {});
  const rootId = process.env.BITRIX_ROOT_FOLDER_ID;
  if (!rootId) {
    onError(new Error('BITRIX_ROOT_FOLDER_ID не задан'), 'config');
    return null;
  }

  // 1. Создаём (или находим) вложенную папку <group>/<object>/<date>
  let dayFolderId;
  try {
    dayFolderId = await ensureFolderPath(rootId, subPath);
  } catch (err) {
    onError(err, 'ensureFolderPath');
    return null;
  }

  // 2. Если повторный прогон за тот же день — удаляем старый файл, чтобы
  //    Битрикс не добавил " (1)" к имени.
  try {
    const existing = await findFileByName(dayFolderId, fileName);
    if (existing) await deleteResource(existing.ID, false);
  } catch (err) {
    onError(err, 'replaceExisting');
    // не критично — Битрикс возьмёт уникальное имя
  }

  // 3. Загружаем новый файл
  let fileObj;
  try {
    fileObj = await uploadFile(localPath, dayFolderId, fileName);
  } catch (err) {
    onError(err, 'uploadFile');
    return null;
  }

  // 4. Публичная ссылка
  try {
    return await getExternalLink(fileObj.ID);
  } catch (err) {
    onError(err, 'getExternalLink');
    return null;
  }
}

// ─── CLI helper ──────────────────────────────────────────────────────────────
// Запуск: node src/bitrix-disk.js list-storages

const isMainModule = import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isMainModule || process.argv[1]?.endsWith('bitrix-disk.js')) {
  const cmd = process.argv[2];

  // Загружаем .env, если запускаем напрямую
  const dotenvPath = path.resolve('.env');
  if (fs.existsSync(dotenvPath)) {
    const { default: dotenv } = await import('dotenv');
    dotenv.config();
  }

  if (cmd === 'list-storages') {
    if (!process.env.BITRIX_WEBHOOK_URL) {
      console.error('BITRIX_WEBHOOK_URL не задан в .env. Сначала создайте webhook в Битриксе.');
      process.exit(1);
    }
    try {
      const storages = await listStorages();
      console.log('\nДоступные хранилища:\n');
      console.log('ID    TYPE         ENTITY_ID   NAME');
      console.log('────  ───────────  ──────────  ────────────────────────');
      for (const s of storages) {
        const id   = String(s.ID).padEnd(4);
        const type = String(s.ENTITY_TYPE || '?').padEnd(11);
        const eid  = String(s.ENTITY_ID || '').padEnd(10);
        console.log(`${id}  ${type}  ${eid}  ${s.NAME}`);
      }
      console.log('\nПодсказка:');
      console.log('  • ENTITY_TYPE=common — Общий диск (рекомендую для AutoCamera)');
      console.log('  • ENTITY_TYPE=user   — Личный диск пользователя');
      console.log('  • ENTITY_TYPE=group  — Диск рабочей группы\n');
      console.log('Положите выбранный ID в .env как BITRIX_STORAGE_ID,');
      console.log('затем запустите:  node src/bitrix-disk.js init-folder\n');
    } catch (err) {
      console.error('Ошибка:', err.message);
      process.exit(1);
    }
  } else if (cmd === 'init-folder') {
    const storageId = process.env.BITRIX_STORAGE_ID;
    if (!storageId) {
      console.error('BITRIX_STORAGE_ID не задан в .env. Запустите list-storages.');
      process.exit(1);
    }
    try {
      const rootId = await storageRootFolderId(storageId);
      const acRoot = await ensureSubfolder(rootId, 'AutoCamera');
      console.log(`\nКорень storage:  id=${rootId}`);
      console.log(`Папка AutoCamera: id=${acRoot.ID}\n`);
      console.log('Положите в .env:');
      console.log(`  BITRIX_ROOT_FOLDER_ID=${acRoot.ID}\n`);
    } catch (err) {
      console.error('Ошибка:', err.message);
      process.exit(1);
    }
  } else {
    console.log('Использование:');
    console.log('  node src/bitrix-disk.js list-storages');
    console.log('  node src/bitrix-disk.js init-folder');
  }
}
