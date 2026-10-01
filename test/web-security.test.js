// Тесты защитной обвязки веба (server/security.js) — аудит 16.09.2026.
// Лимит попыток входа, чистка причин от адресов, путь статики, Origin, CSP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sep, resolve } from 'node:path';
import {
  LoginThrottle, scrubSensitive, publicPathFor, originAllowed, securityHeaders, cspHeader, formatCspReport, CSP,
  clientIpFrom, normalizeOrigin,
} from '../server/security.js';

// Часы под контролем теста: окна и блокировки проверяем без ожидания.
function makeThrottle(opts) {
  let now = 1_000_000;
  const t = new LoginThrottle({ windowMs: 60_000, blockMs: 30_000, maxPerIp: 3, maxPerUser: 5, ...opts }, () => now);
  return { t, tick: (ms) => { now += ms; } };
}

test('throttle: до порога попытки разрешены, на пороге — заперто на blockMs', () => {
  const { t, tick } = makeThrottle();
  assert.deepEqual(t.check('192.0.2.1', 'admin'), { ok: true });
  assert.equal(t.fail('192.0.2.1', 'admin'), false);
  assert.equal(t.fail('192.0.2.1', 'admin'), false);
  assert.equal(t.fail('192.0.2.1', 'admin'), true, 'третья неудача = порог по IP');
  const gate = t.check('192.0.2.1', 'other');
  assert.equal(gate.ok, false);
  assert.equal(gate.retryAfterSec, 30);
  tick(29_000);
  assert.equal(t.check('192.0.2.1', 'other').ok, false);
  tick(2_000);
  assert.equal(t.check('192.0.2.1', 'other').ok, true, 'срок вышел — снова можно');
});

test('throttle: неудачи старше окна не считаются', () => {
  const { t, tick } = makeThrottle();
  t.fail('ip', 'u'); t.fail('ip', 'u');
  tick(61_000);
  assert.equal(t.fail('ip', 'u'), false, 'старые две выпали из окна, это первая');
});

test('throttle: порог по логину ловит перебор с разных адресов', () => {
  const { t } = makeThrottle();
  for (let i = 1; i <= 4; i++) assert.equal(t.fail(`192.0.2.${i}`, 'admin'), false);
  assert.equal(t.fail('192.0.2.5', 'admin'), true, 'пятая неудача по логину — заперт');
  assert.equal(t.check('192.0.2.99', 'admin').ok, false, 'новый адрес, тот же логин — заперт');
  assert.equal(t.check('192.0.2.99', 'operator').ok, true, 'другой логин не задет');
});

test('throttle: успешный вход сбрасывает счётчики', () => {
  const { t } = makeThrottle();
  t.fail('ip', 'u'); t.fail('ip', 'u');
  t.success('ip', 'u');
  assert.equal(t.fail('ip', 'u'), false);
  assert.equal(t.fail('ip', 'u'), false);
});

test('throttle: purge выбрасывает отработавшие записи', () => {
  const { t, tick } = makeThrottle();
  t.fail('ip', 'u');
  tick(61_000);
  t.purge();
  assert.equal(t.byIp.size, 0);
  assert.equal(t.byUser.size, 0);
});

test('throttle: пустой логин считается только по IP', () => {
  const { t } = makeThrottle();
  t.fail('ip', '');
  assert.equal(t.byUser.size, 0);
});

test('scrubSensitive: IP с портом, UNC, путь Windows и URL вырезаются', () => {
  assert.equal(scrubSensitive('RTSP недоступен: connect ECONNREFUSED 192.0.2.192:554 (undefined)'),
    'RTSP недоступен: connect ECONNREFUSED <адрес скрыт> (undefined)');
  assert.equal(scrubSensitive('Нет связи с камерой (192.0.2.158)'), 'Нет связи с камерой (<адрес скрыт>)');
  assert.equal(scrubSensitive('нет файлов в \\\\192.0.2.4\\Video\\11'), 'нет файлов в <адрес скрыт>');
  assert.equal(scrubSensitive('ошибка C:\\Users\\x\\state\\monitor.db'), 'ошибка <адрес скрыт>');
  assert.equal(scrubSensitive('поток rtsp://<логин>:<пароль>@192.168.1.5:554/stream1 не открылся'),
    'поток <адрес скрыт> не открылся');
  assert.equal(scrubSensitive('ISAPI http://192.0.2.30/ISAPI/System вернул 401'), 'ISAPI <адрес скрыт> вернул 401');
});

test('scrubSensitive: обычные причины не трогает', () => {
  for (const s of ['NO VIDEO', '0 kbps, нет сигнала', 'последний чанк 1 мин назад (2.3 МБ); битых 6/20',
    'Нет видеосигнала (15KB/2s, NVR ch1)', 'качество записи плохое: 7/20 битых (35%)']) {
    assert.equal(scrubSensitive(s), s);
  }
  assert.equal(scrubSensitive(null), '');
  assert.equal(scrubSensitive(undefined), '');
});

test('publicPathFor: обычный файл внутри public — путь; выход наружу — null', () => {
  const pub = resolve(`${sep}srv${sep}app${sep}public`); // resolve — на Windows добавит букву диска
  assert.equal(publicPathFor('/styles.css', pub), `${pub}${sep}styles.css`);
  assert.equal(publicPathFor('/sub/x.js', pub), `${pub}${sep}sub${sep}x.js`);
  assert.equal(publicPathFor('/', pub), null, 'сам каталог — не файл');
  for (const bad of ['/../.env', '/../../.env', '/..%2f..%2f.env', '/%2e%2e/%2e%2e/.env',
    '/styles.css/../../.env', '/..\\..\\.env', '/a/../../x', '/%00.css', '/%zz']) {
    assert.equal(publicPathFor(bad, pub), null, bad);
  }
});

