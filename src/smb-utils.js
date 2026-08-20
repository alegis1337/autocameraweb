/**
 * Общие SMB-хелперы: запуск PowerShell + установка SMB-сессии.
 * Используются модулями beward-check.js и recordings-check.js.
 */

import { spawn } from 'child_process';
import * as log from './logger.js';

export function runPowershell(script) {
  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-OutputFormat', 'Text',
      '-Command', script,
    ], { windowsHide: true });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (err) => resolve({ code: -1, stdout: '', stderr: String(err) }));
  });
}

/**
 * Идемпотентно поднимает SMB-сессию к серверу через IPC$.
 * Возвращает { ok, diag } — diag содержит диагностику при ошибке.
 */
export async function ensureSmbSession(host, user, pass) {
  const step = `smb:${host}`;

  // Шаг 1: проверяем доступность хоста (ping)
  const pingResult = await runPowershell(
    `(New-Object Net.Sockets.TcpClient).ConnectAsync('${host}', 445).Wait(5000)`
  );
  const portOpen = pingResult.stdout.trim() === 'True';

  if (!portOpen) {
    const diag = `Хост ${host} недоступен по порту 445 (SMB). Возможные причины: хост выключен, порт заблокирован файрволом, сеть недоступна.`;
    log.error(step, diag);
    return { ok: false, diag };
  }

  // Шаг 2: пытаемся установить SMB-сессию
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    $result = & net use \\\\${host}\\IPC$ /user:${user} "${pass}" 2>&1
    if ($LASTEXITCODE -eq 0 -or $result -match 'already') {
      Write-Host "SMB_OK"
    } else {
      Write-Host "SMB_FAIL:$result"
    }
  `;
  const { stdout, stderr } = await runPowershell(script);

  if (stdout.includes('SMB_OK')) {
    log.debug(step, 'SMB-сессия установлена', { host, user });
    return { ok: true, diag: '' };
  }

  // Разбираем ошибку
  const errMsg = stdout.replace('SMB_FAIL:', '').trim() || stderr.trim();
  let diag = `Не удалось подключиться к \\\\${host}\\IPC$ (пользователь: ${user}). `;

  if (errMsg.includes('67') || errMsg.includes('сетевое имя')) {
    diag += 'Ошибка 67: сетевое имя не найдено. SMB-шара не существует или сервер не поддерживает SMB.';
  } else if (errMsg.includes('53') || errMsg.includes('не найден')) {
    diag += 'Ошибка 53: сетевой путь не найден. Хост недоступен по сети.';
  } else if (errMsg.includes('86') || errMsg.includes('пароль')) {
    diag += 'Ошибка 86: неверный логин или пароль.';
  } else if (errMsg.includes('1219') || errMsg.includes('несколько подключений')) {
    diag += 'Ошибка 1219: уже есть подключение с другими учётными данными. Попробуйте: net use \\\\' + host + ' /delete';
  } else if (errMsg.includes('1702')) {
    diag += 'Ошибка 1702: недопустимый дескриптор привязки. Возможно несовместимость SMB-протоколов.';
  } else {
    diag += `Ответ: ${errMsg.substring(0, 200)}`;
  }

  log.error(step, diag);
  return { ok: false, diag };
}
