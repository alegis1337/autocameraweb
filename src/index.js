/**
 * AutoCamera Monitor — Main Pipeline
 *
 * Usage:
 *   node src/index.js                             — полный запуск (ручной, как раньше)
 *   node src/index.js --light                     — лёгкий прогон: чекеры + timeline + live.html.
 *                                                   БЕЗ снимков, email, helpdesk. Для расписания
 *                                                   каждые 15 мин.
 *   node src/index.js --daily                     — конец дня: чекеры + снимки (online+offline)
 *                                                   + email с историей за день + helpdesk.
 *   node src/index.js --dry-run                   — без отправки email
 *   node src/index.js --test-email                — тестовый email
 *   node src/index.js --dry-run --only <id системы>  — только одна система
 *   node src/index.js --debug                     — подробные логи
 *   node src/index.js --reset-state               — обнулить helpdesk-state.json
 *   node src/index.js --no-snapshots              — не снимать кадры и не лезть на Я.Диск
 *
 * v2 features:
 *   • helpdesk-state в state/helpdesk-state.json — заявки уходят только
 *     при смене статуса (active↔broken). См. src/state.js.
 *   • Snapshots → Битрикс Диск — кадры заливаются в Битрикс с публичными
 *     ссылками. См. src/snapshots.js + src/bitrix-disk.js.
 *   • Live-монитор reports/live.html — auto-refresh 30 сек (обновляется
 *     каждым light-прогоном).
 *   • Timeline state/timeline-YYYY-MM-DD.json — журнал событий offline/online
 *     за день. Light-прогоны его наполняют, daily-прогон рисует историю.
 */

import fs from 'fs';
import path from 'path';
import * as log from './logger.js';

import { buildReport, sendReport, cleanOldReports, REPORT_GROUPS, groupRecipients, collectBrokenCameras, sendHelpdeskReport, isUnusedChannel } from './reporter.js';
import { fetchHikvisionStatus } from './isapi.js';
import { checkCamerasByRtsp } from './rtsp-check.js';
import { checkTrassirSystem } from './trassir-check.js';
import { checkBewardSystem } from './beward-check.js';
import { checkRecordingsSystem } from './recordings-check.js';
import { checkHikvisionMultiSystem } from './hikvision-multi.js';
import { checkRostelecomSystem } from './rostelecom-check.js';
import { checkTplinkTapoSystem } from './tplink-tapo-check.js';
import { loadState, saveState, resetState, diffAndUpdate, pickReminders, markNotified } from './state.js';
import { loadTodayTimeline, saveTimeline, diffAndAppend, summarize } from './timeline.js';
import { openMonitorDb, recordRun } from './monitor-db.js';
import { collectAttention, currentlyBrokenKeys, detectOutagesFromRun } from './stats.js';
import { loadAttentionState, saveAttentionState, diffAttention } from './attention-state.js';
import { checkQuality, loadQualityState, saveQualityState, diffQuality } from './quality-check.js';
import { captureAll, cleanupRun } from './snapshots.js';
import { uploadFreshSnapshot, cleanupOlderThan } from './bitrix-disk.js';
import * as lastGood from './last-good.js';
import { loadSystems } from './config-loader.js';
import { spawn } from 'child_process';
import { acquireLock, forceAcquireLock, releaseLock } from './lock.js';
import {
  ensureToday, loadDailyState, saveDailyState, recordOutbox,
  markSent, markFailed, pendingGroups, isGroupSent, todayMskDate, mskMinutes,
} from './daily-state.js';

// ─── Load .env ────────────────────────────────────────────────────────────────
const dotenvPath = path.resolve('.env');
if (fs.existsSync(dotenvPath)) {
  const { default: dotenv } = await import('dotenv');
  dotenv.config();
}

// ─── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDryRun      = args.includes('--dry-run');
const isTestEmail   = args.includes('--test-email');
const isDebug       = args.includes('--debug');
const isResetState  = args.includes('--reset-state');
const isNoSnapshots = args.includes('--no-snapshots');
const isLight       = args.includes('--light');
const isDaily       = args.includes('--daily');
const onlyId        = (() => {
  const idx = args.indexOf('--only');
  return idx >= 0 ? args[idx + 1] : null;
})();

if (isLight && isDaily) {
  console.error('Нельзя задать одновременно --light и --daily');
  process.exit(2);
}

// runMode — для логирования и ветвлений ниже.
const runMode = isLight ? 'light' : (isDaily ? 'daily' : 'manual');

if (isDebug) log.setLogLevel('DEBUG');


// --reset-state: одноразовая операция, обнуляющая helpdesk-state.json
// (после её отработки следующий прогон сообщит ВСЕ текущие проблемы как
// "новые"). Полезно при первом запуске v2 или когда state-файл устарел.
if (isResetState) {
  resetState();
  log.info('state', 'helpdesk-state.json обнулён (--reset-state)');
}

// ─── TEST_MODE banner (v2 dev environment) ──────────────────────────────────
// Печатается, если в .env установлено TEST_MODE=true.
// Защита от случайного запуска прод-конфига в тестовой папке: показывает,
// какие реально адреса используются как получатели.
if (process.env.TEST_MODE === 'true') {
  const truncate = (s, n = 80) => (s || '').length > n ? (s.slice(0, n) + '…') : (s || '(пусто)');
  const banner = [
    '',
    '╔══════════════════════════════════════════════════════════════════════╗',
    '║                    *** TEST MODE — v2 DEV ENV ***                    ║',
    '║                                                                      ║',
    '║  Это тестовая среда AutoCamera. Письма уходят только на              ║',
    '║  тестовые адреса (см. ниже). Helpdesk при пустом HELPDESK_TO         ║',
    '║  отключён.                                                           ║',
    '╠══════════════════════════════════════════════════════════════════════╣',
    // Группы берём из .env (REPORT_GROUPS) — имён групп в коде нет.
    ...REPORT_GROUPS.map((g) => `║  ${(g + ':').padEnd(21)}${truncate(groupRecipients(g), 47).padEnd(47)}║`),
    `║  REPORT_TO (fallback):${truncate(process.env.REPORT_TO, 47).padEnd(47)}║`,
    `║  HELPDESK_TO:         ${truncate(process.env.HELPDESK_TO, 47).padEnd(47)}║`,
    `║  BITRIX_WEBHOOK_URL:  ${truncate(process.env.BITRIX_WEBHOOK_URL, 47).padEnd(47)}║`,
    '╚══════════════════════════════════════════════════════════════════════╝',
    '',
  ].join('\n');
  console.log(banner);
  log.info('test-mode', 'TEST_MODE активен — все письма идут на тестовые адреса');
}

// ─── Load systems config ──────────────────────────────────────────────────────
// Через config-loader, который разворачивает ${VAR} плейсхолдеры из .env.
// Все IP/host'ы/креды в systems.json — плейсхолдеры вида ${SITE_HOST}:
// в JSON лежат только имена переменных, значения — в .env.
const ROOT = path.resolve('.');
const systemsConfig = loadSystems();

// ─── Ensure directories ───────────────────────────────────────────────────────
fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'logs'),    { recursive: true });