test('publicPathFor: соседний каталог public2 не проходит как «начинается с public»', () => {
  const pub = resolve(`${sep}srv${sep}app${sep}public`); // resolve — на Windows добавит букву диска
  assert.equal(publicPathFor('/../public2/x.js', pub), null);
});

test('originAllowed: свой Origin — да, чужой, null и мусор — нет, без заголовка — да', () => {
  assert.equal(originAllowed('http://192.168.1.10:8081', '192.168.1.10:8081'), true);
  assert.equal(originAllowed('http://evil.example', '192.168.1.10:8081'), false);
  assert.equal(originAllowed('null', '192.168.1.10:8081'), false);
  assert.equal(originAllowed('not a url', '192.168.1.10:8081'), false);
  assert.equal(originAllowed(undefined, '192.168.1.10:8081'), true);
});

test('securityHeaders: обязательные заголовки на месте, CSP без inline/eval для скриптов', () => {
  const h = securityHeaders('enforce');
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['X-Frame-Options'], 'SAMEORIGIN');
  assert.ok(h['Referrer-Policy']);
  assert.equal(h['Content-Security-Policy'], CSP);
  assert.equal(securityHeaders()['Content-Security-Policy-Report-Only'], CSP, 'по умолчанию — только доклад');
  assert.equal(securityHeaders()['Content-Security-Policy'], undefined);
  assert.deepEqual(cspHeader('off'), {});
  assert.ok(CSP.includes('report-uri /csp-report'));
  const script = CSP.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src'));
  assert.ok(script.includes("'self'"));
  assert.ok(!script.includes('unsafe-inline'));
  assert.ok(!CSP.includes('unsafe-eval'));
  assert.ok(CSP.includes("object-src 'none'"));
  assert.ok(CSP.includes("form-action 'self'"));
});

test('formatCspReport: из отчёта браузера — одна строка; мусор — null', () => {
  const body = JSON.stringify({ 'csp-report': {
    'document-uri': 'http://192.0.2.10:8081/', 'violated-directive': 'script-src',
    'blocked-uri': 'https://evil.example/x.js', 'original-policy': 'x'.repeat(5000),
  } });
  assert.equal(formatCspReport(body), 'CSP: script-src заблокировал https://evil.example/x.js на http://192.0.2.10:8081/');
  assert.equal(formatCspReport('not json'), null);
  assert.equal(formatCspReport('[]'), null);
  assert.equal(formatCspReport('"str"'), null);
});

test('originAllowed: за прокси Host не совпадает — выручает список публичных origin', () => {
  // Регрессия 17.09.2026: nginx с доменом подменял Host на адрес ВМ, и все POST
  // со входа получали 403.
  const pub = ['https://status.example:8081'];
  assert.equal(originAllowed('https://status.example:8081', '192.0.2.10:8081'), false, 'без списка — отказ');
  assert.equal(originAllowed('https://status.example:8081', '192.0.2.10:8081', pub), true);
  assert.equal(originAllowed('https://STATUS.example:8081/', '192.0.2.10:8081', pub), true, 'регистр и слэш не важны');
  assert.equal(originAllowed('http://status.example:8081', '192.0.2.10:8081', pub), false, 'другая схема — чужой');
  assert.equal(originAllowed('https://evil.example', '192.0.2.10:8081', pub), false);
});

test('normalizeOrigin: origin без пути, в нижнем регистре; мусор — пустая строка', () => {
  assert.equal(normalizeOrigin('https://Status.Example:8081/login?x=1'), 'https://status.example:8081');
  assert.equal(normalizeOrigin('not a url'), '');
});

test('clientIpFrom: без прокси — сокет; от прокси — крайний справа не-прокси из X-Forwarded-For', () => {
  const proxies = new Set(['192.0.2.10']);
  assert.equal(clientIpFrom('192.0.2.7', '203.0.113.5', proxies), '192.0.2.7', 'X-Forwarded-For от чужого адреса не читаем');
  assert.equal(clientIpFrom('192.0.2.10', '203.0.113.5', proxies), '203.0.113.5');
  assert.equal(clientIpFrom('192.0.2.10', '203.0.113.5, 192.0.2.10', proxies), '203.0.113.5', 'свой прокси в цепочке пропускаем');
  assert.equal(clientIpFrom('192.0.2.10', '198.51.100.9, 203.0.113.5', proxies), '203.0.113.5', 'берём ближайший к прокси');
  assert.equal(clientIpFrom('192.0.2.10', '', proxies), null, 'прокси без заголовка — клиент неизвестен');
  assert.equal(clientIpFrom('192.0.2.10', undefined, new Set()), '192.0.2.10', 'прокси не доверенный — это просто клиент');
});

test('throttle: неизвестный клиент (null) считается только по логину', () => {
  const { t } = makeThrottle();
  for (let i = 0; i < 4; i++) assert.equal(t.fail(null, 'admin'), false);
  assert.equal(t.byIp.size, 0, 'по адресу ничего не копится');
  assert.equal(t.fail(null, 'admin'), true, 'а порог по логину работает');
  assert.equal(t.check(null, 'operator').ok, true);
});
