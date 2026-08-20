/**
 * reporter.js — Builds HTML report and sends it via email.
 */

import fs from 'fs';
import path from 'path';
import dns from 'dns';
import nodemailer from 'nodemailer';
import { randomUUID } from 'crypto';
import { describeDefects } from './image-quality.js';

// На этой VM системный DNS-сервер — 127.0.0.1 (битый локальный резолвер),
// из-за чего dns.resolve4 падает с queryA ETIMEOUT при отправке через nodemailer.
// Принудительно используем публичные DNS.
try { dns.setServers(['1.1.1.1', '8.8.8.8']); } catch {}

/**
 * Извлекает домен из SMTP-пользователя (user@example.com → example.com).
 * Используется для генерации Message-ID.
 */
function senderDomain() {
  const user = process.env.SMTP_USER || '';
  const at = user.indexOf('@');
  return at >= 0 ? user.slice(at + 1) : 'autocamera.local';
}

/**
 * Убирает HTML-теги, оставляя текстовое содержимое — для text/plain версии.
 */
function htmlToPlainText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    // Списки писем в helpdesk: в текстовой версии отступ рисуем сами, иначе
    // пункты слипаются в одну строку.
    .replace(/<li[^>]*>/gi, '   • ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/?ul[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<th[^>]*>/gi, '\t')
    .replace(/<td[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ROOT = path.resolve('.');
const REPORTS_DIR = path.join(ROOT, 'reports');

/**
 * Группы объектов и адресаты их писем — из `.env`, а не из кода: имена групп
 * это данные заказчика, в репозитории их быть не должно.
 *
 * Формат `REPORT_GROUPS`: `<Группа>:<СУФФИКС>` через запятую, например
 * `Первая:PERVAYA,Вторая:VTORAYA`. Адресаты берутся из `REPORT_TO_<СУФФИКС>`.
 * Суффикс можно не указывать (`REPORT_GROUPS=Первая,Вторая`) — тогда для
 * группы используется общий `REPORT_TO`.
 */
function parseGroupEnv(raw) {
  const map = new Map();
  for (const part of String(raw || '').split(',')) {
    const [name, suffix] = part.split(':').map((s) => (s || '').trim());
    if (name) map.set(name, suffix || '');
  }
  return map;
}

const GROUP_ENV = parseGroupEnv(process.env.REPORT_GROUPS);

/** Группы, по которым формируются отдельные письма (порядок — как в `.env`). */
export const REPORT_GROUPS = [...GROUP_ENV.keys()];

/** Адресаты письма по группе; пусто — вызывающий откатится на `REPORT_TO`. */
export function groupRecipients(group) {
  const suffix = GROUP_ENV.get(group);
  return (suffix && process.env[`REPORT_TO_${suffix}`]) || '';
}

/**
 * Проверяет, помечен ли канал «не используется» (серый в отчёте).
 * Логика:
 *   • TRASSIR — по displayName из sys.knownOffline
 *   • Остальные системы — по номеру канала в sys.unusedChannels (1-based)
 *
 * Экспортируется, чтобы единая логика использовалась и в reporter.js,
 * и в timeline.js (иначе серые камеры попадают в журнал событий как offline).
 */
export function isUnusedChannel(sys, cam) {
  if (!sys || !cam) return false;
  if (sys.type === 'trassir-sdk') {
    const known = sys.knownOffline || [];
    if (known.length === 0) return false;
    return known.includes(cam.name);
  }
  const list = sys.unusedChannels || [];
  if (list.length === 0) return false;
  const ch = cam.id != null ? cam.id : (cam.index ?? 0) + 1;
  return list.includes(ch);
}

/**
 * Builds and saves an HTML report.
 *
 * @param {object} params
 * @param {Array}  params.systemResults  - per-system results
 * @param {object} params.runMeta        - { startTime, durationMs, runMode,
 *                                          timeline?, timelineSummary? }
 * @param {string} [params.group]        - имя группы объектов — для email
 * @param {string} [params.outputPath]   - переопределить путь сохранения
 *                                          (используется live-монитором)
 * @param {boolean}[params.liveMode]     - добавить meta-refresh + плашку
 * @param {Map}    [params.snapMap]      - Map<"sysId|camIndex", { src, fresh, ageMs }>:
 *                                          src — это либо "cid:..." (для email),
 *                                          либо относительный путь к JPG (для live.html
 *                                          / browser-отчёта).
 * @param {boolean}[params.forCustomer]  - отчёт уходит ЗАКАЗЧИКУ. Тогда из него
 *                                          выпадают инженерные секции («Требуют
 *                                          внимания», «Качество изображения»):
 *                                          это диагностика для нашей службы
 *                                          поддержки, заказчику она не адресована.
 *                                          Внутренние виды (полный отчёт, live.html)
 *                                          строятся с forCustomer=false и видят всё.
 * @returns {string} absolute path to saved HTML file
 */
export function buildReport({ systemResults, runMeta, group, outputPath, liveMode = false, snapMap = null, forCustomer = false }) {
  const snap = (sysId, camIndex) => snapMap?.get(`${sysId}|${camIndex}`) || null;
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // Если задана конкретная группа — фильтруем по ней.
  // Иначе берём все группы из REPORT_GROUPS, или всё (для тестов и для
  // случая, когда группы в .env не описаны вовсе).
  let filtered;
  if (group) {
    filtered = systemResults.filter(s => (s.group || '') === group);
  } else if (REPORT_GROUPS.length) {
    filtered = systemResults.filter(s => REPORT_GROUPS.includes(s.group || ''));
    if (filtered.length === 0) filtered = systemResults;
  } else {
    filtered = systemResults;
  }

  const ts = new Date(runMeta.startTime)
    .toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
  const groupSlug = group ? `-${group.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '_')}` : '';
  const reportPath = outputPath || path.join(REPORTS_DIR, `report-${ts}${groupSlug}.html`);

  const startDate = new Date(runMeta.startTime);
  const dd = String(startDate.getDate()).padStart(2, '0');
  const mm = String(startDate.getMonth() + 1).padStart(2, '0');
  const yyyy = startDate.getFullYear();
  const dateStr = `${dd}.${mm}.${yyyy}`;

  // "Объект (TRASSIR)" → "Объект"
  const shortSysName = (n) => (n || '').replace(/\s*\([^)]*\)\s*$/, '').trim();

  // "CH10" → "10", "Camera 01" → "1", "IPCamera 02" → "IP2"
  const shortCamLabel = (cam) => {
    const n = cam.name || `${(cam.index ?? 0) + 1}`;
    let m = n.match(/^CH0*(\d+)$/i);          if (m) return m[1];
    m = n.match(/^Camera\s+0*(\d+)$/i);       if (m) return m[1];
    m = n.match(/^IPCamera\s+0*(\d+)$/i);     if (m) return `IP${m[1]}`;
    return n;
  };

  // Локальный alias на экспортируемый isUnused — оставлен, чтобы не править
  // остальную часть buildReport.
  const isUnused = isUnusedChannel;

  // ── Секция «Не работают камеры» — карточки с миниатюрами last-good ─────────
  // По каждой упавшей камере: фото (или плейсхолдер если last-good нет),
  // имя объекта мелко и имя камеры покрупнее. По 4 карточки в ряд.
  const errorRows = filtered
    .filter(sys => sys.error)
    .map(sys => `<tr><td colspan="4" style="padding:4px 6px;background:#fff5f5;border:1px solid #fed7d7;border-radius:3px;margin:4px 0;font-size:12px;color:#c53030;font-family:Arial,sans-serif;">
        <strong>${shortSysName(sys.name)}:</strong> ошибка проверки — ${sys.error}
      </td></tr>`).join('');

  const offlineCardList = [];
  for (const sys of filtered) {
    if (sys.error) continue;
    for (const cam of sys.cameras) {
      if (cam.online === false && !isUnused(sys, cam)) {
        offlineCardList.push({ sys, cam });
      }
    }
  }

  function renderOfflineCard({ sys, cam }) {
    const sn  = snap(sys.id, cam.index);
    // Фотка квадратом — 130×130 на 4 колонки в ширину 700px (~160 на колонку,
    // 130×130 + 16px padding/border = аккуратно укладывается).
    const sq = 130;
    const imgHtml = sn
      ? `<img src="${sn.src}" alt="" width="${sq}" height="${sq}" style="display:block;border:0;width:100%;height:${sq}px;object-fit:cover;background:#1a202c;">`
      : `<div style="height:${sq}px;background:#1a202c;color:#a0aec0;font-size:11px;display:block;text-align:center;line-height:${sq}px;font-family:Arial,sans-serif;">нет снимка</div>`;
    const camLabel = cam.name || shortCamLabel(cam);
    return `<td valign="top" width="25%" style="padding:3px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #fed7d7;border-radius:4px;overflow:hidden;background:#fff5f5;font-family:Arial,sans-serif;">
        <tr><td style="padding:0;">${imgHtml}</td></tr>
        <tr><td style="padding:4px 6px;">
          <div style="font-size:10px;color:#718096;line-height:1.2;">${shortSysName(sys.name)}</div>
          <div style="font-size:13px;color:#c53030;font-weight:700;line-height:1.3;">${camLabel}</div>
        </td></tr>
      </table>
    </td>`;
  }

  let offlineHtml;
  if (offlineCardList.length === 0 && !errorRows) {
    offlineHtml = '<div class="all-good">&#10004; Все камеры работают штатно.</div>';
  } else {
    const cardsPerRow = 4;
    const rows = [];
    for (let i = 0; i < offlineCardList.length; i += cardsPerRow) {
      const chunk = offlineCardList.slice(i, i + cardsPerRow);
      const tds = chunk.map(renderOfflineCard);
      while (tds.length < cardsPerRow) tds.push('<td width="25%" style="padding:3px;"></td>');
      rows.push(`<tr>${tds.join('')}</tr>`);
    }
    offlineHtml = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;table-layout:fixed;margin-top:4px;">
      ${errorRows}
      ${rows.join('')}
    </table>`;
  }

  // ── Секция «Запись» — одна общая строка ────────────────────────────────────
  // Не пишет = recording === false при online === true (без неиспользуемых)
  const notRecording = [];
  for (const sys of filtered) {
    if (sys.error) continue;
    for (const c of sys.cameras) {
      if (isUnused(sys, c)) continue;
      if (c.recording === false && c.online === true) {
        notRecording.push(`${shortSysName(sys.name)} — ${shortCamLabel(c)}`);
      }
    }
  }
  const recordingHtml = notRecording.length === 0
    ? '<div class="rec-row">Запись ведётся на всех рабочих камерах.</div>'
    : `<div class="rec-row err">Нет записи: ${notRecording.join(', ')}.</div>`;

  // ── Сетки по системам ───────────────────────────────────────────────────────
  function gridLabel(name) {
    if (!name) return '?';
    const m = name.match(/^Camera\s+0*(\d+)$/i);
    return m ? `CH${m[1]}` : name;
  }

  // Полный отчёт (браузер) — без группы; email — с группой
  const isBrowserReport = !group;

  let lastGroup = null;
  const systemSections = filtered.map(sys => {
    const usedCams = sys.cameras.filter(c => !isUnused(sys, c));
    const onlineCount = usedCams.filter(c => c.online === true).length;
    const activeTotal = usedCams.filter(c => c.online !== null).length;
    const cols = sys.gridColumns || 5;

    const groupName = sys.group || '';
    let groupHeader = '';
    if (groupName && groupName !== lastGroup) {
      groupHeader = `<div style="background:#1a365d;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:0.5px;padding:4px 8px;margin:8px 0 4px;border-radius:3px;font-family:Arial,sans-serif;">${groupName.toUpperCase()}</div>`;
      lastGroup = groupName;
    }

    const errorHtml = sys.error
      ? `<p style="color:#c53030;font-size:12px;margin:4px 0;font-family:Arial,sans-serif;">&#9888; ${sys.error}</p>`
      : '';

    const badgeBg = onlineCount === activeTotal ? '#c6f6d5' : '#fed7d7';
    const badgeFg = onlineCount === activeTotal ? '#276749' : '#c53030';

    // Email-friendly: настоящая HTML-таблица вместо CSS grid (Gmail режет display:grid).
    //
    // Рендер тайла зависит от типа системы:
    //   • SMB-системы (smb-recordings, beward-smb) — записи на диске, не камеры.
    //     Миниатюры не имеют смысла, рендерим v1-стиль: один <td bgcolor>label</td>.
    //   • Unused-канал — просто серый квадрат без надписи.
    //   • Остальные — миниатюра (last-good) сверху + цветной бейдж с label снизу.
    const isSmbSys  = sys.type === 'smb-recordings' || sys.type === 'beward-smb';
    const cellWidth = `${Math.floor(100 / cols)}%`;
    // Высота тайла одинакова для ВСЕХ систем (кроме SMB) — чтобы письмо
    // выглядело единообразно. 100px подобрано по самой широкой сетке (cols=5),
    // там получается ≈ квадратный тайл. На системах с другим cols высота
    // остаётся 100, а ширина ячейки меняется по cellWidth%.
    const tileHeight = 100;
    const totalTileH = tileHeight + 22;

    const renderCell = (cam) => {
      const isU = isUnused(sys, cam);

      const noRec = cam.online === true && cam.recording === false;
      const bg = isU                  ? '#a0aec0'
               : cam.online === false ? '#e53e3e'
               : noRec                ? '#dd6b20'
               : cam.online === true  ? '#2f855a'
               :                        '#a0aec0';
      const label = gridLabel(cam.name)
                  + (!isU && noRec ? ' <span style="font-size:8px;vertical-align:top;">⚠</span>' : '');

      // Снимок для тайла: свой last-good либо «взятый взаймы» у камеры другой
      // системы (cam.snapshotFrom). Так у систем smb-recordings — записи без
      // собственных кадров — в тайлах показываются кадры камер соседней системы.
      const sn = isU ? null : snap(sys.id, cam.index);

      // SMB-системы без миниатюры (например, каналы записи, которым снимок не
      // сопоставлен) — v1-стиль: тайл с label по центру, без миниатюры.
      if (isSmbSys && !sn) {
        return `<td width="${cellWidth}" align="center" valign="middle" bgcolor="${bg}" style="height:${totalTileH}px;color:#ffffff;font-weight:700;font-size:12px;border:1px solid #ffffff;line-height:1.2;padding:4px;">${label}</td>`;
      }

      // Все остальные тайлы (и SMB-каналы с заимствованным снимком) — единая
      // структура: верхний блок 100px + бейдж снизу.
      //   • Unused → верхний блок просто серый без надписи + серый бейдж снизу
      //   • Без last-good → тёмный плейсхолдер «нет снимка» + цветной бейдж
      //   • С last-good → миниатюра + цветной бейдж
      let topBlock;
      if (isU) {
        topBlock = `<div style="height:${tileHeight}px;background:#a0aec0;"></div>`;
      } else {
        topBlock = sn
          ? `<img src="${sn.src}" alt="" width="100%" height="${tileHeight}" style="display:block;border:0;width:100%;height:${tileHeight}px;object-fit:cover;background:#1a202c;">`
          : `<div style="height:${tileHeight}px;background:#1a202c;color:#a0aec0;font-size:10px;text-align:center;line-height:${tileHeight}px;font-family:Arial,sans-serif;">нет снимка</div>`;
      }

      return `<td width="${cellWidth}" valign="top" style="padding:1px;border:1px solid #ffffff;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
          <tr><td style="padding:0;">${topBlock}</td></tr>
          <tr><td align="center" bgcolor="${bg}" style="padding:3px 2px;color:#ffffff;font-weight:700;font-size:11px;line-height:1.1;border-top:2px solid #ffffff;">${label}</td></tr>
        </table>
      </td>`;
    };

    const rows = [];
    for (let i = 0; i < sys.cameras.length; i += cols) {
      const chunk = sys.cameras.slice(i, i + cols);
      const tds = chunk.map(renderCell);
      while (tds.length < cols) tds.push(`<td width="${cellWidth}" style="border:1px solid #ffffff;"></td>`);
      rows.push(`<tr>${tds.join('')}</tr>`);
    }
    const gridHtml = sys.cameras.length > 0
      ? `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:#ffffff;table-layout:fixed;">${rows.join('')}</table>`
      : '';

    // ── Подробная таблица камер (только для браузерного отчёта) ──
    let detailHtml = '';
    if (isBrowserReport) {
      const problemCams = sys.cameras.filter(c => !isUnused(sys, c) && (c.online === false || c.recording === false || c.online === null));
      const infoCams = sys.cameras.filter(c => !isUnused(sys, c) && c.notes && c.online === true);

      if (problemCams.length > 0 || sys.error) {
        const problemRows = problemCams.map(cam => {
          const status = cam.online === false ? '<span style="color:#e53e3e;font-weight:700;">OFFLINE</span>'
                       : cam.online === null  ? '<span style="color:#a0aec0;">Н/Д</span>'
                       : '<span style="color:#2f855a;">online</span>';
          const rec = cam.recording === false ? '<span style="color:#e53e3e;">нет</span>'
                    : cam.recording === true  ? '<span style="color:#2f855a;">да</span>'
                    : '<span style="color:#a0aec0;">—</span>';
          const reason = cam.notes || 'причина неизвестна';
          return `<tr style="border-bottom:1px solid #e2e8f0;">
            <td style="padding:3px 6px;font-size:11px;vertical-align:top;">${cam.name || gridLabel(cam.name)}</td>
            <td style="padding:3px 6px;font-size:11px;text-align:center;vertical-align:top;">${status}</td>
            <td style="padding:3px 6px;font-size:11px;text-align:center;vertical-align:top;">${rec}</td>
            <td style="padding:3px 6px;font-size:11px;color:#4a5568;vertical-align:top;">${reason}</td>
          </tr>`;
        }).join('');

        detailHtml = `
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:2px;font-family:Arial,sans-serif;">
          <tr style="background:#edf2f7;">
            <th style="padding:3px 6px;font-size:10px;text-align:left;font-weight:600;color:#4a5568;">Камера</th>
            <th style="padding:3px 6px;font-size:10px;text-align:center;font-weight:600;color:#4a5568;">Статус</th>
            <th style="padding:3px 6px;font-size:10px;text-align:center;font-weight:600;color:#4a5568;">Запись</th>
            <th style="padding:3px 6px;font-size:10px;text-align:left;font-weight:600;color:#4a5568;">Причина / заметки</th>
          </tr>
          ${problemRows}
        </table>`;
      }

      // Краткая сводка по работающим камерам с заметками (запись, возраст и т.п.)
      if (infoCams.length > 0 && infoCams.some(c => c.recording === true || c.recordingAge)) {
        const infoRows = infoCams.filter(c => c.notes).map(cam => {
          const rec = cam.recording === true ? '<span style="color:#2f855a;">да</span>' : '<span style="color:#a0aec0;">—</span>';
          return `<tr style="border-bottom:1px solid #f7fafc;">
            <td style="padding:2px 6px;font-size:10px;">${cam.name || gridLabel(cam.name)}</td>
            <td style="padding:2px 6px;font-size:10px;text-align:center;">${rec}</td>
            <td style="padding:2px 6px;font-size:10px;color:#718096;">${cam.notes}</td>
          </tr>`;
        }).join('');
        if (infoRows) {
          detailHtml += `
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:2px;font-family:Arial,sans-serif;opacity:0.85;">
            <tr style="background:#f7fafc;">
              <th style="padding:2px 6px;font-size:9px;text-align:left;color:#a0aec0;">Камера</th>
              <th style="padding:2px 6px;font-size:9px;text-align:center;color:#a0aec0;">Зап.</th>
              <th style="padding:2px 6px;font-size:9px;text-align:left;color:#a0aec0;">Инфо</th>
            </tr>
            ${infoRows}
          </table>`;
        }
      }
    }

    // Метод проверки (только браузер)
    const methodLabel = isBrowserReport && sys.aiSummary
      ? `<span style="font-size:9px;color:#a0bcc8;margin-left:6px;font-weight:400;">${sys.aiSummary}</span>`
      : '';

    // Ссылка на папку объекта в Битриксе была убрана — теперь снимки видны
    // прямо в отчёте как миниатюры в гриде.

    return `${groupHeader}
    <div style="margin-bottom:8px;border:1px solid #e2e8f0;border-radius:3px;overflow:hidden;font-family:Arial,sans-serif;">
      <div style="background:#2c5282;color:#ffffff;font-size:12px;font-weight:700;padding:5px 10px;">
        ${shortSysName(sys.name)}
        <span style="font-size:10px;padding:1px 7px;border-radius:9px;font-weight:600;margin-left:6px;background:${badgeBg};color:${badgeFg};">${onlineCount}/${activeTotal} online</span>
        ${methodLabel}
      </div>
      ${errorHtml}
      ${gridHtml}
      ${detailHtml}
    </div>`;
  }).join('\n');

  // ── Секция «Требуют внимания» (v3, пункт 1 ТЗ) ─────────────────────────────
  // Камеры, которые в момент проверки ЗЕЛЁНЫЕ и потому в «Не работают» не
  // попадают, но за последнюю неделю накопили простой или падали раз за разом.
  // Именно этот класс неисправностей раньше не был виден вообще: камера
  // отваливается на десять минут по пять раз в день и каждый раз возвращается
  // сама — к моменту отчёта всё зелено.
  //
  // Данные считает src/stats.js и кладёт в runMeta.attention (как timelineSummary).
  //
  // Секция ИНЖЕНЕРНАЯ: в письмо заказчику не идёт (forCustomer). Заказчику нужен
  // ответ на вопрос «что не работает сейчас», а накопленная за неделю статистика
  // падений — рабочий материал нашей службы поддержки; в helpdesk она уходит
  // разделом единого утреннего письма (buildHelpdeskTextHtml), а не отдельной
  // рассылкой (отдельные письма убраны 05.08.2026 — см. CHANGELOG).
  let attentionHtml = '';
  if (!forCustomer) {
    const all = Array.isArray(runMeta.attention) ? runMeta.attention : [];
    const rows = group ? all.filter(r => filtered.some(s => s.id === r.system_id)) : all;

    if (rows.length > 0) {
      const periodDays = rows[0].days || 7;
      const rowsHtml = rows.map(r => {
        const hrs = r.downtime_min >= 60
          ? `${Math.floor(r.downtime_min / 60)} ч ${r.downtime_min % 60 ? (r.downtime_min % 60) + ' мин' : ''}`.trim()
          : `${r.downtime_min} мин`;
        return `<tr style="border-bottom:1px solid #e2e8f0;">
          <td style="padding:4px 8px;font-size:12px;color:#2c5282;font-weight:600;vertical-align:top;white-space:nowrap;">${shortSysName(r.system)}</td>
          <td style="padding:4px 8px;font-size:12px;color:#1a202c;vertical-align:top;">${r.camera}</td>
          <td style="padding:4px 8px;font-size:12px;color:#975a16;text-align:center;vertical-align:top;white-space:nowrap;">${hrs}</td>
          <td style="padding:4px 8px;font-size:12px;color:#4a5568;text-align:center;vertical-align:top;">${r.share_pct}%</td>
          <td style="padding:4px 8px;font-size:12px;color:#975a16;text-align:center;vertical-align:top;">${r.falls}</td>
        </tr>`;
      }).join('');

      attentionHtml = `
<div class="section-title">Требуют внимания</div>
<div style="font-size:12px;color:#4a5568;margin:4px 0 6px;font-family:Arial,sans-serif;">
  Камеры работают в момент проверки, но за последние ${periodDays} дн. пропадали
  и восстанавливались сами. Такие неисправности не видны в ежедневном статусе.
</div>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-family:Arial,sans-serif;margin-bottom:12px;border-left:3px solid #d69e2e;">
  <tr style="background:#fffaf0;">
    <th style="padding:4px 8px;font-size:11px;text-align:left;font-weight:600;color:#4a5568;">Объект</th>
    <th style="padding:4px 8px;font-size:11px;text-align:left;font-weight:600;color:#4a5568;">Камера</th>
    <th style="padding:4px 8px;font-size:11px;text-align:center;font-weight:600;color:#4a5568;">Не работала</th>
    <th style="padding:4px 8px;font-size:11px;text-align:center;font-weight:600;color:#4a5568;">Доля времени</th>
    <th style="padding:4px 8px;font-size:11px;text-align:center;font-weight:600;color:#4a5568;">Падений</th>
  </tr>
  ${rowsHtml}
</table>`;
    }
  }

  // ── Секция «Качество изображения» (v3, пункт 2 ТЗ) ─────────────────────────
  // Камера может числиться исправной и не давать пригодной картинки: чёрный
  // кадр, расфокус, зависшее изображение. Обычная проверка связи это пропускает,
  // потому что поток идёт. Сюда попадают только УСТОЙЧИВЫЕ дефекты — те, что
  // держатся несколько прогонов подряд.
  //
  // Данные считает src/quality-check.js и кладёт в runMeta.quality.
  //
  // Секция ИНЖЕНЕРНАЯ — как и «Требуют внимания», в письмо заказчику не идёт.
  let qualityHtml = '';
  if (!forCustomer) {
    const all = Array.isArray(runMeta.quality) ? runMeta.quality : [];
    const rows = group ? all.filter(r => filtered.some(s => s.id === r.system_id)) : all;

    if (rows.length > 0) {
      const rowsHtml = rows.map(r => `<tr style="border-bottom:1px solid #e2e8f0;">
          <td style="padding:4px 8px;font-size:12px;color:#2c5282;font-weight:600;vertical-align:top;white-space:nowrap;">${shortSysName(r.system)}</td>
          <td style="padding:4px 8px;font-size:12px;color:#1a202c;vertical-align:top;">${r.camera}</td>
          <td style="padding:4px 8px;font-size:12px;color:#805ad5;vertical-align:top;">${r.defectsText}</td>
          <td style="padding:4px 8px;font-size:12px;color:#4a5568;text-align:center;vertical-align:top;white-space:nowrap;">${r.streak} пров.</td>
        </tr>`).join('');

      qualityHtml = `
<div class="section-title">Качество изображения</div>
<div style="font-size:12px;color:#4a5568;margin:4px 0 6px;font-family:Arial,sans-serif;">
  Камеры на связи и передают видео, но изображение непригодно. Дефект
  подтверждён несколькими проверками подряд — разовые помехи сюда не попадают.
</div>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-family:Arial,sans-serif;margin-bottom:12px;border-left:3px solid #805ad5;">
  <tr style="background:#faf5ff;">
    <th style="padding:4px 8px;font-size:11px;text-align:left;font-weight:600;color:#4a5568;">Объект</th>
    <th style="padding:4px 8px;font-size:11px;text-align:left;font-weight:600;color:#4a5568;">Камера</th>
    <th style="padding:4px 8px;font-size:11px;text-align:left;font-weight:600;color:#4a5568;">Что не так</th>
    <th style="padding:4px 8px;font-size:11px;text-align:center;font-weight:600;color:#4a5568;">Держится</th>
  </tr>
  ${rowsHtml}
</table>`;
    }
  }

  // ── Секция «История за день» — рисуется в самом низу отчёта.
  // Колонки: Объект | Камера | Падений | Не работала с HH:MM до HH:MM
  // Если интервалов несколько — соединяем через "; "
  let historyHtml = '';
  {
    const summary = Array.isArray(runMeta.timelineSummary) ? runMeta.timelineSummary : [];
    const filteredSummary = group
      ? summary.filter(r => filtered.some(s => s.id === r.systemId))
      : summary;

    if (filteredSummary.length > 0) {
      const rowsHtml = filteredSummary.map(r => {
        // Собираем периоды: "08:15 — 09:02; 11:40 — сейчас"
        const periodText = (r.intervals || []).map(iv => {
          if (iv.ongoing) return `${iv.from} — сейчас`;
          return `${iv.from} — ${iv.to}`;
        }).join('; ') || '—';

        const stateColor = r.currentlyDown ? '#c53030' : '#4a5568';
        return `<tr style="border-bottom:1px solid #e2e8f0;">
          <td style="padding:4px 8px;font-size:12px;color:#2c5282;font-weight:600;vertical-align:top;white-space:nowrap;">${shortSysName(r.system)}</td>
          <td style="padding:4px 8px;font-size:12px;color:#1a202c;vertical-align:top;">${r.camera}</td>
          <td style="padding:4px 8px;font-size:12px;color:#4a5568;text-align:center;vertical-align:top;">${r.incidents}</td>
          <td style="padding:4px 8px;font-size:12px;color:${stateColor};vertical-align:top;">${periodText}</td>
        </tr>`;
      }).join('');

      historyHtml = `
<div class="section-title">История за день</div>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-family:Arial,sans-serif;margin-bottom:12px;">
  <tr style="background:#edf2f7;">
    <th style="padding:4px 8px;font-size:11px;text-align:left;font-weight:600;color:#4a5568;">Объект</th>
    <th style="padding:4px 8px;font-size:11px;text-align:left;font-weight:600;color:#4a5568;">Камера</th>
    <th style="padding:4px 8px;font-size:11px;text-align:center;font-weight:600;color:#4a5568;">Падений</th>
    <th style="padding:4px 8px;font-size:11px;text-align:left;font-weight:600;color:#4a5568;">Не работала</th>
  </tr>
  ${rowsHtml}
</table>`;
    }
  }

  // Live-режим: meta-refresh каждые 30с, плашка над содержимым,
  // другой title (видно в табе браузера).
  const liveTimeStr = startDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const liveMetaTag = liveMode
    ? '<meta http-equiv="refresh" content="30">'
    : '';
  const liveBannerHtml = liveMode
    ? `<div style="background:#1a365d;color:#ffffff;padding:8px 14px;border-radius:4px;font-size:13px;margin-bottom:12px;font-family:Arial,sans-serif;">
         &#10227; <strong>Live-монитор</strong> — обновлено в ${liveTimeStr}, страница перезагрузится автоматически каждые 30 сек
       </div>`
    : '';
  const titleStr = liveMode
    ? `AutoCamera Live (${liveTimeStr})`
    : `Отчёт по видеонаблюдению ${dateStr}`;

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
${liveMetaTag}
<title>${titleStr}</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; background:#ffffff; color:#1a202c; margin:0; padding:18px; max-width:720px; line-height:1.5; }
  .greeting { font-size:1rem; margin-bottom:6px; }
  .lead     { font-size:1.05rem; margin:6px 0 18px; font-weight:600; color:#1a365d; }
  .section-title { font-size:1rem; font-weight:700; color:#1a365d; margin:18px 0 6px; border-bottom:2px solid #1a365d; padding-bottom:3px; }
  .off-row  { padding:4px 0; font-size:0.95rem; }
  .off-sys  { font-weight:700; color:#2c5282; }
  .off-err  { color:#c53030; }
  .all-good { color:#276749; font-size:0.95rem; padding:4px 0; }
  .rec-row  { padding:4px 0; font-size:0.95rem; }
  .rec-row.err { color:#c53030; }
  .rec-sys  { font-weight:700; color:#2c5282; }

  /* Сетки систем */
  .systems-wrap { font-family: system-ui, Arial, sans-serif; margin-top:18px; }
  .system-block { margin-bottom:10px; border:1px solid #e2e8f0; border-radius:4px; overflow:hidden; }
  .group-header { background:#1a365d; color:#ffffff; font-size:0.85rem; font-weight:700; letter-spacing:0.6px; padding:7px 12px; border-radius:4px; margin:14px 0 6px; }
  .system-head  { background:#2c5282; color:#ffffff; font-size:0.82rem; font-weight:700; padding:6px 10px; }
  .badge { font-size:0.68rem; padding:2px 8px; border-radius:10px; font-weight:600; margin-left:6px; vertical-align:middle; }
  .badge-ok   { background:#c6f6d5; color:#276749; }
  .badge-warn { background:#fed7d7; color:#c53030; }
  .cam-grid { display:grid; gap:4px; padding:6px; background:#ffffff; }
  .cam-cell { padding:9px 4px; text-align:center; border-radius:3px; font-weight:700; font-size:0.78rem; line-height:1.1; color:#ffffff; }
  .cam-on  { background:#2f855a; }
  .cam-off { background:#e53e3e; }
  .cam-unk { background:#a0aec0; font-weight:500; }

  .signature { margin-top:28px; padding-top:14px; border-top:1px solid #e2e8f0; font-size:0.95rem; line-height:1.5; }
  .signature .name { font-weight:700; }
  .signature .company { font-style:italic; color:#4a5568; }
</style>
</head>
<body>

${liveBannerHtml}
${liveMode ? '' : '<div class="greeting">Добрый день!</div>'}
<div class="lead">${liveMode ? 'AutoCamera Live — статус видеонаблюдения' : `Отчёт по видеонаблюдению на ${dateStr}`}</div>
${isBrowserReport ? `<div style="font-size:0.8rem;color:#718096;margin-bottom:12px;">Проверка: ${new Date(runMeta.startTime).toLocaleTimeString('ru-RU')} | Длительность: ${Math.round(runMeta.durationMs / 1000)} сек | Систем: ${filtered.length}</div>` : ''}

<div class="section-title">Не работают камеры</div>
${offlineHtml}

<div class="section-title">Запись</div>
${recordingHtml}

${qualityHtml}
${attentionHtml}

<div class="systems-wrap" style="max-width:${isBrowserReport ? '720' : '520'}px;">
${systemSections}
</div>

${historyHtml}

<div class="section-title" style="margin-top:18px;">Обозначения в сетках камер</div>
<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Arial,sans-serif;margin-top:6px;">
  <tr>
    <td style="padding:3px 8px 3px 0;vertical-align:middle;">
      <span style="display:inline-block;width:14px;height:14px;background:#2f855a;border:1px solid #ffffff;vertical-align:middle;"></span>
    </td>
    <td style="padding:3px 16px 3px 4px;font-size:12px;color:#2d3748;vertical-align:middle;">зелёный — камера онлайн, передаёт видео</td>
  </tr>
  <tr>
    <td style="padding:3px 8px 3px 0;vertical-align:middle;">
      <span style="display:inline-block;width:14px;height:14px;background:#e53e3e;border:1px solid #ffffff;vertical-align:middle;"></span>
    </td>
    <td style="padding:3px 16px 3px 4px;font-size:12px;color:#2d3748;vertical-align:middle;">красный — камера офлайн, не передаёт видео или нет сигнала</td>
  </tr>
  <tr>
    <td style="padding:3px 8px 3px 0;vertical-align:middle;">
      <span style="display:inline-block;width:14px;height:14px;background:#dd6b20;border:1px solid #ffffff;vertical-align:middle;text-align:center;color:#ffffff;font-weight:700;font-size:9px;line-height:14px;">⚠</span>
    </td>
    <td style="padding:3px 16px 3px 4px;font-size:12px;color:#2d3748;vertical-align:middle;">оранжевый со знаком ⚠ — картинка есть, но записи нет (или запись устарела)</td>
  </tr>
  <tr>
    <td style="padding:3px 8px 3px 0;vertical-align:middle;">
      <span style="display:inline-block;width:14px;height:14px;background:#a0aec0;border:1px solid #ffffff;vertical-align:middle;"></span>
    </td>
    <td style="padding:3px 16px 3px 4px;font-size:12px;color:#2d3748;vertical-align:middle;">серый — канал не используется или статус неизвестен</td>
  </tr>
  <tr>
    <td style="padding:3px 8px 3px 0;vertical-align:middle;">
      <span style="display:inline-block;padding:1px 7px;background:#c6f6d5;color:#276749;border-radius:9px;font-size:10px;font-weight:600;font-family:Arial,sans-serif;">N/N online</span>
    </td>
    <td style="padding:3px 16px 3px 4px;font-size:12px;color:#2d3748;vertical-align:middle;">зелёный бейдж — все камеры системы работают</td>
  </tr>
  <tr>
    <td style="padding:3px 8px 3px 0;vertical-align:middle;">
      <span style="display:inline-block;padding:1px 7px;background:#fed7d7;color:#c53030;border-radius:9px;font-size:10px;font-weight:600;font-family:Arial,sans-serif;">N/M online</span>
    </td>
    <td style="padding:3px 16px 3px 4px;font-size:12px;color:#2d3748;vertical-align:middle;">красный бейдж — часть камер в системе не работает</td>
  </tr>
</table>

<div class="signature">
С уважением,<br>
Служба технической поддержки${process.env.REPORT_SIGN_NAME ? `<br><br><span class="name">${process.env.REPORT_SIGN_NAME}</span>` : ''}${process.env.REPORT_SIGN_COMPANY ? `<br><span class="company">${process.env.REPORT_SIGN_COMPANY}</span>` : ''}${process.env.REPORT_SIGN_PHONE ? `<br>${process.env.REPORT_SIGN_PHONE}` : ''}
</div>


</body>
</html>`;

  fs.writeFileSync(reportPath, html, 'utf8');
  return reportPath;
}

/**
 * Sends the HTML report via SMTP.
 *
 * @param {object} params
 * @param {string} params.reportPath
 * @param {number} params.issueCount
 * @param {number} params.runTime
 * @param {Array}  params.screenshotPaths - list of screenshot file paths for attachments
 */
export async function sendReport({ reportPath, issueCount, runTime, screenshotPaths = [], groupLabel = '', inlineImages = [] }) {
  const html = fs.readFileSync(reportPath, 'utf8');
  const d = new Date(runTime);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const labelPart = groupLabel ? ` (${groupLabel})` : '';
  const subject = `Отчет по видеонаблюдению${labelPart} — ${dd}.${mm}.${yyyy}`;

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || '587');
  const smtpSecure = process.env.SMTP_SECURE === 'true';

  // На этой VM системный DNS-резолвер сломан (127.0.0.1 не отвечает на queryA),
  // поэтому nodemailer/c-ares не может зарезолвить хост сам.
  // Резолвим через dns.lookup (использует ОС-резолвер, работает) и передаём
  // готовый IP, а имя хоста — в tls.servername для корректного SNI.
  const lookup = (host) => new Promise((resolve, reject) => {
    dns.lookup(host, { family: 4 }, (err, addr) => err ? reject(err) : resolve(addr));
  });
  const smtpIp = await lookup(smtpHost);

  const transporter = nodemailer.createTransport({
    host: smtpIp,
    port: smtpPort,
    secure: smtpSecure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { servername: smtpHost },
  });

  const attachments = screenshotPaths
    .filter(p => p && fs.existsSync(p))
    .map(p => ({ filename: path.basename(p), path: p }));

  // Inline-вложения для CID-картинок (миниатюр камер в отчёте). Файлы
  // лежат локально (screenshots/last-good/...) — путь не уйдёт получателю,
  // nodemailer прикрепит их как multipart/related с теми же cid'ами,
  // которые указаны в src="cid:..." внутри HTML.
  for (const img of inlineImages) {
    if (!img || !img.path || !img.cid) continue;
    if (!fs.existsSync(img.path)) continue;
    attachments.push({
      filename: path.basename(img.path),
      path:     img.path,
      cid:      img.cid,
      contentDisposition: 'inline',
    });
  }

  // Группа-специфичные адресаты (REPORT_GROUPS в .env). Если для группы
  // не заданы — используем общий REPORT_TO как фолбэк.
  const rawRecipients = groupRecipients(groupLabel) || process.env.REPORT_TO || '';
  const recipients = rawRecipients.split(',').map(e => e.trim()).filter(Boolean);

  if (recipients.length === 0) {
    throw new Error(`Не задан адрес получателя для группы "${groupLabel || 'default'}"`);
  }

  const fromAddr = process.env.SMTP_USER;
  const fromDomain = (fromAddr.split('@')[1] || senderDomain()).trim();

  // Строим письмо для конкретного одного получателя.
  const buildMail = (to) => ({
    from: `"AutoCamera Monitor" <${fromAddr}>`,
    // envelope.from — то, что уходит в SMTP MAIL FROM. Должно совпадать с From
    // и быть в том же домене, иначе Яндекс режет как SPAM/Spoof.
    envelope: { from: fromAddr, to: [to] },
    replyTo: fromAddr,
    to,
    subject,
    text: htmlToPlainText(html),
    html,
    attachments,
    // Message-ID в том же домене, что и From — требование Яндекса.
    messageId: `<autocamera-${randomUUID()}@${fromDomain}>`,
    date: new Date(),
    headers: {
      'X-Mailer': 'AutoCamera Monitor/1.0',
      'Auto-Submitted': 'auto-generated',
      'Precedence': 'bulk',
    },
  });

  const sendOneWithRetry = async (to) => {
    const maxAttempts = 2;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await transporter.sendMail(buildMail(to));
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 60_000));
      }
    }
    throw lastErr;
  };

  // КРИТИЧНО: отправляем каждому получателю ОТДЕЛЬНОЕ письмо.
  // Яндекс часто режет массовые рассылки (несколько To) как SPAM 554 5.7.1,
  // даже если все адреса валидные. Проверено 2026-04-23 — одиночные уходят.
  const failures = [];
  for (const to of recipients) {
    try {
      await sendOneWithRetry(to);
    } catch (err) {
      failures.push({ to, error: err.message });
    }
  }
  if (failures.length > 0) {
    const summary = failures.map(f => `${f.to}: ${f.error}`).join('; ');
    throw new Error(summary);
  }
}

/**
 * Собирает список сломанных камер по всем системам (для helpdesk-письма).
 * Исключает камеры из helpdeskIgnore и неиспользуемые каналы.
 *
 * @param {Array} systemResults — результаты проверки всех систем
 * @returns {Array} [{ systemId, system, group, camera, status, notes }]
 *   systemId — стабильный id системы (для ключа в state.js)
 */
export function collectBrokenCameras(systemResults) {
  const broken = [];

  for (const sys of systemResults) {
    const ignoreList = sys.helpdeskIgnore || [];

    const group = sys.group || 'Прочее';

    // Ошибка всей системы — добавляем как одну запись
    if (sys.error) {
      broken.push({
        systemId: sys.id,
        group,
        system: sys.name,
        camera: '(вся система)',
        status: 'ошибка проверки',
        notes: sys.error,
      });
      continue;
    }

    for (const cam of sys.cameras) {
      // Пропускаем неиспользуемые каналы (серые в отчёте) — TRASSIR knownOffline
      // + остальные системы по unusedChannels. Логика общая с reporter/buildReport
      // и timeline/diffAndAppend.
      if (isUnusedChannel(sys, cam)) continue;
      const ch = cam.id != null ? cam.id : (cam.index ?? 0) + 1;

      // Пропускаем камеры из helpdeskIgnore (по имени)
      const camLabel = cam.name || `${ch}`;
      if (ignoreList.some(pattern => camLabel.includes(pattern))) continue;

      // Собираем сломанные: offline или нет записи
      if (cam.online === false) {
        broken.push({
          systemId: sys.id,
          group,
          system: sys.name,
          camera: camLabel,
          status: 'OFFLINE',
          notes: cam.notes || '',
        });
      } else if (cam.recording === false && cam.online === true) {
        broken.push({
          systemId: sys.id,
          group,
          system: sys.name,
          camera: camLabel,
          status: 'нет записи',
          notes: cam.notes || '',
        });
      }
    }
  }

  return broken;
}

/**
 * Короткая метка камеры для helpdesk-текста.
 *   "CH15"        → "15"
 *   "Camera 02"   → "2"
 *   "IPCamera 03" → "IP3"
 *   "217"         → "217" (TRASSIR — оставляем как есть)
 *   "Северная-2"  → "Северная-2"  (имя без номера канала — оставляем как есть)
 */
function helpdeskCamLabel(name) {
  if (!name) return '?';
  let m = name.match(/^CH0*(\d+)$/i);          if (m) return m[1];
  m = name.match(/^Camera\s+0*(\d+)$/i);       if (m) return m[1];
  m = name.match(/^IPCamera\s+0*(\d+)$/i);     if (m) return `IP${m[1]}`;
  return name;
}

/**
 * Убирает суффикс типа " (iPanda)" / " (TRASSIR)" из имени системы.
 */
function helpdeskSysName(name) {
  return (name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** Код дефекта «камеру развернули» — он не про качество картинки. */
const ANGLE_DEFECT = 'angle-changed';

/**
 * Список с отступом для письма в helpdesk.
 * <ul>/<li> без атрибутов и CSS: отступ рисует сам почтовый клиент, а если
 * разметку срежут — останутся обычные строки, а не слипшийся абзац.
 */
function bulletList(items) {
  return `<ul>\n${items.map((s) => `  <li>${s}</li>`).join('\n')}\n</ul>`;
}

/**
 * «(не работает с 16.08)» — подпись для повторных строк письма.
 *
 * Ставится, только когда в блоке нет ни одной НОВОЙ поломки: значит оператор
 * видит эту строку не в первый раз, и дата отвечает на вопрос «почему опять».
 * У новых поломок подписи нет — там дата и так сегодняшняя.
 */
function sinceSuffix(cams) {
  if (!Array.isArray(cams) || cams.length === 0) return '';
  const stamps = cams.map((c) => c._brokenSince).filter(Boolean);
  if (stamps.length !== cams.length) return '';   // есть новые — не подписываем
  const oldest = stamps.map((s) => Date.parse(s)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  if (!oldest) return '';
  const d = new Date(oldest);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return ` (не работает с ${dd}.${mm})`;
}

/**
 * Форматирует timestamp как "24.04.2026 08:00" (МСК-локаль).
 */
function fmtTs(ts) {
  if (!ts) return '?';
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const tt = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${dd}.${mm}.${yyyy} ${tt}`;
}

/**
 * Генерирует HTML-письмо для helpdesk: простой текст, сгруппированный
 * по объекту. Никаких таблиц / inline-CSS, потому что 1С при приёме
 * писем не рендерит сложную вёрстку и всё «слипается в кучу».
 *
 * Пример вывода (для группы объектов):
 *
 *   Здравствуйте!
 *
 *   Автоматическая проверка 25.05.2026 10:00 выявила 6 проблем
 *   по проекту «<группа>»:
 *
 *   Объект 1 — не работают камеры: 11, 12, 15
 *   Объект 2 — не работают камеры: 2, 3, 5
 *
 *   Письмо сформировано автоматически системой AutoCamera Monitor.
 *   Для подробностей смотрите полный отчёт по видеонаблюдению.
 *
 * @param {Array}  brokenList — текущие сломанные камеры (newly + still)
 * @param {object} runMeta    — { startTime }
 * @param {string} groupLabel — имя группы объектов или "" (все)
 */
/**
 * Сколько проблем показать в теме письма.
 *
 * Упавший целиком объект — это одна проблема, а не шестнадцать сломанных камер:
 * тема письма должна совпадать с тем, что оператор увидит в теле.
 */
export function countHelpdeskIssues(brokenList, outages = null) {
  const downSystems = outages?.downSystems instanceof Set ? outages.downSystems : new Set();
  if (!downSystems.size) return brokenList.length;

  const seenDown = new Set();
  let count = 0;
  for (const c of brokenList) {
    const id = c.systemId;
    if (downSystems.has(id)) {
      if (!seenDown.has(id)) { seenDown.add(id); count++; }
      continue;
    }
    count++;
  }
  return count;
}

/**
 * SMTP-транспорт для helpdesk-писем.
 *
 * Резолвим хост в IP и подключаемся по нему, а имя передаём в tls.servername:
 * так соединение не зависит от того, отдаст ли DNS вдруг IPv6-адрес, к которому
 * на этой ВМ маршрута нет. Проверка сертификата при этом остаётся честной.
 */
async function createHelpdeskTransport() {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || '587');
  const smtpSecure = process.env.SMTP_SECURE === 'true';

  const smtpIp = await new Promise((resolve, reject) => {
    dns.lookup(smtpHost, { family: 4 }, (err, addr) => (err ? reject(err) : resolve(addr)));
  });

  return nodemailer.createTransport({
    host: smtpIp,
    port: smtpPort,
    secure: smtpSecure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { servername: smtpHost },
  });
}

/** «74 раза», но «131 раз» и «9 раз» — иначе письмо читается как машинный лог. */
function plural(n, one, few, many) {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d100 >= 11 && d100 <= 14) return many;
  if (d10 === 1) return one;
  if (d10 >= 2 && d10 <= 4) return few;
  return many;
}

/** «525» → «8 ч 45 мин». Для helpdesk минуты сотнями не читаются. */
function fmtDurMin(min) {
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

/**
 * Утреннее письмо в helpdesk — ОДНО на группу, всё в нём.
 *
 * Три вида событий в одном письме, а не в трёх рассылках (решение
 * пользователя от 05.08.2026: «зачем нам плодить какие-то бесконечные
 * рассылки»):
 *   1. не работают камеры / нет записи / объект лёг целиком;
 *   2. камеры на связи, но связь регулярно пропадает («обратить внимание»);
 *   3. камеры на связи, но картинка непригодна (помехи, темно, расфокус).
 *
 * Формат намеренно примитивный — <p>/<br>/<strong>, без таблиц и CSS: 1С
 * слепляет сложную вёрстку в кучу.
 *
 * @param {Array}  brokenList — сломанные камеры группы
 * @param {object} runMeta    — { startTime, ... }
 * @param {string} groupLabel — имя группы объектов
 * @param {object} outages    — { downSystems:Set, bySystem:Map } или null
 * @param {object} extras     — { attention: [], quality: [] }
 */
export function buildHelpdeskTextHtml(brokenList, runMeta, groupLabel = '', outages = null, extras = {}) {
  const startDate = new Date(runMeta.startTime);
  const dateStr = fmtTs(runMeta.startTime).slice(0, 10);
  const timeStr = startDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const attention = Array.isArray(extras.attention) ? extras.attention : [];
  const quality   = Array.isArray(extras.quality)   ? extras.quality   : [];

  // Смена ракурса — не дефект картинки: камера показывает нормально, просто
  // смотрит не туда, куда раньше. Раньше она попадала в один абзац с
  // расфокусом и грязным объективом, и оператор читал про исправную камеру
  // «разобрать ничего нельзя». Разводим по разным разделам.
  const imageRows = [];
  const angleRows = [];
  for (const q of quality) {
    const codes = Array.isArray(q.defects) ? q.defects : null;
    if (!codes) { imageRows.push(q); continue; }        // старый вызов без кодов
    const others = codes.filter((c) => c !== ANGLE_DEFECT);
    if (codes.includes(ANGLE_DEFECT)) angleRows.push(q);
    if (others.length) imageRows.push({ ...q, defectsText: describeDefects(others) });
  }

  // Группируем по системе (сохраняем порядок появления в списке).
  // Ключ — systemId, а не отображаемое имя: по нему сверяемся со списком
  // объектов, упавших целиком.
  const bySys = new Map();
  for (const c of brokenList) {
    const key = c.systemId || helpdeskSysName(c.system);
    if (!bySys.has(key)) bySys.set(key, { name: helpdeskSysName(c.system), cams: [] });
    bySys.get(key).cams.push(c);
  }

  // Объекты, упавшие целиком (v3, пункт 1 ТЗ).
  // Когда падает регистратор или канал связи, все камеры объекта уходят в
  // offline разом, и оператор получал перечисление шестнадцати камер вместо
  // одной понятной строки «объект недоступен».
  const downSystems = outages?.downSystems instanceof Set ? outages.downSystems : new Set();
  const bySystemStats = outages?.bySystem instanceof Map ? outages.bySystem : new Map();

  // Каждый объект — отдельный пункт списка: «Объект — не работают камеры: 11, 12, 15»
  const brokenItems = [];
  let outageCount = 0;
  for (const [sysId, { name: sysName, cams }] of bySys.entries()) {
    if (downSystems.has(sysId)) {
      outageCount++;
      const st = bySystemStats.get(sysId);
      const detail = st ? ` (не отвечают ${st.broken} камер из ${st.total})` : '';
      brokenItems.push(`<strong>${sysName} — объект недоступен целиком</strong>${detail}${sinceSuffix(cams)}`);
      continue;
    }

    // Делим на «не работают» (OFFLINE) и «нет записи»
    const offline = cams.filter(c => c.status === 'OFFLINE');
    const noRec   = cams.filter(c => c.status === 'нет записи');

    if (offline.length > 0) {
      const labels = offline.map(c => helpdeskCamLabel(c.camera)).join(', ');
      brokenItems.push(`${sysName} — не работают камеры: ${labels}${sinceSuffix(offline)}`);
    }
    if (noRec.length > 0) {
      const labels = noRec.map(c => helpdeskCamLabel(c.camera)).join(', ');
      brokenItems.push(`${sysName} — нет записи: ${labels}${sinceSuffix(noRec)}`);
    }
    if (offline.length === 0 && noRec.length === 0) {
      // Прочие статусы — на всякий случай
      const labels = cams.map(c => helpdeskCamLabel(c.camera)).join(', ');
      brokenItems.push(`${sysName} — проблема: ${labels}${sinceSuffix(cams)}`);
    }
  }

  const projectPart = groupLabel ? ` по проекту «${groupLabel}»` : '';
  // Считаем «проблемы» так, как их увидит оператор: упавший объект — это одна
  // проблема, а не шестнадцать. Иначе заголовок письма спорил бы с телом.
  const collapsed = [...bySys.entries()]
    .filter(([id]) => downSystems.has(id))
    .reduce((n, [, v]) => n + v.cams.length, 0);
  const total = brokenList.length - collapsed + outageCount;
  const word = total === 1 ? 'проблему' : (total >= 2 && total <= 4 ? 'проблемы' : 'проблем');

  // ── Разделы письма ────────────────────────────────────────────────────────
  // Каждый — нумерованный заголовок + список с отступом. До 18.08.2026 всё
  // шло сплошными абзацами и в 1С читалось «кашей»: оператор не видел, где
  // кончаются неработающие камеры и начинается «обратите внимание».
  const sections = [];

  if (brokenItems.length > 0) {
    sections.push({ title: 'Не работают камеры', body: bulletList(brokenItems) });
  }

  // Камеры работают, но связь регулярно пропадает.
  // Отдельный раздел, а не строка в списке выше: чинить «прямо сейчас» тут
  // нечего, камера на связи. Важно, чтобы оператор не поехал искать «нет
  // картинки» там, где картинка есть.
  if (attention.length > 0) {
    const days = attention[0]?.days || 7;
    const items = attention.map((c) => {
      const again = c.repeat ? (c.worse ? ' — стало хуже' : ' — повторно') : '';
      return `${helpdeskSysName(c.system)} — камера ${helpdeskCamLabel(c.camera)}: `
        + `пропадала ${c.falls} ${plural(c.falls, 'раз', 'раза', 'раз')}, `
        + `суммарно не работала ${fmtDurMin(c.downtime_min)}${again}`;
    });
    sections.push({
      title: `Работают, но связь регулярно пропадает (за последние ${days} дн.)`,
      body: bulletList(items)
        + '\n<p>В момент проверки эти камеры на связи, поэтому в списке выше их нет. '
        + 'Связь с ними пропадает и восстанавливается сама, часть событий на записи отсутствует.</p>',
    });
  }

  // Камера на связи, а качество картинки испортилось.
  if (imageRows.length > 0) {
    const items = imageRows.map((c) => {
      const again = c.repeat ? (c.changed ? ' — картина изменилась' : ' — повторно') : '';
      return `${helpdeskSysName(c.system)} — камера ${helpdeskCamLabel(c.camera)}: ${c.defectsText}${again}`;
    });
    sections.push({
      title: 'Обратите внимание на изображение',
      body: bulletList(items)
        + '\n<p>Эти камеры на связи и передают видео, но качество картинки заметно ухудшилось. '
        + 'Дефект подтверждён несколькими проверками подряд, разовые помехи сюда не попадают.</p>',
    });
  }

  // Камера цела и показывает нормально, но сектор обзора перестал совпадать
  // с прежним. Это не «нельзя разобрать» — это «смотрит в другую сторону».
  if (angleRows.length > 0) {
    const items = angleRows.map((c) => {
      const again = c.repeat ? ' — повторно' : '';
      return `${helpdeskSysName(c.system)} — камера ${helpdeskCamLabel(c.camera)}${again}`;
    });
    sections.push({
      title: 'Камеры смотрят не туда, куда раньше',
      body: bulletList(items)
        + '\n<p>Картинка у этих камер нормальная — изменился сектор обзора. '
        + 'Если камеру перенаправили намеренно, сообщение погаснет само за несколько дней.</p>',
    });
  }

  // Нумерация сквозная и только по тем разделам, которые реально есть.
  const body = sections.length > 0
    ? sections.map((s, i) => `<p><strong>${i + 1}. ${s.title}</strong></p>\n${s.body}`).join('\n\n')
    : '';

  const headline = total > 0
    ? `<p>Автоматическая проверка <strong>${dateStr} ${timeStr}</strong> выявила <strong>${total}</strong> ${word}${projectPart}:</p>`
    : `<p>Автоматическая проверка <strong>${dateStr} ${timeStr}</strong>${projectPart}: неработающих камер нет.</p>`;

  const title = total > 0 ? `Не работают камеры ${dateStr}` : `Обратите внимание ${dateStr}`;

  // Намеренно НЕ используем inline-CSS / таблицы — 1С их отображает «кучей».
  // <ul>/<li> — базовый HTML: отступ рисует сам почтовый клиент, а если
  // список всё-таки развернётся в текст, строки останутся читаемыми.
  return `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><title>${title}</title></head>
<body>

<p>Здравствуйте!</p>

${headline}

${body}

<p>—<br>
Письмо сформировано автоматически системой AutoCamera Monitor.<br>
Для подробностей смотрите полный отчёт по видеонаблюдению.</p>

</body>
</html>`;
}

/**
 * Старая функция-обёртка — оставлена для обратной совместимости.
 * Сейчас просто вызывает текстовую версию.
 */
export const buildHelpdeskDiffHtml = (newlyBroken, _recovered, runMeta, groupLabel = '') =>
  buildHelpdeskTextHtml(newlyBroken, runMeta, groupLabel);

export const buildHelpdeskHtml = (brokenCams, runMeta, groupLabel = '') =>
  buildHelpdeskTextHtml(brokenCams, runMeta, groupLabel);

/**
 * Отправляет ЕДИНСТВЕННОЕ утреннее письмо в helpdesk — по одному на группу.
 *
 * Логика:
 *   • Письмо уходит, если у группы есть хоть одно событие, о котором ещё не
 *     сообщали: новая поломка, новая нестабильная камера или новый дефект
 *     изображения. Одни восстановления письма не вызывают — оператору не
 *     нужны сообщения «всё хорошо».
 *   • Если триггер сработал, в письме идут ВСЕ актуальные события группы:
 *     все сломанные камеры (newlyBroken ∪ stillBroken), все нестабильные и
 *     все дефекты изображения. Оператор видит полную картину по объекту.
 *   • Отдельных рассылок «нестабильные камеры» и «плохое изображение» больше
 *     нет — 05.08.2026 пользователь свёл всё в одно письмо.
 *
 * @param {object} params
 * @param {Array}  params.newlyBroken — новые поломки (один из триггеров)
 * @param {Array}  params.stillBroken — давно лежащие камеры (для полноты письма)
 * @param {Array}  params.recovered   — восстановленные (НЕ используется,
 *                                       оставлен для совместимости вызова)
 * @param {object} params.runMeta     — { startTime, durationMs }
 * @param {object} params.outages     — объекты, упавшие целиком
 * @param {Array}  params.attention   — нестабильные камеры, о которых ещё не писали
 * @param {Array}  params.quality     — дефекты изображения, о которых ещё не писали
 *
 * Совместимость: если передан params.brokenCams (старый API), он трактуется
 * как newlyBroken и одновременно как stillBroken — всё одной кучей шлём.
 */
export async function sendHelpdeskReport({ newlyBroken, stillBroken, recovered, brokenCams, runMeta, outages = null, attention = [], quality = [], reminders = [] }) {
  // Совместимость со старым API.
  if (!newlyBroken && Array.isArray(brokenCams)) {
    newlyBroken = brokenCams;
    stillBroken = [];
  }
  newlyBroken = newlyBroken || [];
  stillBroken = stillBroken || [];
  attention = Array.isArray(attention) ? attention : [];
  quality   = Array.isArray(quality)   ? quality   : [];
  reminders = Array.isArray(reminders) ? reminders : [];
  // recovered нам теперь не нужен — оставлен в сигнатуре, чтобы
  // не ломать вызывающую сторону.

  const helpdeskTo = (process.env.HELPDESK_TO || '')
    .split(',').map(e => e.trim()).filter(Boolean);
  if (helpdeskTo.length === 0) return;

  // Триггер: новая поломка, напоминание о давней ИЛИ событие, о котором ещё
  // не сообщали. Восстановления сами по себе письма не вызывают.
  if (newlyBroken.length === 0 && reminders.length === 0
      && attention.length === 0 && quality.length === 0) return;

  // В письмо включаем все актуальные поломки (новые + давнишние).
  const allBroken = [...newlyBroken, ...stillBroken];

  // Группируем по проектам — отдельное письмо на каждую группу.
  // Письмо уходит только в те группы, где есть СОБЫТИЕ (новая поломка,
  // нестабильная камера или дефект картинки), чтобы при сломавшейся
  // одной группы не дёргать helpdesk по другой.
  const allByGroup = new Map();
  const ensureGroup = (g) => {
    const key = g || 'Прочее';
    if (!allByGroup.has(key)) {
      allByGroup.set(key, { broken: [], attention: [], quality: [], hasEvent: false });
    }
    return allByGroup.get(key);
  };
  for (const c of newlyBroken) ensureGroup(c.group).hasEvent = true;
  for (const c of reminders)   ensureGroup(c.group).hasEvent = true;
  for (const c of allBroken)   ensureGroup(c.group).broken.push(c);
  for (const a of attention) { const g = ensureGroup(a.group); g.attention.push(a); g.hasEvent = true; }
  for (const q of quality)   { const g = ensureGroup(q.group); g.quality.push(q);   g.hasEvent = true; }

  const d = new Date(runMeta.startTime);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();

  const transporter = await createHelpdeskTransport();

  const fromAddr = process.env.SMTP_USER;
  const fromDomain = (fromAddr.split('@')[1] || senderDomain()).trim();

  const buildMail = (to, groupName, payload) => {
    const { broken, attention: att, quality: qual } = payload;
    const html = buildHelpdeskTextHtml(broken, runMeta, groupName, outages,
      { attention: att, quality: qual });
    // Тема должна совпадать с тем, что внутри: если неработающих камер нет,
    // а есть только «обратите внимание», заголовок «не работают камеры» врал бы.
    const brokenCount = countHelpdeskIssues(broken, outages);
    const subject = brokenCount > 0
      ? `[HELPDESK] ${groupName} — не работают камеры ${dd}.${mm}.${yyyy} (${brokenCount} шт.)`
      : `[HELPDESK] ${groupName} — обратите внимание на камеры ${dd}.${mm}.${yyyy} (${att.length + qual.length} шт.)`;
    return {
      from: `"AutoCamera Helpdesk" <${fromAddr}>`,
      envelope: { from: fromAddr, to: [to] },
      replyTo: fromAddr,
      to,
      subject,
      text: htmlToPlainText(html),
      html,
      messageId: `<autocamera-hd-${randomUUID()}@${fromDomain}>`,
      date: new Date(),
      headers: {
        'X-Mailer': 'AutoCamera Monitor/2.0',
        'Auto-Submitted': 'auto-generated',
        'Precedence': 'bulk',
      },
    };
  };

  const sendOneWithRetry = async (to, groupName, payload) => {
    const maxAttempts = 2;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await transporter.sendMail(buildMail(to, groupName, payload));
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 60_000));
      }
    }
    throw lastErr;
  };

  // Каждой группе — каждому получателю отдельное письмо (Яндекс SPAM workaround).
  // Шлём только в те группы, где есть событие.
  const failures = [];
  for (const [groupName, payload] of allByGroup) {
    if (!payload.hasEvent) continue;
    if (payload.broken.length === 0 && payload.attention.length === 0 && payload.quality.length === 0) continue;
    for (const to of helpdeskTo) {
      try {
        await sendOneWithRetry(to, groupName, payload);
      } catch (err) {
        failures.push({ to, groupName, error: err.message });
      }
    }
  }
  if (failures.length > 0) {
    const summary = failures.map(f => `${f.groupName} → ${f.to}: ${f.error}`).join('; ');
    throw new Error(summary);
  }
}

/**
 * Удаляет HTML-отчёты старше N дней (live.html не трогает).
 * @param {number} days
 */
export function cleanOldReports(days) {
  const cutoff = Date.now() - days * 86400_000;
  if (!fs.existsSync(REPORTS_DIR)) return;
  for (const file of fs.readdirSync(REPORTS_DIR)) {
    if (!file.endsWith('.html')) continue;
    // Live-монитор перезаписывается каждый прогон — не удалять
    if (file === 'live.html') continue;
    const fullPath = path.join(REPORTS_DIR, file);
    if (fs.statSync(fullPath).mtimeMs < cutoff) fs.unlinkSync(fullPath);
  }
}
