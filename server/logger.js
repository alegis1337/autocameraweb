/**
 * logger.js — лог веб-сервера. Отдельный файл от логов прогонов
 * (logs/web-YYYY-MM-DD.log), иначе долгоживущий веб мешался бы в одном файле
 * с записями коллектора и ломал чтение истории прогона.
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

function write(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${level} ${msg}`;
  console.log(line);
  try {
    if (!existsSync(config.logDir)) mkdirSync(config.logDir, { recursive: true });
    const day = ts.slice(0, 10);
    appendFileSync(join(config.logDir, `web-${day}.log`), line + '\n', 'utf8');
  } catch {
    // Лог не должен ронять сервер: не смогли записать — остаёмся с консолью.
  }
}

export const log = {
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
};