// ─── snapMap helper ───────────────────────────────────────────────────────────
// Собирает для каждого результата камеры путь к её «текущей» картинке.
// Mode:
//   'cid'  → src = "cid:..." и в cidList — { cid, path } для inline-attachments
//            писем (там file:// не работает).
//   'file' → src = относительный путь от reports/*.html для локального
//            просмотра в браузере.
// Источники картинок:
//   1. captureMap (сделанный только что свежий кадр) — приоритет, если есть.
//   2. last-good кэш — фолбэк для офлайн или вообще не снятых камер.
function buildSnapMap(systemResults, captureMap, mode) {
  const snapMap = new Map();
  const cidList = [];
  const cidSeen = new Set();

  for (const sys of systemResults) {
    for (const cam of sys.cameras || []) {
      const key = `${sys.id}|${cam.index}`;

      // 1. Попытка взять свежий кадр из captureMap
      let chosen = null;
      const fresh = captureMap?.get(key);
      if (fresh && fs.existsSync(fresh)) {
        chosen = { path: fresh, fresh: true, ageMs: 0 };
      } else {
        // 2. last-good кэш
        const meta = lastGood.getMeta(sys.id, cam.index, cam.name);
        if (meta) chosen = { path: meta.path, fresh: false, ageMs: meta.ageMs };
      }

      // 3. Снимок «взаймы» у камеры другой системы (cam.snapshotFrom).
      //    Нужен там, где у системы нет своих кадров (тип smb-recordings —
      //    это записи на шаре без снимков): показываем в её тайле last-good
      //    кадр камеры, указанной в cam.snapshotFrom.
      if (!chosen && cam.snapshotFrom) {
        const ref = cam.snapshotFrom;
        const meta = lastGood.getMeta(ref.system, ref.camIndex, ref.camName);
        if (meta) chosen = { path: meta.path, fresh: false, ageMs: meta.ageMs };
      }

      if (!chosen) continue;

      if (mode === 'cid') {
        const cid = `cam-${sys.id.replace(/[^a-z0-9]+/gi, '_')}-${cam.index ?? 0}@autocamera`;
        if (!cidSeen.has(cid)) {
          cidList.push({ cid, path: chosen.path });
          cidSeen.add(cid);
        }
        snapMap.set(key, { src: `cid:${cid}`, fresh: chosen.fresh, ageMs: chosen.ageMs });
      } else {
        // file mode: относительный путь от reports/<file>.html.
        // reports/ и screenshots/ лежат рядом → ../screenshots/last-good/...
        const rel = path
          .relative(path.join(ROOT, 'reports'), chosen.path)
          .replace(/\\/g, '/');
        snapMap.set(key, { src: rel, fresh: chosen.fresh, ageMs: chosen.ageMs });
      }
    }
  }

  return { snapMap, cidList };
}

// ─── Авто-досылка отчётов заказчикам (вызывается из light-прогона) ─────────────
// Если daily не смог разослать отчёты (упал из-за гонки/иной ошибки или SMTP не
// принял письмо), light раз в 15 мин дотягивает рассылку с шагом 30 мин, пока
// все группы в state/daily-state.json не станут 'sent'.

const RETRY_GAP_MS = 30 * 60 * 1000;   // не дёргать отправку чаще раза в 30 мин

/** Во сколько по МСК (минут от полуночи) запускается daily. */
function dailyStartMinMsk() {
  try {
    const sch = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'schedule.json'), 'utf8'));
    const [h, m] = String(sch?.daily?.startTimeMSK || '14:00').split(':').map(Number);
    return h * 60 + (m || 0);
  } catch { return 14 * 60; }
}

/** Были ли сегодня (МСК) собраны HTML-отчёты daily-прогоном. */
function dailyReportsExistToday() {
  const today = todayMskDate();   // YYYY-MM-DD; совпадает с UTC-датой прогона 11:00 UTC
  try {
    return fs.readdirSync(path.join(ROOT, 'reports'))
      .some(f => f.startsWith(`report-${today}`) && f.endsWith('.html'));
  } catch { return false; }
}

/** Запустить отдельный полный daily-прогон (когда отчётов на диске нет). */
function spawnDailyRecovery() {
  try {
    releaseLock();   // отдаём лок — дочерний daily возьмёт его без ожидания
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--daily'], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    log.info('retry', 'Запущен восстановительный daily-прогон', { pid: child.pid });
  } catch (err) {
    log.error('retry', 'Не удалось запустить восстановительный daily-прогон', { error: err.message });
  }
}

async function retryCustomerEmails() {
  const today = todayMskDate();
  let state = loadDailyState();
  const afterDaily = mskMinutes() >= dailyStartMinMsk() + 10;   // +10 мин на нормальный прогон

  // ── Случай 1: за сегодня нет состояния рассылки ──
  if (!state || state.date !== today) {
    if (!afterDaily) return;                 // время daily ещё не настало — это норма

    // Если отчёты за сегодня уже на диске — daily отрабатывал (старый код без
    // состояния либо сбой записи state уже после рассылки). Письма ушли —
    // фиксируем «отправлено» и НЕ дублируем рассылку. Иначе daily не дошёл
    // даже до сборки отчётов (как 15 июня) — поднимаем восстановительный прогон.
    if (dailyReportsExistToday()) {
      log.info('retry', 'Состояния за сегодня нет, но отчёты daily на диске есть — помечаю как отправленные, повтор не нужен');
      state = ensureToday(REPORT_GROUPS);
      for (const g of REPORT_GROUPS) markSent(state, g, null);
      saveDailyState(state);
      return;
    }

    log.warn('retry', 'За сегодня нет ни состояния, ни отчётов — daily не отработал, поднимаю восстановительный прогон');
    state = ensureToday(REPORT_GROUPS);
    state.lastAttemptAt = new Date().toISOString();   // занимаем 30-мин слот, чтобы не плодить прогоны
    saveDailyState(state);
    spawnDailyRecovery();
    return;
  }

  // ── Случай 2: состояние есть, но не все группы отправлены ──
  const pend = pendingGroups(state);
  if (pend.length === 0) return;             // тумблер «всё отправлено» — делать нечего

  const lastAt = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : 0;
  if (Date.now() - lastAt < RETRY_GAP_MS) {
    log.info('retry', `Есть неотправленные группы (${pend.join(', ')}), но с прошлой попытки <30 мин — жду`);
    return;
  }

  log.section('Авто-досылка отчётов заказчикам');
  state.lastAttemptAt = new Date().toISOString();
  saveDailyState(state);

  let needRecovery = false;
  for (const group of pend) {
    const g = state.groups[group];
    if (g.reportPath && fs.existsSync(g.reportPath)) {
      // Отчёт собран — повторяем именно отправку письма
      log.stepStart('retry', `Повторная отправка [${group}]`, { to: g.to, attempt: (g.attempts || 0) + 1 });
      try {
        await sendReport({
          reportPath: g.reportPath, issueCount: 0, runTime: Date.now(),
          screenshotPaths: [], groupLabel: group, inlineImages: g.cidList || [],
        });
        markSent(state, group, g.to);
        saveDailyState(state);
        log.stepEnd('retry', 'ok', `Отчёт доставлен [${group}] (попытка ${g.attempts})`);
      } catch (err) {
        markFailed(state, group, { error: err.message });
        saveDailyState(state);
        log.stepEnd('retry', 'fail', `Досылка не удалась [${group}]`, { error: err.message });
      }
    } else {
      needRecovery = true;   // отчёта на диске нет — нужен полный прогон
    }
  }
  if (needRecovery) {
    log.warn('retry', 'Для части групп нет готового отчёта — поднимаю восстановительный daily-прогон');
    spawnDailyRecovery();
  }
}

