/**
 * Проверка папок с записями по SMB.
 *
 * Используется для систем, где регистратор пишет mp4-файлы в SMB-шару:
 * каждый канал — отдельная папка, файлы ротируются (новый чанк раз в N минут).
 *
 * Алгоритм:
 *   1. Поднять SMB-сессию (idempotent).
 *   2. Для каждого канала забрать N последних файлов (имя / размер / возраст).
 *   3. online = recording = true только если:
 *      • самый свежий файл моложе freshnessMin минут И
 *      • его размер >= minFileSizeKb (т.е. чанк не "битый") И
 *      • среди последних N файлов доля битых не превышает maxBadRatio.
 *
 * Битый файл = размер < minFileSizeKb (по умолчанию 100 КБ). Регистратор пишет
 * mp4-чанки от 250 КБ до 2–3 МБ; обрыв RTSP-потока даёт файлы по 48 байт
 * (только заголовок mp4) — именно их мы и ловим.
 *
 * Пример конфига в systems.json:
 *   {
 *     "id": "site-4",
 *     "type": "smb-recordings",
 *     "host": "${SITE4_SMB_HOST}",
 *     "shareName": "video",
 *     "basePath": "video",
 *     "freshnessMin": 60,
 *     "qualityCheck": {                // (необязательно — есть дефолты)
 *       "sampleSize":    20,           // сколько последних файлов смотреть
 *       "minFileSizeKb": 100,          // < этого — файл битый
 *       "maxBadRatio":   0.30          // > 30% битых из sampleSize → канал плохой
 *     },
 *     "channels": [
 *       { "index": 0, "name": "Канал 5",  "folder": "5"  },
 *       { "index": 1, "name": "Канал 9",  "folder": "9"  },
 *       { "index": 2, "name": "Канал 11", "folder": "11" }
 *     ]
 *   }
 */

import * as log from './logger.js';
import { runPowershell, ensureSmbSession } from './smb-utils.js';

const DEFAULT_FRESHNESS_MIN  = 60;
const DEFAULT_SAMPLE_SIZE    = 20;
const DEFAULT_MIN_FILE_KB    = 100;
const DEFAULT_MAX_BAD_RATIO  = 0.30;

/**
 * Запрашивает PS-скриптом N последних файлов на канал.
 * Возвращает массив items вида:
 *   { folder, found:bool, files: [{ name, size:int64, ageMin:number }] }
 */
