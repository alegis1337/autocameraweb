// Ошибки ISAPI-клиента (src/isapi.js): текст причины и таймаут запроса.
// Сеть не нужна — «регистратор» здесь локальный node:http, который молчит
// или рвёт соединение посреди ответа.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { describeFetchError, isapiRequest } from '../src/isapi.js';

test('describeFetchError: причина из err.cause попадает в текст', () => {
  const err = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ETIMEDOUT 192.0.2.10:80'), { code: 'ETIMEDOUT' }) });
  assert.equal(describeFetchError(err, 30_000), 'fetch failed (connect ETIMEDOUT 192.0.2.10:80)');
});

test('describeFetchError: у AggregateError берётся первая причина', () => {
  const agg = new AggregateError([Object.assign(new Error('connect ECONNREFUSED ::1:80'), { code: 'ECONNREFUSED' })]);
  const err = new TypeError('fetch failed', { cause: agg });
  assert.equal(describeFetchError(err, 30_000), 'fetch failed (connect ECONNREFUSED ::1:80)');
});

test('describeFetchError: без причины — как было', () => {
  assert.equal(describeFetchError(new Error('ISAPI /x returned 500'), 30_000), 'ISAPI /x returned 500');
});

test('describeFetchError: таймаут описывается секундами', () => {
  const err = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  assert.equal(describeFetchError(err, 30_000), 'нет ответа за 30 с');
});

// Сервер, который принимает соединение и делает с ним то, что скажет handler.
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

test('isapiRequest: молчащий регистратор — ошибка таймаута, а не вечное ожидание', async () => {
  const prev = process.env.ISAPI_TIMEOUT_SEC;
  process.env.ISAPI_TIMEOUT_SEC = '1';
  try {
    await withServer(() => { /* не отвечаем никогда */ }, async (base) => {
      const t0 = Date.now();
      await assert.rejects(isapiRequest(base, '/ISAPI/x', 'u', 'p'), (err) => {
        assert.equal(err.message, 'нет ответа за 1 с');
        assert.equal(err.timedOut, true);
        return true;
      });
      assert.ok(Date.now() - t0 < 5000, 'ждали дольше таймаута');
    });
  } finally {
    if (prev === undefined) delete process.env.ISAPI_TIMEOUT_SEC; else process.env.ISAPI_TIMEOUT_SEC = prev;
  }
});

test('isapiRequest: обрыв посреди ответа — в тексте есть причина, не голое «terminated»', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml', 'Content-Length': '1000' });
    res.write('<partial>');
    setTimeout(() => res.socket.destroy(), 20);
  }, async (base) => {
    await assert.rejects(isapiRequest(base, '/ISAPI/x', 'u', 'p'), (err) => {
      assert.notEqual(err.message, 'terminated');
      assert.match(err.message, /terminated \(.+\)|closed|reset/i);
      assert.equal(err.timedOut, false);
      return true;
    });
  });
});
