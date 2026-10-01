/**
 * load-env.js — загрузка `.env` ДО остальных модулей проекта.
 *
 * Почему отдельным файлом, а не строчкой в точке входа. Тело ES-модуля
 * выполняется ПОСЛЕ всех его импортов, поэтому `dotenv.config()` в теле
 * `index.js` опаздывал: модули, читающие `process.env` на верхнем уровне,
 * успевали прочитать пустоту. Так 20.08.2026 `reporter.js` получил пустой
 * `REPORT_GROUPS` — и рассылка отчётов заказчикам молча прекратилась.
 *
 * Модуль строго СИНХРОННЫЙ: `await import('dotenv')` здесь не помог бы —
 * при top-level await соседние импорты точки входа выполнятся, не дожидаясь
 * его. По той же причине его импорт должен стоять ПЕРВЫМ.
 *
 * Путь к `.env` считается от корня проекта, а не от текущей папки процесса:
 * Планировщик задаёт рабочую папку сам, но запуск из другого места не должен
 * оставлять прогон без конфигурации.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_PATH = path.join(ROOT, '.env');

/** true — `.env` найден и разобран; false — работаем на системном окружении. */
export const envLoaded = fs.existsSync(ENV_PATH);
if (envLoaded) dotenv.config({ path: ENV_PATH });
