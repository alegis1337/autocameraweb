/**
 * web-db.js — учётки и сессии веб-интерфейса (state/web.db).
 *
 * Отдельный файл от monitor.db намеренно: веб-сервер не должен иметь права
 * записи в источник правды мониторинга. monitor.db он открывает только на
 * чтение, а пишет исключительно сюда.
 *
 * Перенос из проекта wifi-monitor («рынок»), server/db.js — без изменений
 * по сути, только пути и комментарии под этот проект.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  username   TEXT PRIMARY KEY,
  pass_hash  TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'viewer',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

export function openWebDb() {
  const dir = dirname(config.webDbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(config.webDbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);

  return {
    getUser(username) {
      return db.prepare('SELECT username, pass_hash, role FROM users WHERE username = ?').get(username) ?? null;
    },
    upsertUser(username, passHash, role) {
      db.prepare(
        `INSERT INTO users (username, pass_hash, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET pass_hash = excluded.pass_hash, role = excluded.role`,
      ).run(username, passHash, role, new Date().toISOString());
    },
    listUsers() {
      return db.prepare('SELECT username, role, created_at FROM users ORDER BY username').all();
    },
    deleteUser(username) {
      const info = db.prepare('DELETE FROM users WHERE username = ?').run(username);
      db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
      return info.changes > 0;
    },
    createSession(sid, username, ttlHours) {
      const now = new Date();
      const exp = new Date(now.getTime() + ttlHours * 3600 * 1000);
      db.prepare('INSERT INTO sessions (sid, username, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(sid, username, now.toISOString(), exp.toISOString());
    },
    getSession(sid) {
      // JOIN users — чтобы роль бралась актуальная, без перелогина после её смены.
      const r = db
        .prepare(
          `SELECT s.sid, s.username, s.expires_at, u.role
           FROM sessions s JOIN users u ON u.username = s.username
           WHERE s.sid = ?`,
        )
        .get(sid);
      if (!r) return null;
      if (new Date(r.expires_at).getTime() < Date.now()) {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return null;
      }
      return r;
    },
    deleteSession(sid) {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    },
    purgeExpiredSessions() {
      return db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString()).changes;
    },
    close() {
      db.close();
    },
  };
}
