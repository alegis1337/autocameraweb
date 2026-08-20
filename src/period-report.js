/**
 * period-report.js — HTML-отчёт о простоях камер за заданный период.
 *
 * Использование:
 *   node src/period-report.js <fromYmd> <toYmd>
 *   node src/period-report.js 2026-05-19 2026-05-21
 *
 * Берёт все state/timeline-YYYY-MM-DD.json в диапазоне (включительно),
 * агрегирует инциденты по каждой камере и сохраняет отчёт в:
 *   reports/period-<from>-<to>.html
 *
 * Выводит абсолютный путь к получившемуся HTML в stdout (для menu.ps1).
 */

import fs from 'fs';
import path from 'path';
import { loadTimelinesRange, summarizePeriod, formatDuration } from './timeline.js';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Использование: node src/period-report.js <fromYmd> <toYmd>');
  console.error('Пример:        node src/period-report.js 2026-05-19 2026-05-21');
  process.exit(2);
}
const [fromYmd, toYmd] = args;
if (!/^\d{4}-\d{2}-\d{2}$/.test(fromYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(toYmd)) {
  console.error('Даты должны быть в формате YYYY-MM-DD');
  process.exit(2);
}
if (fromYmd > toYmd) {
  console.error('fromYmd должен быть раньше или равен toYmd');
  process.exit(2);
}

const ROOT = path.resolve('.');
const REPORTS_DIR = path.join(ROOT, 'reports');
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const loaded = loadTimelinesRange(fromYmd, toYmd);
const rows   = summarizePeriod(loaded, new Date());

// ─── Сводка ──────────────────────────────────────────────────────────────────
const totalIncidents = rows.reduce((s, r) => s + r.incidents, 0);
const totalDownMin   = rows.reduce((s, r) => s + r.totalDownMin, 0);
const camsCount      = rows.length;
const daysCount      = loaded.length;

const ddmm = (ymd) => {
  const [y, m, d] = ymd.split('-');
  return `${d}.${m}.${y}`;
};
const ddmmShort = (ymd) => {
  const [_, m, d] = ymd.split('-');
  return `${d}.${m}`;
};

// ─── Группировка по объектам ─────────────────────────────────────────────────
const bySystem = new Map();
for (const r of rows) {
  const key = r.system || r.systemId;
  if (!bySystem.has(key)) bySystem.set(key, { group: r.group || '', system: key, cams: [] });
  bySystem.get(key).cams.push(r);
}

// Сортировка систем: сначала те где есть «сейчас лежит», потом по сумме простоя
const systemsList = [...bySystem.values()].sort((a, b) => {
  const aCur = a.cams.some(c => c.currentlyDown) ? 1 : 0;
  const bCur = b.cams.some(c => c.currentlyDown) ? 1 : 0;
  if (aCur !== bCur) return bCur - aCur;
  const aDown = a.cams.reduce((s, c) => s + c.totalDownMin, 0);
  const bDown = b.cams.reduce((s, c) => s + c.totalDownMin, 0);
  return bDown - aDown;
});

// ─── HTML ────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function renderDayLine(day) {
  const periods = day.intervals.map(iv => {
    if (iv.ongoing) return `${iv.from} — сейчас`;
    return `${iv.from} — ${iv.to}`;
  }).join('; ');
  const durStr = formatDuration(day.downMin);
  return `<div style="margin:1px 0;font-size:11px;">
    <strong style="color:#2c5282;">${escapeHtml(ddmmShort(day.date))}</strong>: ${escapeHtml(periods)} <span style="color:#718096;">(${escapeHtml(durStr)})</span>
  </div>`;
}

