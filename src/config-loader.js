/**
 * config-loader.js — загрузчик config/systems.json с подстановкой ${VAR}.
 *
 * Зачем: в systems.json не должно быть никаких чувствительных данных —
 * паролей, IP внутренней сети, имён хостов клиентов. Всё это держим в
 * .env (который в .gitignore), а в JSON пишем плейсхолдеры вида
 * `"host": "${SITE1_HOST}"`. На этапе загрузки конфигурации эти
 * плейсхолдеры разворачиваются в значения из process.env.
 *
 * Особенности:
 *   • Подстановка рекурсивная — работает на любом уровне вложенности
 *     (cameras[i].host, extraCameras[j].rtspPath, ...).
 *   • Только в строковых значениях. Числа/булевы/null не трогаем.
 *   • Если ${VAR} не найдена в env — оставляем как есть и пишем warn'
 *     в лог. Это упрощает диагностику «забыл задать переменную».
 *   • Поддерживается `${VAR:-default}` — если env пуст, использовать
 *     default. Удобно для опциональных портов и т.п.
 *
 * Использование:
 *   import { loadSystems } from './config-loader.js';
 *   const systemsConfig = loadSystems();   // массив систем готов к работе
 */

import fs from 'fs';
import path from 'path';
import * as log from './logger.js';

const CONFIG_PATH = path.resolve('config', 'systems.json');

// ${VAR} или ${VAR:-default}
const RE_PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)(?::-([^}]*))?\}/g;

function expandString(str, context) {
  return str.replace(RE_PLACEHOLDER, (full, name, def) => {
    const v = process.env[name];
    if (v !== undefined && v !== '') return v;
    if (def !== undefined) return def;
    // Переменной нет и default не задан — оставляем placeholder.
    // Это явный сигнал «забыли задать», легче дебажить.
    if (!context.warnedFor.has(name)) {
      context.warnedFor.add(name);
      log.warn('config', `placeholder $\{${name}\} не разрешён (нет в .env)`);
    }
    return full;
  });
}

function walk(node, context) {
  if (Array.isArray(node)) {
    return node.map(item => walk(item, context));
  }
  if (node !== null && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = walk(v, context);
    }
    return out;
  }
  if (typeof node === 'string' && node.includes('${')) {
    return expandString(node, context);
  }
  return node;
}

/**
 * Прочитать config/systems.json и вернуть массив систем
 * со всеми ${VAR}-подстановками. dotenv.config() должен быть
 * вызван до этого, иначе process.env будет пустым.
 */
export function loadSystems() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const context = { warnedFor: new Set() };
  return walk(raw, context);
}
