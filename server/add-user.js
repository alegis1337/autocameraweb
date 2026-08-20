/**
 * add-user.js — управление учётками веб-интерфейса.
 *
 * Запуск:
 *   node server/add-user.js <логин> <пароль> [viewer|admin]   — создать/обновить
 *   node server/add-user.js --list                            — список
 *   node server/add-user.js --delete <логин>                  — удалить
 *
 * Через npm: npm run add-user -- <логин> <пароль> admin
 */
import { openWebDb } from './web-db.js';
import { hashPassword } from './auth.js';

const args = process.argv.slice(2);
const db = openWebDb();

function usage(code = 0) {
  console.log('Использование:');
  console.log('  node server/add-user.js <логин> <пароль> [viewer|admin]');
  console.log('  node server/add-user.js --list');
  console.log('  node server/add-user.js --delete <логин>');
  db.close();
  process.exit(code);
}

if (!args.length || args[0] === '--help' || args[0] === '-h') usage();

if (args[0] === '--list') {
  const users = db.listUsers();
  if (!users.length) console.log('Учёток нет');
  for (const u of users) console.log(`${u.username}\t${u.role}\tсоздан ${u.created_at.slice(0, 19).replace('T', ' ')}`);
  db.close();
  process.exit(0);
}

if (args[0] === '--delete') {
  const name = args[1];
  if (!name) usage(2);
  console.log(db.deleteUser(name) ? `Учётка "${name}" удалена` : `Учётки "${name}" нет`);
  db.close();
  process.exit(0);
}

const [username, password, roleArg] = args;
if (!username || !password) usage(2);

const role = roleArg || 'viewer';
if (role !== 'viewer' && role !== 'admin') {
  console.error(`Роль должна быть viewer или admin, получено: ${role}`);
  db.close();
  process.exit(2);
}
if (password.length < 8) {
  console.error('Пароль короче 8 символов — слишком слабый');
  db.close();
  process.exit(2);
}

db.upsertUser(username, hashPassword(password), role);
console.log(`Учётка "${username}" сохранена, роль: ${role}`);
db.close();
