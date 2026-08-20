/**
 * BEWARD Record Center — проверка через SMB-шару записей
 *
 * Структура шары:
 *   \\<host>\<share>\
 *     ├── YYYY-MM-DD\                              — папка-дата
 *     │   ├── <IP>(<port>)_<Имя>\                  — папка камеры
 *     │   │   └── 1_<имя>-CAM1\                    — канал
 *     │   │       └── HH-MM-SS.avi                 — файлы записи
 *
 * Алгоритм:
 *   1. Устанавливаем SMB-сессию (net use).
 *   2. Для каждой камеры ищем папку, начинающуюся с "<ip>(<port>)_" в сегодняшней
 *      (а при отсутствии — во вчерашней) папке-дате.
 *   3. Если папка есть — спускаемся в канал, ищем самый свежий файл.
 *      online  = true, если возраст файла < freshnessMinutes (по умолчанию 60 мин).
 *   4. Если папки нет или файлы устарели — камера offline.
 */

import * as log from './logger.js';
import { runPowershell, ensureSmbSession } from './smb-utils.js';

// BEWARD-камеры часто кратковременно обрываются и снова подключаются — это
// нормальное поведение. Поэтому ориентируемся только на «давно ничего не
// писалось». Если самый свежий файл старше этого порога — камера offline.
const DEFAULT_FRESHNESS_MIN = 180; // 3 часа

/**
 * Запрашивает состояние всех камер одним вызовом PowerShell — это в разы быстрее,
 * чем по одному spawn на камеру.
 *
 * Возвращает массив объектов вида:
 *   { key: "192.168.1.5(5050)", folder: "...", newestFile: "...", ageMin: 3.2 }
 */
