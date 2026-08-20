/**
 * auth.js — вход в веб-интерфейс.
 *
 * Пароли — scrypt из node:crypto: bcrypt требует нативной сборки, которой на
 * этой ВМ нет, а тянуть компилятор ради логина незачем. Сессии — случайный id
 * в HttpOnly-cookie, хранится в web.db.
 *
 * Перенос из проекта wifi-monitor («рынок»), server/auth.js.
 */
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const SCRYPT_KEYLEN = 64;

/** Формат хранения: "scrypt$<saltHex>$<hashHex>". */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  let actual;
  try {
    actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Проверка логина/пароля и выдача сессии. Возвращает { sid, username, role } или null. */
export function login(webDb, username, password) {
  const user = webDb.getUser(username);
  // Хеш считаем даже когда пользователя нет — иначе по времени ответа можно
  // выяснить, какие логины существуют.
  const ref = user ? user.pass_hash : 'scrypt$00$00';
  const ok = verifyPassword(password, ref);
  if (!user || !ok) return null;
  const sid = randomBytes(32).toString('hex');
  webDb.createSession(sid, user.username, config.web.sessionTtlHours);
  return { sid, username: user.username, role: user.role };
}