// ─── Test email mode ──────────────────────────────────────────────────────────
if (isTestEmail) {
  log.info('test', 'Режим тестового email');
  const reportPath = buildReport({
    systemResults: [{
      id: 'test', name: 'Test System',
      cameras: [{ index: 0, online: true, recording: true, audio: false, notes: 'test' }],
      screenshotPath: null, error: null, aiSummary: 'Test run',
    }],
    runMeta: { startTime: Date.now(), durationMs: 0 },
  });
  try {
    await sendReport({ reportPath, issueCount: 0, runTime: Date.now(), screenshotPaths: [] });
    log.info('test', 'Тестовый email отправлен');
  } catch (err) {
    log.error('test', 'Не удалось отправить email', { error: err.message });
  }
  process.exit(0);
}

// ─── Single-instance lock ─────────────────────────────────────────────────────
// Сериализуем прогоны, чтобы daily и light не стартовали одновременно (в 14:00
// МСК их расписания совпадают) и не дрались за файлы/Playwright. daily/manual
// критичны — ждут освобождения и при затяжке забирают лок силой; light
// некритичен — при занятом локе просто пропускает свой тик.
process.on('exit',    releaseLock);
process.on('SIGINT',  () => { releaseLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

if (isLight) {
  const got = await acquireLock('light');
  if (!got) {
    log.warn('lock', 'Другой прогон уже идёт (daily?) — пропускаю light-тик');
    process.exit(0);
  }
} else {
  const got = await acquireLock(runMode, {
    waitMs: 10 * 60 * 1000,
    onWait: (info) => log.info('lock', `Жду освобождения лока`, { holder: info?.mode, pid: info?.pid }),
  });
  if (!got) {
    log.warn('lock', 'Лок не освободился за 10 мин — забираю принудительно');
    forceAcquireLock(runMode);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
const startTime = Date.now();
log.section(`AutoCamera Monitor — запуск [${runMode}]`);
log.info('startup', 'Конфигурация загружена', {
  systems: systemsConfig.length,
  runMode,
  dryRun: isDryRun,
  only: onlyId || 'all',
});

const systems = systemsConfig.filter(sys => {
  if (sys.enabled === false) return false;
  if (onlyId && sys.id !== onlyId) return false;
  return true;
});

if (systems.length === 0) {
  log.warn('startup', 'Нет систем для проверки', { only: onlyId });
  process.exit(0);
}

log.info('startup', `Систем к проверке: ${systems.length}`, {
  ids: systems.map(s => s.id).join(', '),
});

const systemResults = [];

for (let i = 0; i < systems.length; i++) {
  const sys = systems[i];
  log.section(`${sys.name} [${i + 1}/${systems.length}]`);

  // Build credentials from env
  const creds = {
    url:  sys.url  || process.env[sys.urlEnv]  || '',
    user: sys.user || process.env[sys.userEnv] || '',
    pass:            process.env[sys.passEnv]  || '',
  };

  if (!creds.url && !['ipanda-rtsp', 'trassir-sdk', 'beward-smb', 'smb-recordings', 'hikvision-multi', 'rt-portal', 'tplink-tapo'].includes(sys.type)) {
    log.warn(sys.id, 'Пропуск — URL не настроен в .env', { envVar: sys.urlEnv });
    systemResults.push({
      ...sys, cameras: [], screenshotPath: null,
      error: 'URL не настроен', aiSummary: '',
    });
    continue;
  }

  log.debug(sys.id, 'Credentials', {
    url: creds.url,
    user: creds.user,
    passSet: creds.pass ? 'yes' : 'NO',
  });

  // Полностью копируем config-объект системы. Diagnose использует sys.type,
  // sys.host, sys.nvrIp, sys.url и т.п. Чекеры дальше переопределят поля
  // cameras / error / aiSummary.
  const result = {
    ...sys,
    unusedChannels: Array.isArray(sys.unusedChannels) ? sys.unusedChannels : [],
    helpdeskIgnore: Array.isArray(sys.helpdeskIgnore) ? sys.helpdeskIgnore : [],
    displayMode: sys.displayMode || 'table',
    gridColumns: sys.gridColumns || 5,
    cameras: [],
    screenshotPath: null,
    error: null,
    aiSummary: '',
  };

  // ── Hikvision/HiWatch: используем ISAPI ──
  if (sys.type === 'hiwatch' || sys.type === 'hikvision') {
    const baseUrl = creds.url.replace(/\/doc\/page\/login\.asp.*/, '').replace(/\/$/, '');
    const { cameras: isapiCams, error: isapiError } = await fetchHikvisionStatus(
      baseUrl, creds.user, creds.pass, { maxChannelId: sys.maxChannelId }
    );

    if (isapiError) {
      result.error = isapiError;
      result.cameras = Array.from({ length: sys.cameraCount || 1 }, (_, i) => ({
        index: i, online: 'unknown', recording: 'unknown', audio: 'unknown',
        notes: `ISAPI ошибка: ${isapiError}`,
      }));
    } else {
      result.cameras = isapiCams;
      const online = isapiCams.filter(c => c.online === true).length;
      const offline = isapiCams.filter(c => c.online === false).length;
      result.aiSummary = `ISAPI: ${online} online, ${offline} offline из ${isapiCams.length}`;
    }

    // ── extraCameras (камеры другого типа, физически на том же объекте) ──
    // К NVR объекта бывает пришпилена Wi-Fi камера — не часть NVR, но в
    // отчёте рисуется как дополнительная ячейка в общей сетке объекта.
    // Сейчас поддерживается только type:'tplink-tapo' (если появятся другие
    // типы extra-камер — добавим аналогичные ветки).
    if (!isapiError && Array.isArray(sys.extraCameras) && sys.extraCameras.length > 0) {
      const startIdx = result.cameras.length;
      // Назначаем индексы и id, чтобы grid'ы reporter'а не схлопнулись
      const tapoExtras = sys.extraCameras
        .filter(c => c.type === 'tplink-tapo')
        .map((c, i) => ({ ...c, index: startIdx + i, id: startIdx + i + 1 }));

      if (tapoExtras.length > 0) {
        const { cameras: extras } = await checkTplinkTapoSystem({
          id: sys.id,                  // last-good сохраняем рядом с основным
          cameras: tapoExtras,
        });
        // Помечаем тип, чтобы snapshots.js знал, какой grab'ер вызывать.
        for (const e of extras) {
          e._extraType = 'tplink-tapo';
          // Передаём в snapshots.js контекст для RTSP URL
          // (sys-level rtspUserEnv тут нет — берём из самой камеры).
        }
        result.cameras = result.cameras.concat(extras);

        const totalOnline = result.cameras.filter(c => c.online === true).length;
        const total       = result.cameras.length;
        result.aiSummary  = `ISAPI+Tapo: ${totalOnline} online из ${total} (вкл. ${extras.length} extra)`;
      }
    }

    systemResults.push(result);
    continue;
  }

  // ── iPanda (RTSP): проверяем камеры через RTSP DESCRIBE ──
  if (sys.type === 'ipanda-rtsp' && sys.cameras?.length) {
    // RTSP-креды читаем приоритетно через env-переменные (sys.rtspUserEnv /
    // sys.rtspPassEnv), как fallback — буквальные sys.rtspUser / sys.rtspPass.
    // То же самое для NVR-прокси. Сделано чтобы реальные пароли не лежали
    // в config/systems.json (который в git).
    const rtspUser    = (sys.rtspUserEnv    && process.env[sys.rtspUserEnv])    || sys.rtspUser    || 'admin';
    const rtspPass    = (sys.rtspPassEnv    && process.env[sys.rtspPassEnv])    || sys.rtspPass    || '';
    const nvrRtspUser = (sys.nvrRtspUserEnv && process.env[sys.nvrRtspUserEnv]) || sys.nvrRtspUser;
    const nvrRtspPass = (sys.nvrRtspPassEnv && process.env[sys.nvrRtspPassEnv]) || sys.nvrRtspPass;
    const { cameras: rtspCams, error: rtspError } = await checkCamerasByRtsp(
      sys.cameras, rtspUser, rtspPass, sys.id,
      { nvrIp: sys.nvrIp, nvrRtspUser, nvrRtspPass,
        probeVideo: sys.viaNvr || sys.cameras.some(c => c.viaNvr) }
    );

    if (rtspError) {
      result.error = rtspError;
    } else {
      result.cameras = rtspCams;
      const online = rtspCams.filter(c => c.online === true).length;
      const offline = rtspCams.filter(c => c.online === false).length;
      result.aiSummary = `RTSP: ${online} online, ${offline} offline из ${rtspCams.length}`;
    }

    systemResults.push(result);
    continue;
  }

  // ── TRASSIR (SDK HTTP API) ──
  if (sys.type === 'trassir-sdk') {
    const { cameras: trCams, error: trErr } = await checkTrassirSystem({
      id:           sys.id,
      host:         sys.host,
      port:         sys.port || 8080,
      user:         process.env[sys.userEnv] || sys.user,
      pass:         process.env[sys.passEnv] || sys.pass,
      knownOffline: sys.knownOffline || [],
      cameraGuids:  sys.cameraGuids  || {},
    });
    if (trErr) {
      result.error = trErr;
    } else {
      result.cameras = trCams;
      const online  = trCams.filter(c => c.online === true).length;
      const offline = trCams.filter(c => c.online === false).length;
      result.aiSummary = `TRASSIR SDK: ${online} online, ${offline} offline из ${trCams.length}`;
    }
    systemResults.push(result);
    continue;
  }

  // ── SMB-папки с записями (тип smb-recordings) ──
  if (sys.type === 'smb-recordings') {
    const { cameras: recCams, error: recErr } = await checkRecordingsSystem({
      id:           sys.id,
      host:         sys.host,
      shareName:    sys.shareName,
      basePath:     sys.basePath,
      smbUser:      process.env[sys.smbUserEnv] || sys.smbUser,
      smbPass:      process.env[sys.smbPassEnv] || sys.smbPass,
      freshnessMin: sys.freshnessMin || 60,
      channels:     sys.channels || [],
    });
    if (recErr) {
      result.error = recErr;
    } else {
      result.cameras = recCams;
      const online  = recCams.filter(c => c.online === true).length;
      const offline = recCams.filter(c => c.online === false).length;
      result.aiSummary = `Recordings: ${online} ok, ${offline} stale из ${recCams.length}`;
    }
    systemResults.push(result);
    continue;
  }

  // ── Несколько одиночных Hikvision-камер (тип hikvision-multi) ──
  if (sys.type === 'hikvision-multi') {
    const { cameras: hkCams, error: hkErr } = await checkHikvisionMultiSystem({
      id: sys.id,
      cameras: sys.cameras || [],
    });
    if (hkErr) {
      result.error = hkErr;
    } else {
      result.cameras = hkCams;
      const online  = hkCams.filter(c => c.online === true).length;
      const offline = hkCams.filter(c => c.online === false).length;
      result.aiSummary = `ISAPI: ${online} online, ${offline} offline из ${hkCams.length}`;
    }
    systemResults.push(result);
    continue;
  }

  // ── BEWARD Record Center (SMB-шара записей) ──
  if (sys.type === 'beward-smb') {
    const { cameras: bwCams, error: bwErr } = await checkBewardSystem({
      id:           sys.id,
      host:         sys.host,
      shareName:    sys.shareName,
      smbUser:      process.env[sys.smbUserEnv] || sys.smbUser,
      smbPass:      process.env[sys.smbPassEnv] || sys.smbPass,
      freshnessMin: sys.freshnessMin || 60,
      cameras:      sys.cameras || [],
    });
    if (bwErr) {
      result.error = bwErr;
    } else {
      result.cameras = bwCams;
      const online  = bwCams.filter(c => c.online === true).length;
      const offline = bwCams.filter(c => c.online === false).length;
      result.aiSummary = `BEWARD: ${online} online, ${offline} offline из ${bwCams.length}`;
    }
    systemResults.push(result);
    continue;
  }

  // ── Ростелеком (портал RT + откат на ping) ──
  if (sys.type === 'rt-portal') {
    const portalUrl = process.env[sys.portalUrlEnv] || '';
    const rtUser    = process.env[sys.userEnv] || '';
    const rtPass    = process.env[sys.passEnv] || '';
    const { cameras: rtCams, error: rtErr, method } = await checkRostelecomSystem({
      id: sys.id, portalUrl, user: rtUser, pass: rtPass,
      cameras: sys.cameras || [],
      excludeApiNames: sys.excludeApiNames || [],
      portalRetries: sys.portalRetries || 3,
    });
    if (rtErr) result.error = rtErr;
    result.cameras = rtCams;
    const online  = rtCams.filter(c => c.online === true).length;
    const offline = rtCams.filter(c => c.online === false).length;
    const src = method === 'portal' ? 'Портал РТ' : 'Ping';
    result.aiSummary = `${src}: ${online} online, ${offline} offline из ${rtCams.length}`;
    systemResults.push(result);
    continue;
  }

  // ── TP-Link Tapo (Wi-Fi камеры, проверка через TCP-probe HTTPS-демона) ──
  if (sys.type === 'tplink-tapo') {
    const { cameras: tapoCams, error: tapoErr } = await checkTplinkTapoSystem({
      id: sys.id,
      cameras: sys.cameras || [],
    });
    if (tapoErr) {
      result.error = tapoErr;
    } else {
      result.cameras = tapoCams;
      const online  = tapoCams.filter(c => c.online === true).length;
      const offline = tapoCams.filter(c => c.online === false).length;
      result.aiSummary = `Tapo: ${online} online, ${offline} offline из ${tapoCams.length}`;
    }
    systemResults.push(result);
    continue;
  }

  // ── Неизвестный тип системы ──
  log.warn(sys.id, `Неизвестный тип системы: ${sys.type}. Пропускаю.`);
  result.error = `Неизвестный тип проверки: ${sys.type}`;
  systemResults.push(result);
}

// ─── Timeline (light/daily): обновляем журнал событий за день ─────────────────
// Делается ДО snapshots/email/helpdesk, чтобы в любом режиме (включая ручной
// прогон) timeline всегда отражал актуальное состояние.
const timeline = loadTodayTimeline();
const newEvents = diffAndAppend(timeline, systemResults, new Date(startTime));
saveTimeline(timeline);
if (newEvents.length > 0) {
  log.info('timeline', `Зафиксировано событий: ${newEvents.length}`);
  for (const ev of newEvents) {
    const downStr = ev.event === 'online' && ev.downtimeMin != null
      ? ` (простой ${ev.downtimeMin} мин)` : '';
    log.info('timeline', `  [${ev.ts}] ${ev.system} / ${ev.camera}: ${ev.event}${downStr}`);
  }
} else {
  log.info('timeline', 'Новых событий нет — статусы стабильны');
}

// Timeline-файлы НЕ чистим: храним без ограничения срока, чтобы можно было
// сделать «отчёт за период» через menu.ps1 → H за любую дату назад.

// ─── monitor.db (v3): то же состояние — в SQLite для веб-карты и статистики ───
// Пишем ПОСЛЕ timeline и от его же структуры, чтобы БД и файл не разъехались
// в трактовке статусов. Сбой БД не должен ронять прогон: мониторинг и рассылка
// важнее витрины, поэтому ошибка только логируется.
// --only не пишем: выборка частичная, состояние непроверенных камер устарело бы
// молча (та же причина, по которой --only не сохраняет helpdesk-state).
if (!onlyId) {
  try {
    const db = openMonitorDb();
    try {
      recordRun(db, timeline, newEvents, { systems: systemsConfig, runMode, now: new Date(startTime) });
    } finally {
      db.close();
    }
    log.info('monitor-db', 'Состояние записано в state/monitor.db');
  } catch (e) {
    log.warn('monitor-db', `Не удалось записать monitor.db: ${e.message}`);
  }
} else {
  log.info('monitor-db', 'Выборочный прогон (--only) — monitor.db не трогаем');
}

// ─── LIGHT-режим: на этом всё заканчивается ───────────────────────────────────
// Light-прогоны (раз в 15 мин) — только чекеры + timeline + live.html.
// БЕЗ снимков, БЕЗ email, БЕЗ helpdesk — те идут в --daily.
if (isLight) {
  log.section('Light-прогон: обновление live.html');
  const durationMs = Date.now() - startTime;
  const timelineSummary = summarize(timeline, new Date());
  const liveReportPath = path.join(ROOT, 'reports', 'live.html');
  // Light не снимает кадров — берём только из last-good. mode='file' для file://
  const { snapMap: liveSnapMap } = buildSnapMap(systemResults, null, 'file');
  buildReport({
    systemResults,
    runMeta:    { startTime, durationMs, runMode: 'light', timeline, timelineSummary },
    outputPath: liveReportPath,
    liveMode:   true,
    snapMap:    liveSnapMap,
  });
  log.info('report', 'Live-монитор обновлён', { path: liveReportPath });

  // Авто-досылка: если daily не разослал отчёты заказчикам — дотягиваем тут
  // (раз в 15 мин, шаг 30 мин). После live.html, чтобы тормоза SMTP не мешали
  // основной задаче light-прогона.
  try {
    await retryCustomerEmails();
  } catch (err) {
    log.error('retry', 'Сбой авто-досылки', { error: err.message });
  }

  const totalSec = Math.round(durationMs / 1000);
  log.section('Готово (light)');
  log.info('done', 'Light-прогон завершён', {
    duration: `${totalSec}s`,
    systems:  systemResults.length,
    events:   newEvents.length,
    incidents: timelineSummary.length,
  });
  process.exit(0);
}

// ─── Snapshots → Битрикс Диск (v2) ────────────────────────────────────────────
// Захватываем кадры с камер, грузим в Битрикс Диск, в cam.snapshotUrl
// сохраняем публичную ссылку. Без BITRIX_WEBHOOK_URL — фича пропускается.
//
// В daily-режиме пробуем и offline-камеры (TRASSIR/Hikvision/RT часто
// отдают placeholder «no signal»). В manual-режиме поведение оставлено как было
// (только online), чтобы ручной запуск был быстрее.
// trim: значение из одних пробелов должно считаться НЕзаданным, иначе запрос
// уходит по мусорному адресу и падает на разборе URL.
const bxWebhook   = (process.env.BITRIX_WEBHOOK_URL   || '').trim();
const bxRoot      = process.env.BITRIX_ROOT_FOLDER_ID || '';
const bxRetention = parseInt(process.env.SNAPSHOT_RETENTION_DAYS || '30', 10);
const includeOfflineSnaps = isDaily;       // только в daily — offline тоже

// Результат контроля качества (v3, пункт 2). Объявлен ДО блока снимков:
// используется ниже в runMeta, то есть за пределами блока.
let qualityResult = { analyzed: 0, failed: 0, findings: [] };

// Съём кадров больше не завязан на настройки Битрикса. Раньше условие было
// общим, и без webhook'а кадры вообще не снимались — а контролю качества они
// нужны всегда, независимо от того, куда потом заливается архив.
if (!isNoSnapshots) {
  // runId — служебный идентификатор папки локального временного хранилища.
  // На Битриксе структура: AutoCamera/<Группа>/<Объект>/<YYYY-MM-DD>/<кам>.jpg
  // Повторный прогон в тот же день — перезаписывает файл в текущей папке-дате.
  const dt = new Date(startTime);
  const ymd = dt.toISOString().slice(0, 10);                 // 2026-05-13
  const hm  = String(dt.getHours()).padStart(2, '0')
            + String(dt.getMinutes()).padStart(2, '0');      // 1100
  const runId = `${ymd}-${hm}`;

  // "Объект (TRASSIR)" → "Объект" (имя папки объекта в Битриксе)
  const objectName = (n) => (n || '').replace(/\s*\([^)]*\)\s*$/, '').trim();

  // "00-201.jpg" → "201.jpg" (убираем числовой index-префикс)
  const cleanFileName = (filename) => filename.replace(/^\d+-/, '');

  log.stepStart('snapshots', 'Захват кадров с камер',
    { includeOffline: includeOfflineSnaps });
  let captured = [];
  try {
    captured = await captureAll(systemResults, runId, {
      concurrency:    5,
      includeOffline: includeOfflineSnaps,
    });
  } catch (err) {
    log.stepEnd('snapshots', 'fail', 'captureAll упал', { error: err.message });
  }
  const okCount  = captured.filter(c => c.localPath).length;
  const errCount = captured.length - okCount;
  log.stepEnd('snapshots', 'ok', `Кадры сняты: ${okCount} ok, ${errCount} с ошибкой`);

  // Заливка в Битрикс Диск с ограниченным параллелизмом. Webhook у Битрикса
  // плохо переваривает большие тяжёлые base64-uploads подряд (TRASSIR HD-кадры
  // ~700КБ × 1.33 base64 ≈ 1МБ в теле запроса). Concurrency=3 даёт ускорение
  // ~3× и при этом остаётся в пределах rate-limit'а (50 req/sec на портал).
  if (bxWebhook && bxRoot) {
  log.stepStart('bitrix-disk', 'Загрузка кадров в Битрикс Диск',
    { rootId: bxRoot, concurrency: 3 });

  const uploadOne = async (item) => {
    if (!item.localPath) return false;
    const sys = systemResults.find(s => s.id === item.sysId);
    if (!sys) return false;

    const group = sys.group || 'Прочее';
    const obj   = objectName(sys.name);
    const file  = cleanFileName(path.basename(item.localPath));
    const subPath = [group, obj, ymd];

    const url = await uploadFreshSnapshot(item.localPath, subPath, file, {
      onError: (err, stage) => log.warn('bitrix-disk',
        `${stage} ${group}/${obj}/${file}: ${err.message}`),
    });
    if (url) {
      const cam = sys.cameras?.find(c => c.index === item.camIndex);
      if (cam) cam.snapshotUrl = url;
      return true;
    }
    return false;
  };

  let uploaded = 0, uploadErrors = 0;
  let cursor = 0;
  const workers = Array.from({ length: 3 }, async () => {
    while (cursor < captured.length) {
      const idx  = cursor++;
      const item = captured[idx];
      try {
        const ok = await uploadOne(item);
        if (ok) uploaded++; else uploadErrors++;
      } catch (err) {
        log.warn('bitrix-disk', `неожиданная ошибка: ${err.message}`);
        uploadErrors++;
      }
    }
  });
  await Promise.all(workers);

  log.stepEnd('bitrix-disk', uploadErrors === 0 ? 'ok' : 'warn',
    `Загружено: ${uploaded} ok, ${uploadErrors} с ошибкой`);
  } else {
    log.info('bitrix-disk', 'Битрикс не настроен — кадры сняты, но в архив не заливаются');
  }

  // ── Обновляем last-good кэш ──────────────────────────────────────────────
  // Для каждой камеры, у которой свежий кадр получен И камера была online —
  // копируем локальный файл в screenshots/last-good/<sys>/<cam>.jpg.
  // Эти картинки потом используются и в обычных отчётах (как миниатюры в
  // гриде/блоке «Не работают»), и в live.html.
  let lastGoodUpdated = 0;
  for (const item of captured) {
    if (!item.localPath) continue;
    const sys = systemResults.find(s => s.id === item.sysId);
    if (!sys) continue;
    const cam = sys.cameras?.find(c => c.index === item.camIndex);
    // Обновляем кэш только если камера была online на этом прогоне —
    // иначе писали бы «placeholder no signal» в кэш и забивали бы им реальную картинку.
    if (cam?.online !== true) continue;
    if (lastGood.update(item.sysId, item.camIndex, item.camName, item.localPath)) {
      lastGoodUpdated++;
    }
  }
  log.info('last-good', `Кэш обновлён: ${lastGoodUpdated} картинок`);

  // ── Контроль качества изображения (v3, пункт 2 ТЗ) ─────────────────────────
  // Строго ДО cleanupRun: разбираем свежие кадры прогона, потом папка удаляется.
  // Камера может числиться исправной и не давать пригодной картинки — обычная
  // проверка связи этого не видит. Считаем локально, без внешних сервисов.
  // Сбой разбора прогон не роняет: письма важнее метрик.
  if (!onlyId) {
    try {
      const t0 = Date.now();
      qualityResult = await checkQuality(captured, systemResults);
      log.info('quality', `Разобрано кадров: ${qualityResult.analyzed}`, {
        сНеисправностями: qualityResult.findings.length,
        неПрочитано:      qualityResult.failed,
        заСекунд:         Math.round((Date.now() - t0) / 1000),
      });
      for (const f of qualityResult.findings) {
        log.warn('quality', `  ${f.system} / ${f.camera}: ${f.defectsText} (держится ${f.streak} прогонов)`);
      }
    } catch (err) {
      log.warn('quality', `Контроль качества не отработал: ${err.message}`);
    }
  }

  // Локальные screenshots/<runId>/ — обычная очистка сразу после заливки.
  cleanupRun(runId);

  // Retention-чистка старых YYYY-MM-DD папок в Битриксе
  // Чистка архива — только если Битрикс вообще настроен: без webhook'а туда
  // нечего чистить, а запрос ушёл бы в никуда.
  if (bxWebhook && bxRoot && bxRetention > 0) {
    try {
      const { deleted, kept } = await cleanupOlderThan(bxRoot, bxRetention);
      if (deleted > 0) log.info('bitrix-disk',
        `Retention: удалено ${deleted} старых папок (>${bxRetention}д), оставлено ${kept}`);
    } catch (err) {
      log.warn('bitrix-disk', 'Retention-чистка не сработала', { error: err.message });
    }
  }
} else {
  // Снимки теперь пропускаются ТОЛЬКО по явному флагу: настройки Битрикса на
  // сам захват больше не влияют, они управляют лишь заливкой в архив.
  log.info('snapshots', 'Снимки отключены (--no-snapshots) — контроль качества изображения тоже пропущен');
}

// ─── Build & send report per group ────────────────────────────────────────────
log.section('Формирование отчётов');
const durationMs = Date.now() - startTime;

// История событий за день (для daily/manual прогона). В light до этой ветки
// не дойдём — там уже был return выше.
const timelineSummary = summarize(timeline, new Date());

// «Требуют внимания» (v3, пункт 1 ТЗ): камеры, которые сейчас зелёные, но за
// последнюю неделю пропадали и восстанавливались сами. Считается по monitor.db,
// который уже обновлён этим прогоном выше. Сломанные прямо сейчас исключаем —
// они в блоке «Не работают камеры», дублировать их незачем.
// Сбой статистики прогон не роняет: письмо важнее блока в письме.
let attention = [];
if (!onlyId) {
  try {
    // Считаем ПО ГРУППАМ, а не общим списком: потолок ATTENTION_LIMIT иначе
    // был бы общим на обе, и в плохой день камеры одного заказчика вытеснили
    // бы из письма камеры другого.
    for (const g of REPORT_GROUPS) {
      attention.push(...collectAttention({ group: g, brokenKeys: currentlyBrokenKeys(g) }));
    }
    log.info('attention', `Камер требуют внимания: ${attention.length}`);
    for (const a of attention.slice(0, 10)) {
      log.info('attention', `  ${a.system} / ${a.camera}: простой ${a.downtime_min} мин (${a.share_pct}%), падений ${a.falls}`);
    }
  } catch (e) {
    log.warn('attention', `Не удалось собрать статистику: ${e.message}`);
  }
}

const runMeta = {
  startTime, durationMs, runMode,
  timeline,
  timelineSummary,
  attention,
  quality: qualityResult.findings,
};

// Готовим snapMap для браузерных отчётов (full + live.html) — относительные
// пути file://. Для email-отчётов CID-вложения собираются ОТДЕЛЬНО по каждой
// группе в цикле ниже: cidList — это одновременно список inline-вложений
// письма, поэтому общий список на обе группы означал бы, что заказчик получает
// в письме чужие скриншоты (камеры соседней группы).
const { snapMap: fileSnapMap } = buildSnapMap(systemResults, null, 'file');
log.info('snap-map', 'Картинок для отчёта (file)', { file: fileSnapMap.size });

// Общий отчёт для браузера (все группы вместе)
const fullReportPath = buildReport({ systemResults, runMeta, snapMap: fileSnapMap });
log.info('report', 'Полный HTML-отчёт сохранён', { path: fullReportPath });

// Live-монитор (v2): тот же отчёт, но всегда по фиксированному пути с
// meta-refresh. Открываешь reports/live.html в браузере — обновляется сам.
const liveReportPath = path.join(ROOT, 'reports', 'live.html');
buildReport({
  systemResults,
  runMeta,
  outputPath: liveReportPath,
  liveMode:   true,
  snapMap:    fileSnapMap,
});
log.info('report', 'Live-монитор обновлён', { path: liveReportPath });

// Отдельные отчёты по группам (для email)
let totalIssues = 0;
const groupReports = [];
for (const group of REPORT_GROUPS) {
  const groupSystems = systemResults.filter(s => (s.group || '') === group);
  if (groupSystems.length === 0) continue;

  const groupIssues = groupSystems.reduce((sum, sys) => {
    if (sys.error) return sum + 1;
    return sum + sys.cameras.filter(c => c.online === false || c.recording === false).length;
  }, 0);
  totalIssues += groupIssues;

  // CID-снимки строго по системам ЭТОЙ группы. И src="cid:..." в HTML, и
  // inline-вложения письма (cidList) берутся из одного набора — поэтому
  // ограничиваем его камерами группы, иначе в письмо одной группы попали бы
  // вложения камер другой и наоборот (заказчик видит чужие скриншоты).
  const { snapMap: groupSnapMap, cidList: groupCidList } =
    buildSnapMap(groupSystems, null, 'cid');

  // forCustomer: это письмо уходит заказчику, поэтому инженерные секции
  // («Требуют внимания», «Качество изображения») в него не попадают —
  // они для нашей службы поддержки и живут в helpdesk-заявках и во
  // внутренних видах (полный отчёт, live.html).
  const reportPath = buildReport({
    systemResults, runMeta, group, snapMap: groupSnapMap, forCustomer: true,
  });
  log.info('report', `HTML-отчёт сохранён [${group}]`, {
    path: reportPath, issues: groupIssues, cidImages: groupCidList.length,
  });
  groupReports.push({ group, reportPath, issues: groupIssues, cidList: groupCidList });
}

if (totalIssues > 0) {
  log.warn('report', `Обнаружено проблем: ${totalIssues}`);
} else {
  log.info('report', 'Проблем не обнаружено');
}


// ─── Send email per group ─────────────────────────────────────────────────────
let emailFailures = 0;
if (!isDryRun) {
  // «Тумблер» рассылки за сегодня (state/daily-state.json): каждая группа
  // помечается sent/failed. Если процесс умрёт или SMTP не примет письмо —
  // light-прогон потом дотянет рассылку по этому состоянию. При --only выборка
  // частичная — состояние не ведём (иначе пометили бы группу как отправленную
  // по неполному отчёту).
  const dailyState = onlyId ? null : ensureToday(groupReports.map(g => g.group));
  if (dailyState) saveDailyState(dailyState);

  for (const { group, reportPath, issues, cidList } of groupReports) {
    // Уже отправлено сегодня (например, на восстановительном прогоне) — не дублируем.
    if (dailyState && isGroupSent(dailyState, group)) {
      log.info('email', `Email [${group}] уже отправлен сегодня — пропускаю`);
      continue;
    }
    // Адресаты группы описаны в .env (REPORT_GROUPS) — имён групп в коде нет.
    const to = groupRecipients(group) || process.env.REPORT_TO || '(не задан)';

    // Фиксируем «исходящее» ДО попытки: если процесс умрёт прямо сейчас,
    // light увидит pending + путь к отчёту и дошлёт письмо сам.
    if (dailyState) {
      recordOutbox(dailyState, group, { to, reportPath, cidList });
      saveDailyState(dailyState);
    }

    log.stepStart('email', `Отправка email [${group}]`, { to });
    try {
      await sendReport({
        reportPath, issueCount: issues, runTime: startTime,
        screenshotPaths: [], groupLabel: group,
        inlineImages: cidList,    // ← CID-attachments только этой группы
      });
      if (dailyState) { markSent(dailyState, group, to); saveDailyState(dailyState); }
      log.stepEnd('email', 'ok', `Email отправлен [${group}]`);
    } catch (err) {
      // Не валим процесс — отчёт уже сохранён локально, остальные письма
      // должны продолжать отправляться, а недосланные дотянет авто-досылка.
      if (dailyState) { markFailed(dailyState, group, { to, error: err.message, reportPath, cidList }); saveDailyState(dailyState); }
      log.stepEnd('email', 'fail', `Email не отправлен [${group}] (отчёт сохранён, будет авто-досылка)`, {
        error: err.message, reportPath,
      });
      emailFailures++;
    }
  }

  // ── Helpdesk: дедупликация через state.js ──────────────────────────────
  // 1. Текущее множество сломанных камер
  // 2. Сравниваем со state, получаем diff
  // 3. Сохраняем новый state ТОЛЬКО при полной проверке (без --only).
  //    Если --only задан, выборка systemResults частичная: непроверенные
  //    системы выглядели бы как «восстановленные» и при следующем полном
  //    прогоне снова попали бы в newlyBroken → ложный helpdesk.
  // 4. Отправляем ОДНО письмо, если есть событие: новая поломка, напоминание
  //    о давней, новая нестабильная камера или новый дефект картинки.
  const brokenCams = collectBrokenCameras(systemResults);
  const state = loadState();
  const diff  = diffAndUpdate(state, brokenCams);
  if (onlyId) {
    log.warn('helpdesk', `--only ${onlyId}: state не сохраняем (выборка частичная), helpdesk-письмо не отправляем`);
  }

  // Сбой объекта целиком (v3, пункт 1 ТЗ). Считаем по текущему прогону: helpdesk
  // должен реагировать на то, что видно сейчас. Если у объекта легли почти все
  // камеры — в письме будет одна строка про объект вместо перечисления шестнадцати.
  const outages = detectOutagesFromRun(systemResults, isUnusedChannel);
  if (outages.downSystems.size > 0) {
    log.warn('helpdesk', `Объектов недоступно целиком: ${outages.downSystems.size}`,
      { systems: [...outages.downSystems].join(', ') });
  }

  // Напоминания о том, что лежит давно (см. state.pickReminders). Без них
  // объект, упавший вчера, сегодня из письма исчезал совсем — так 17.08.2026
  // по группе не ушло ничего, хотя объект лежал целиком.
  const reminders = onlyId ? [] : pickReminders(diff.stillBroken, {
    downSystems:  outages.downSystems,
    renotifyDays: Number(process.env.HELPDESK_RENOTIFY_DAYS) || 3,
  });
  if (reminders.length > 0) {
    log.info('helpdesk', `Напоминаний по давним поломкам: ${reminders.length}`, {
      объектыЦеликом: reminders.filter(r => r._reminder === 'outage').length,
      камеры:         reminders.filter(r => r._reminder === 'renotify').length,
    });
  }

  log.info('helpdesk', 'Дедупликация заявок', {
    current: brokenCams.length,
    newlyBroken: diff.newlyBroken.length,
    recovered:   diff.recovered.length,
    stillBroken: diff.stillBroken.length,
    напоминания: reminders.length,
    stateSaved:  !onlyId,
  });

  // ── Что ещё стоит подсветить в том же письме (v3, пункты 1 и 2 ТЗ) ─────────
  // Отдельных рассылок «нестабильные камеры» и «плохое изображение» нет:
  // 05.08.2026 пользователь свёл всё в одно утреннее письмо — «зачем нам
  // плодить какие-то бесконечные рассылки». Память (attention-state /
  // quality-state) осталась, но теперь она решает не «слать ли письмо»,
  // а «писать ли про эту камеру ещё раз»: камера держится в статистике
  // неделями, и без памяти один и тот же абзац повторялся бы каждое утро.
  let attentionRows = [];
  let qualityRows = [];

  if (!onlyId && attention.length > 0) {
    // Группу берём из конфига: статистика считается по БД и групп не знает,
    // а письма в helpdesk раздельные по проектам.
    const groupBySys = new Map(systemsConfig.map(s => [s.id, s.group || 'Прочее']));
    const rows = attention.map(a => ({ ...a, group: groupBySys.get(a.system_id) || 'Прочее' }));

    const attState = loadAttentionState();
    const attDiff = diffAttention(attState, rows);
    saveAttentionState(attState);
    attentionRows = attDiff.toNotify;

    log.info('attention', 'Нестабильные камеры для письма', {
      всего:     rows.length,
      вПисьмо:   attDiff.toNotify.length,
      подавлено: attDiff.skipped,
      забыто:    attDiff.forgotten,
    });
  }

  if (!onlyId && qualityResult.findings.length > 0) {
    const qState = loadQualityState();
    const qDiff = diffQuality(qState, qualityResult.findings);
    saveQualityState(qState);
    qualityRows = qDiff.toNotify;

    log.info('quality', 'Дефекты изображения для письма', {
      всего:      qualityResult.findings.length,
      вПисьмо:    qDiff.toNotify.length,
      подавлено:  qDiff.skipped,
      исправлено: qDiff.cleared,
    });
  }

  // ── Одно письмо в helpdesk на группу ───────────────────────────────────────
  // Уходит, если есть о чём сообщить: новая поломка, напоминание о давней,
  // новая нестабильная камера или новый дефект картинки. Восстановления письма
  // не вызывают — оператору не нужны сообщения «всё хорошо». В письмо при этом
  // попадают ВСЕ актуальные поломки (newlyBroken + stillBroken), чтобы была
  // видна полная картина.
  //
  // При --only письмо не шлём: выборка частичная, diff.newlyBroken
  // может содержать ложные срабатывания.
  const hasEvent = diff.newlyBroken.length > 0 || reminders.length > 0
    || attentionRows.length > 0 || qualityRows.length > 0;

  // Группы, которые реально получат письмо. Считаем здесь, а не только внутри
  // sendHelpdeskReport, потому что по этому же списку помечаем камеры как
  // «упомянутые сегодня» — иначе напоминание сработало бы повторно.
  const eventGroups = new Set();
  for (const c of [...diff.newlyBroken, ...reminders]) eventGroups.add(c.group || 'Прочее');
  for (const a of [...attentionRows, ...qualityRows]) eventGroups.add(a.group || 'Прочее');

  let helpdeskSent = false;
  if (hasEvent && !onlyId) {
    const totalBroken = diff.newlyBroken.length + diff.stillBroken.length;
    log.stepStart('helpdesk', 'Отправка утреннего письма', {
      to: process.env.HELPDESK_TO,
      группы:          [...eventGroups].join(', '),
      newlyBroken:     diff.newlyBroken.length,
      stillBroken:     diff.stillBroken.length,
      напоминания:     reminders.length,
      требуютВнимания: attentionRows.length,
      дефектыКадра:    qualityRows.length,
    });
    try {
      await sendHelpdeskReport({
        newlyBroken: diff.newlyBroken,
        stillBroken: diff.stillBroken,
        reminders,
        runMeta,
        outages,
        attention: attentionRows,
        quality:   qualityRows,
      });
      helpdeskSent = true;
      log.stepEnd('helpdesk', 'ok',
        `Письмо отправлено (сломано ${totalBroken}, внимание ${attentionRows.length}, картинка ${qualityRows.length})`);
    } catch (err) {
      log.stepEnd('helpdesk', 'fail', 'Письмо в helpdesk не отправлено', { error: err.message });
      emailFailures++;
    }
  } else if (diff.recovered.length > 0 && diff.stillBroken.length === 0) {
    log.info('helpdesk',
      `${diff.recovered.length} камер восстановлено, новых событий нет — helpdesk не дёргаем`);
  } else if (diff.stillBroken.length > 0) {
    log.info('helpdesk',
      `Изменений нет — helpdesk не дёргаем (${diff.stillBroken.length} камер всё ещё сломаны, `
      + `напоминание через ${process.env.HELPDESK_RENOTIFY_DAYS || 3} дн. после последнего письма)`);
  } else {
    log.info('helpdesk', 'Событий нет — письмо в helpdesk не нужно');
  }

  // State сохраняем в конце, уже с отметками «о чём написали сегодня»: срок
  // напоминания отсчитывается от последнего УПОМИНАНИЯ камеры в письме, а не
  // от момента поломки. При неудачной отправке отметку не ставим — тогда
  // напоминание повторится завтра, а не через три дня.
  if (!onlyId) {
    if (helpdeskSent) {
      markNotified(state, [...diff.newlyBroken, ...diff.stillBroken]
        .filter(c => eventGroups.has(c.group || 'Прочее')));
    }
    saveState(state);
  }
} else {
  // DRY-RUN: state не трогаем. Раньше тут был saveState(), но при выборочном
  // прогоне (--only one-system) выборка systemResults неполная: камеры из
  // непроверенных систем выглядели бы как «восстановленные» и при следующем
  // настоящем прогоне снова попали бы в newlyBroken → ложное helpdesk-письмо.
  // Считаем diff только для лога, но НЕ сохраняем.
  const brokenCams = collectBrokenCameras(systemResults);
  const state = loadState();
  const diff  = diffAndUpdate(state, brokenCams);
  log.info('email', 'DRY-RUN: email не отправлен, state не сохранён', {
    groups: groupReports.length,
    issues: totalIssues,
    newlyBroken: diff.newlyBroken.length,
    recovered:   diff.recovered.length,
    stillBroken: diff.stillBroken.length,
    only:        onlyId || 'all',
  });
}

const issueCount = totalIssues;

// ─── Cleanup ──────────────────────────────────────────────────────────────────
cleanOldReports(14);
log.cleanOldLogs(14);

// ─── Итог ─────────────────────────────────────────────────────────────────────
const totalSec = Math.round((Date.now() - startTime) / 1000);
log.section(`Готово (${runMode})`);
log.info('done', `Запуск завершён [${runMode}]`, {
  duration: `${totalSec}s`,
  systems: systemResults.length,
  issues: issueCount,
  emailFailures,
  reports: groupReports.map(g => path.basename(g.reportPath)).join(', '),
});

// Если были неудачные отправки — exit 1, чтобы планировщик отметил прогон
// как проблемный. Но отчёты уже сохранены локально в reports/.
process.exit(emailFailures > 0 ? 1 : 0);