const systemSections = systemsList.length === 0
  ? `<div style="padding:20px;background:#c6f6d5;color:#276749;border-radius:4px;font-size:14px;">
       За указанный период (${escapeHtml(ddmm(fromYmd))} — ${escapeHtml(ddmm(toYmd))}) сбоев не зарегистрировано.
     </div>`
  : systemsList.map(s => {
      const rows = s.cams.map(c => {
        const statusBadge = c.currentlyDown
          ? '<span style="display:inline-block;padding:1px 6px;background:#fed7d7;color:#c53030;border-radius:9px;font-size:9px;font-weight:600;font-family:Arial,sans-serif;">не работает</span>'
          : '';
        return `<tr style="border-bottom:1px solid #e2e8f0;">
          <td style="padding:6px 10px;font-size:13px;color:#1a202c;vertical-align:top;white-space:nowrap;">
            ${escapeHtml(c.camera)} ${statusBadge}
          </td>
          <td style="padding:6px 10px;font-size:13px;text-align:center;vertical-align:top;color:#4a5568;">${c.incidents}</td>
          <td style="padding:6px 10px;font-size:13px;vertical-align:top;color:#1a202c;font-weight:600;">${escapeHtml(formatDuration(c.totalDownMin))}</td>
          <td style="padding:6px 10px;vertical-align:top;">
            ${c.days.map(renderDayLine).join('')}
          </td>
        </tr>`;
      }).join('');

      return `<div style="margin-bottom:14px;border:1px solid #e2e8f0;border-radius:4px;overflow:hidden;font-family:Arial,sans-serif;">
        <div style="background:#2c5282;color:#ffffff;font-size:13px;font-weight:700;padding:6px 12px;">
          ${escapeHtml(s.system)} <span style="font-size:11px;font-weight:400;color:#bee3f8;">— ${s.cams.length} камер с проблемами</span>
        </div>
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:#ffffff;">
          <tr style="background:#edf2f7;">
            <th style="padding:5px 10px;font-size:11px;text-align:left;font-weight:600;color:#4a5568;">Камера</th>
            <th style="padding:5px 10px;font-size:11px;text-align:center;font-weight:600;color:#4a5568;">Падений</th>
            <th style="padding:5px 10px;font-size:11px;text-align:left;font-weight:600;color:#4a5568;">Простой</th>
            <th style="padding:5px 10px;font-size:11px;text-align:left;font-weight:600;color:#4a5568;">По дням</th>
          </tr>
          ${rows}
        </table>
      </div>`;
    }).join('\n');

const title = `Отчёт о работе камер за ${ddmm(fromYmd)} — ${ddmm(toYmd)}`;

const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; background:#ffffff; color:#1a202c; margin:0; padding:18px; max-width:920px; line-height:1.5; }
  h1   { font-size:1.3rem; color:#1a365d; margin:0 0 6px; }
  .lead{ font-size:0.95rem; color:#4a5568; margin-bottom:14px; }
  .summary { display:flex; gap:14px; margin:14px 0 18px; flex-wrap:wrap; }
  .stat { background:#edf2f7; padding:10px 16px; border-radius:6px; min-width:120px; }
  .stat-value { font-size:1.6rem; font-weight:700; color:#1a365d; }
  .stat-label { font-size:0.78rem; color:#4a5568; text-transform:uppercase; letter-spacing:0.4px; margin-top:2px; }
  .section-title { font-size:1rem; font-weight:700; color:#1a365d; margin:18px 0 8px; border-bottom:2px solid #1a365d; padding-bottom:3px; }
  .meta { font-size:0.8rem; color:#718096; margin-top:24px; padding-top:10px; border-top:1px solid #e2e8f0; }
</style>
</head>
<body>

<h1>${escapeHtml(title)}</h1>
<div class="lead">
  Сводка простоев камер видеонаблюдения за выбранный период.
  Источник: журнал событий <code>state/timeline-*.json</code>, обновляемый
  каждые 15 минут (light-прогон) и в конце дня (daily-прогон).
</div>

<div class="summary">
  <div class="stat">
    <div class="stat-value">${camsCount}</div>
    <div class="stat-label">Камер с проблемами</div>
  </div>
  <div class="stat">
    <div class="stat-value">${totalIncidents}</div>
    <div class="stat-label">Всего падений</div>
  </div>
  <div class="stat">
    <div class="stat-value">${escapeHtml(formatDuration(totalDownMin))}</div>
    <div class="stat-label">Суммарный простой</div>
  </div>
  <div class="stat">
    <div class="stat-value">${daysCount}</div>
    <div class="stat-label">Дней в журнале</div>
  </div>
</div>

<div class="section-title">Простои по объектам</div>
${systemSections}

<div class="meta">
  Отчёт сформирован ${new Date().toLocaleString('ru-RU')}<br>
  AutoCamera Monitor v2
</div>

</body>
</html>`;

const outPath = path.join(REPORTS_DIR, `period-${fromYmd}-${toYmd}.html`);
fs.writeFileSync(outPath, html, 'utf8');
console.log(outPath);