async function listFreshness({ host, shareName, basePath, channels, sampleSize }) {
  const shareCodes = Array.from(shareName).map((c) => c.codePointAt(0)).join(',');
  const baseCodes  = basePath
    ? Array.from(basePath).map((c) => c.codePointAt(0)).join(',')
    : '';
  const foldersJson = JSON.stringify(channels.map((c) => c.folder)).replace(/'/g, "''");

  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8

    $shareName = [string]::new([char[]](${shareCodes}))
    $basePath  = ${baseCodes ? `[string]::new([char[]](${baseCodes}))` : "''"}
    $root = "\\\\${host}\\$shareName"
    if ($basePath) { $root = Join-Path $root $basePath }

    $folders = '${foldersJson}' | ConvertFrom-Json
    $now = Get-Date
    $sample = ${Number.isInteger(sampleSize) ? sampleSize : DEFAULT_SAMPLE_SIZE}
    $results = @()

    foreach ($folder in $folders) {
      $dir = Join-Path $root $folder
      $files = Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First $sample

      if (-not $files) {
        $results += [pscustomobject]@{
          folder = $folder; found = $false; files = @()
        }
        continue
      }

      $info = @()
      foreach ($f in $files) {
        $info += [pscustomobject]@{
          name   = $f.Name
          size   = [int64]$f.Length
          ageMin = [math]::Round(($now - $f.LastWriteTime).TotalMinutes, 2)
        }
      }
      $results += [pscustomobject]@{
        folder = $folder; found = $true; files = $info
      }
    }

    # ConvertTo-Json при единственном результате схлопывает массив — оборачиваем
    ConvertTo-Json -InputObject @($results) -Compress -Depth 4
  `;

  const { stdout, stderr } = await runPowershell(script);
  const trimmed = stdout.trim();

  try {
    const parsed = JSON.parse(trimmed);
    return { items: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (err) {
    return { error: `parse failed: ${err.message}; stdout=${trimmed.slice(0, 200)}; stderr=${stderr.slice(0, 200)}` };
  }
}

/**
 * Решает, считать ли канал работающим, по списку последних файлов.
 *
 * @param {Array<{name,size,ageMin}>} files
 * @param {object} cfg
 * @param {number} cfg.freshnessMin
 * @param {number} cfg.minFileBytes
 * @param {number} cfg.maxBadRatio
 * @returns {{
 *   online:boolean, recording:boolean, notes:string,
 *   newestAgeMin:number, badCount:number, totalCount:number, lastSizeBytes:number
 * }}
 */
function evaluateChannel(files, cfg) {
  const totalCount = files.length;

  if (!totalCount) {
    return {
      online: false, recording: false,
      notes: 'нет файлов в папке',
      newestAgeMin: -1, badCount: 0, totalCount: 0, lastSizeBytes: 0,
    };
  }

  const newest = files[0];
  const newestAgeMin = Number(newest.ageMin);
  const fresh = Number.isFinite(newestAgeMin) && newestAgeMin >= 0 && newestAgeMin <= cfg.freshnessMin;
  const ageLabel = newestAgeMin < 60
    ? `${newestAgeMin.toFixed(0)} мин`
    : `${(newestAgeMin / 60).toFixed(1)} ч`;

  const badCount = files.filter((f) => Number(f.size) < cfg.minFileBytes).length;
  const badRatio = badCount / totalCount;

  // 1. Самые свежие файлы давно — канал не пишется вообще
  if (!fresh) {
    const tail = badCount > 0
      ? ` (до этого ${badCount}/${totalCount} битых)`
      : '';
    return {
      online: false, recording: false,
      notes: `устарело: последний чанк ${ageLabel} назад${tail}`,
      newestAgeMin, badCount, totalCount,
      lastSizeBytes: Number(newest.size) || 0,
    };
  }

  // 2. Свежий, но размер последнего файла подозрительно маленький — битая запись
  const lastBytes = Number(newest.size) || 0;
  const lastKbStr = (lastBytes / 1024).toFixed(0);
  const minKb = (cfg.minFileBytes / 1024).toFixed(0);

  if (lastBytes < cfg.minFileBytes) {
    return {
      online: true, recording: false,
      notes: `последний файл битый (${lastKbStr} КБ при норме от ${minKb} КБ); ${badCount}/${totalCount} битых из последних`,
      newestAgeMin, badCount, totalCount, lastSizeBytes: lastBytes,
    };
  }

  // 3. Свежий и нормальный, но среди последних > maxBadRatio битых — нестабильная запись
  if (badRatio > cfg.maxBadRatio) {
    const pct = Math.round(badRatio * 100);
    return {
      online: true, recording: false,
      notes: `качество записи плохое: ${badCount}/${totalCount} битых (${pct}%); последний ${lastKbStr} КБ свежий`,
      newestAgeMin, badCount, totalCount, lastSizeBytes: lastBytes,
    };
  }

  // 4. Всё хорошо
  const sizeMb = (lastBytes / 1024 / 1024).toFixed(1);
  return {
    online: true, recording: true,
    notes: `последний чанк ${ageLabel} назад (${sizeMb} МБ); битых ${badCount}/${totalCount}`,
    newestAgeMin, badCount, totalCount, lastSizeBytes: lastBytes,
  };
}

/**
 * @param {object} sys
 * @param {string} sys.id
 * @param {string} sys.host           SMB-хост (из .env через ${VAR})
 * @param {string} sys.shareName      имя шары, e.g. "video"
 * @param {string} [sys.basePath]     подпапка внутри шары, e.g. "video"
 * @param {string} sys.smbUser
 * @param {string} sys.smbPass
 * @param {number} [sys.freshnessMin] порог свежести в минутах
 * @param {object} [sys.qualityCheck] { sampleSize, minFileSizeKb, maxBadRatio }
 * @param {Array}  sys.channels       [{ index, name, folder }]
 */
export async function checkRecordingsSystem(sys) {
  const {
    id, host, shareName, basePath = '',
    smbUser, smbPass,
    freshnessMin = DEFAULT_FRESHNESS_MIN,
    qualityCheck = {},
    channels = [],
  } = sys;

  const sampleSize    = qualityCheck.sampleSize    || DEFAULT_SAMPLE_SIZE;
  const minFileSizeKb = qualityCheck.minFileSizeKb || DEFAULT_MIN_FILE_KB;
  const maxBadRatio   = qualityCheck.maxBadRatio   != null
    ? qualityCheck.maxBadRatio : DEFAULT_MAX_BAD_RATIO;
  const minFileBytes = minFileSizeKb * 1024;

  if (!host || !shareName) {
    const diag = `Не задан host или shareName в конфигурации системы "${id}". Проверьте config/systems.json.`;
    log.error(id, diag);
    return { cameras: [], error: diag };
  }
  if (!smbUser || !smbPass) {
    const diag = `Нет SMB-учётки для "${id}". Проверьте переменные окружения в .env (smbUserEnv / smbPassEnv).`;
    log.error(id, diag);
    return { cameras: [], error: diag };
  }
  if (!channels.length) {
    const diag = `Список каналов (channels) пуст для "${id}". Проверьте config/systems.json.`;
    log.error(id, diag);
    return { cameras: [], error: diag };
  }

  log.info(id, 'SMB-проверка папок записей', {
    host, share: `\\\\${host}\\${shareName}\\${basePath}`,
    channels: channels.length, user: smbUser,
    sample: sampleSize, minKb: minFileSizeKb, maxBadRatio,
  });

  const { ok, diag: smbDiag } = await ensureSmbSession(host, smbUser, smbPass);
  if (!ok) {
    return { cameras: [], error: smbDiag || 'SMB-сессия не установлена' };
  }

  const { items, error } = await listFreshness({ host, shareName, basePath, channels, sampleSize });
  if (error) {
    const diag = `Не удалось прочитать содержимое папок на \\\\${host}\\${shareName}\\${basePath}. ${error}`;
    log.error(id, diag);
    return { cameras: [], error: diag };
  }

  const byFolder = new Map(items.map((r) => [r.folder, r]));
  const cfg = { freshnessMin, minFileBytes, maxBadRatio };

  const result = channels.map((ch) => {
    const r = byFolder.get(ch.folder);

    if (!r || !r.found) {
      return {
        index: ch.index,
        name: ch.name,
        online: false,
        recording: false,
        audio: 'unknown',
        notes: 'нет файлов в папке',
        // Снимок для тайла отчёта берётся у камеры другой системы (см. buildSnapMap).
        snapshotFrom: ch.snapshotFrom,
      };
    }

    const files = Array.isArray(r.files) ? r.files : [];
    const ev = evaluateChannel(files, cfg);

    log.debug(id, `канал ${ch.name}`, {
      newestAge: ev.newestAgeMin,
      bad: `${ev.badCount}/${ev.totalCount}`,
      lastSizeKb: Math.round(ev.lastSizeBytes / 1024),
      online: ev.online, recording: ev.recording,
    });

    return {
      index: ch.index,
      name: ch.name,
      online: ev.online,
      recording: ev.recording,
      audio: 'unknown',
      notes: ev.notes,
      // Снимок для тайла отчёта берётся у камеры другой системы (см. buildSnapMap).
      snapshotFrom: ch.snapshotFrom,
    };
  });

  return { cameras: result, error: null };
}