async function listFreshness({ host, shareName, cameras, freshnessMin }) {
  // Собираем имя шары из кодпоинтов, чтобы не зависеть от кодировки файла .ps1
  const shareCodes = Array.from(shareName).map((c) => c.codePointAt(0)).join(',');
  // Encode keys as a single-quoted PS string to avoid PowerShell treating `[` as a type accelerator
  const keysJson = JSON.stringify(cameras.map((c) => `${c.ip}(${c.port || 5000})`)).replace(/'/g, "''");

  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8

    $shareName = [string]::new([char[]](${shareCodes}))
    $root = "\\\\${host}\\$shareName"
    $keys = '${keysJson}' | ConvertFrom-Json

    # Находим две самые свежие папки-даты (на случай, если сегодняшняя не успела
    # создаться или проверка идёт сразу после полуночи).
    $dateDirs = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^\\d{4}-\\d{2}-\\d{2}$' } |
      Sort-Object Name -Descending | Select-Object -First 2

    if (-not $dateDirs) {
      Write-Output 'ERROR: no date folders'
      exit
    }

    $now = Get-Date
    $results = @()
    foreach ($key in $keys) {
      $found = $null
      foreach ($dd in $dateDirs) {
        $match = Get-ChildItem -LiteralPath $dd.FullName -Directory -ErrorAction SilentlyContinue |
          Where-Object { $_.Name.StartsWith($key + '_') } | Select-Object -First 1
        if ($match) { $found = $match; break }
      }

      if (-not $found) {
        $results += [pscustomobject]@{
          key = $key; found = $false; ageMin = -1; file = ''; folderName = ''
        }
        continue
      }

      $channel = Get-ChildItem -LiteralPath $found.FullName -Directory -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if (-not $channel) {
        $results += [pscustomobject]@{
          key = $key; found = $true; ageMin = -1; file = ''; folderName = $found.Name
        }
        continue
      }

      # Забираем 20 самых свежих файлов из всех папок-дат (чтобы корректно
      # переходить через полночь и учитывать случай, когда Record Center только
      # что создал новую дату-папку).
      $allFiles = @()
      foreach ($dd2 in $dateDirs) {
        $match2 = Get-ChildItem -LiteralPath $dd2.FullName -Directory -ErrorAction SilentlyContinue |
          Where-Object { $_.Name.StartsWith($key + '_') } | Select-Object -First 1
        if (-not $match2) { continue }
        $ch2 = Get-ChildItem -LiteralPath $match2.FullName -Directory -ErrorAction SilentlyContinue |
          Select-Object -First 1
        if (-not $ch2) { continue }
        $allFiles += Get-ChildItem -LiteralPath $ch2.FullName -File -ErrorAction SilentlyContinue
      }

      $recent = $allFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 20
      if (-not $recent) {
        $results += [pscustomobject]@{
          key = $key; found = $true; ageMin = -1; file = ''; folderName = $found.Name; files = @()
        }
        continue
      }

      $newest = $recent | Select-Object -First 1
      $ageMin = [math]::Round(($now - $newest.LastWriteTime).TotalMinutes, 1)

      $filesInfo = @()
      foreach ($f in $recent) {
        $filesInfo += [pscustomobject]@{
          name = $f.Name
          size = [int64]$f.Length
          ageMin = [math]::Round(($now - $f.LastWriteTime).TotalMinutes, 2)
        }
      }

      $results += [pscustomobject]@{
        key = $key; found = $true; ageMin = $ageMin
        file = $newest.Name; folderName = $found.Name
        files = $filesInfo
      }
    }

    $results | ConvertTo-Json -Compress -Depth 3
  `;

  const { stdout, stderr } = await runPowershell(script);
  const trimmed = stdout.trim();

  if (trimmed.startsWith('ERROR')) {
    return { error: trimmed };
  }

  try {
    const parsed = JSON.parse(trimmed);
    return { items: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (err) {
    return { error: `parse failed: ${err.message}; stdout=${trimmed.slice(0, 200)}; stderr=${stderr.slice(0, 200)}` };
  }
}

/**
 * @param {object} sys
 * @param {string} sys.id
 * @param {string} sys.host           SMB-хост (из .env через ${VAR})
 * @param {string} sys.shareName      имя SMB-шары (Unicode), e.g. "новая папка"
 * @param {string} sys.smbUser
 * @param {string} sys.smbPass
 * @param {number} [sys.freshnessMin] порог свежести в минутах (по умолчанию 60)
 * @param {Array}  sys.cameras        список камер с { index, name, ip, port }
 */
export async function checkBewardSystem(sys) {
  const {
    id, host, shareName, smbUser, smbPass,
    freshnessMin = DEFAULT_FRESHNESS_MIN,
    cameras = [],
  } = sys;

  if (!host || !shareName) {
    const diag = `Не задан host или shareName для "${id}". Проверьте config/systems.json.`;
    log.error(id, diag);
    return { cameras: [], error: diag };
  }
  if (!smbUser || !smbPass) {
    const diag = `Нет SMB-учётки для "${id}". Проверьте BEWARD_SMB_USER и BEWARD_SMB_PASS в .env.`;
    log.error(id, diag);
    return { cameras: [], error: diag };
  }
  if (!cameras.length) {
    const diag = `Список камер пуст для "${id}". Проверьте config/systems.json.`;
    log.error(id, diag);
    return { cameras: [], error: diag };
  }

  log.info(id, 'BEWARD SMB-проверка', {
    host, share: `\\\\${host}\\${shareName}`, cameras: cameras.length, user: smbUser,
  });

  const { ok, diag: smbDiag } = await ensureSmbSession(host, smbUser, smbPass);
  if (!ok) {
    return { cameras: [], error: smbDiag || 'SMB-сессия не установлена' };
  }

  const { items, error } = await listFreshness({ host, shareName, cameras, freshnessMin });
  if (error) {
    const diag = `Не удалось прочитать папки записей на \\\\${host}\\${shareName}. ${error}`;
    log.error(id, diag);
    return { cameras: [], error: diag };
  }

  // Маппим результаты на исходный список камер по ключу "<ip>(<port>)"
  const byKey = new Map(items.map((r) => [r.key, r]));

  const result = cameras.map((cam) => {
    const key = `${cam.ip}(${cam.port || 5000})`;
    const r = byKey.get(key);

    if (!r || !r.found) {
      return {
        index: cam.index,
        name: cam.name,
        online: false,
        recording: false,
        audio: 'unknown',
        notes: 'папка записи отсутствует',
      };
    }

    const age = Number(r.ageMin);
    if (!Number.isFinite(age) || age < 0) {
      return {
        index: cam.index,
        name: cam.name,
        online: false,
        recording: false,
        audio: 'unknown',
        notes: 'канал без файлов',
      };
    }

    const fresh = age <= freshnessMin;
    const ageLabel = age < 60
      ? `${age.toFixed(0)} мин`
      : `${(age / 60).toFixed(1)} ч`;

    return {
      index: cam.index,
      name: cam.name,
      online: fresh,
      recording: fresh,
      audio: 'unknown',
      notes: fresh
        ? `запись ${ageLabel} назад`
        : `давно нет записи: ${ageLabel} назад`,
    };
  });

  return { cameras: result, error: null };
}
