// Тесты решающей функции чекера SMB-записей (src/recordings-check.js →
// evaluateChannel). Сеть и PowerShell здесь не участвуют: на вход — список
// файлов «самый свежий первым», как его отдаёт листинг.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateChannel } from '../src/recordings-check.js';

const cfg = { freshnessMin: 60, minFileBytes: 100 * 1024, maxBadRatio: 0.3 };
const MB = 1024 * 1024;

// Хвост из нормальных чанков, чтобы доля битых не мешала проверяемой ветке.
function goodTail(n, fromAgeMin = 2) {
  return Array.from({ length: n }, (_, i) => ({
    name: `ok-${i}.mkv`, size: 2 * MB, ageMin: fromAgeMin + i,
  }));
}

test('файл с отрицательным возрастом — пишется сейчас, канал online', () => {
  // Регрессия 17.07–11.09.2026: «устарело: последний чанк -0 мин назад» → offline.
  const files = [{ name: 'now.mkv', size: 1.5 * MB, ageMin: -0.07 }, ...goodTail(5)];
  const r = evaluateChannel(files, cfg);
  assert.equal(r.online, true);
  assert.equal(r.recording, true);
  assert.equal(r.newestAgeMin, 0);
  assert.doesNotMatch(r.notes, /устарело|-0/);
});

test('спешащие часы регистратора на минуту — тоже свежий файл', () => {
  const files = [{ name: 'now.mkv', size: 1.5 * MB, ageMin: -1.2 }, ...goodTail(3)];
  assert.equal(evaluateChannel(files, cfg).online, true);
});

test('пустой свежий файл — регистратор подключается, судим по предыдущему', () => {
  // Сторож перезапустил ffmpeg: файл открыт, но кадров ещё нет.
  const files = [{ name: 'opening.mkv', size: 0, ageMin: 0.7 }, ...goodTail(5, 1)];
  const r = evaluateChannel(files, cfg);
  assert.equal(r.online, true);
  assert.equal(r.recording, true);
  assert.equal(r.totalCount, 5, 'открывающийся файл в выборку не входит');
  assert.equal(r.badCount, 0);
});

test('пустой файл старше льготного окна — уже битый, запись не идёт', () => {
  const files = [{ name: 'stuck.mkv', size: 0, ageMin: 3 }, ...goodTail(5, 4)];
  const r = evaluateChannel(files, cfg);
  assert.equal(r.online, true);
  assert.equal(r.recording, false);
  assert.match(r.notes, /битый/);
});

test('единственный файл в папке пустой — пропускать нечего, он и оценивается', () => {
  const r = evaluateChannel([{ name: 'only.mkv', size: 0, ageMin: 0.5 }], cfg);
  assert.equal(r.recording, false);
  assert.equal(r.totalCount, 1);
});

test('после пропуска открывающегося файла предыдущий тоже битый — канал плохой', () => {
  // Серия обрывов: каждый перезапуск оставляет по заголовку. Пропуск одного
  // файла не должен маскировать это.
  const files = [
    { name: 'opening.mkv', size: 0, ageMin: 0.3 },
    { name: 'header-only.mkv', size: 48, ageMin: 2.5 },
    ...goodTail(4, 3),
  ];
  const r = evaluateChannel(files, cfg);
  assert.equal(r.recording, false);
  assert.match(r.notes, /битый/);
});

test('нет файлов — offline с понятной причиной', () => {
  const r = evaluateChannel([], cfg);
  assert.equal(r.online, false);
  assert.equal(r.notes, 'нет файлов в папке');
});

test('последний чанк старше freshnessMin — устарело, offline', () => {
  const files = [{ name: 'old.mkv', size: 2 * MB, ageMin: 95 }, ...goodTail(3, 96)];
  const r = evaluateChannel(files, cfg);
  assert.equal(r.online, false);
  assert.equal(r.recording, false);
  assert.match(r.notes, /устарело: последний чанк 1\.6 ч назад/);
});

test('свежий, но битых больше maxBadRatio — запись нестабильна', () => {
  const files = [
    { name: 'fresh.mkv', size: 2 * MB, ageMin: 1 },
    ...Array.from({ length: 4 }, (_, i) => ({ name: `bad-${i}.mkv`, size: 48, ageMin: 5 + i })),
    ...goodTail(5, 20),
  ];
  const r = evaluateChannel(files, cfg);
  assert.equal(r.online, true);
  assert.equal(r.recording, false);
  assert.match(r.notes, /качество записи плохое: 4\/10/);
});

test('всё в норме — online и recording, в заметке размер и возраст', () => {
  const files = [{ name: 'fresh.mkv', size: 1.8 * MB, ageMin: 1.02 }, ...goodTail(19)];
  const r = evaluateChannel(files, cfg);
  assert.equal(r.online, true);
  assert.equal(r.recording, true);
  assert.match(r.notes, /последний чанк 1 мин назад \(1\.8 МБ\); битых 0\/20/);
});
