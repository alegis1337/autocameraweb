# setup-web-task.ps1 — регистрация веб-карты (v3) как постоянной службы
# через Планировщик задач Windows.
#
# Зачем отдельно от setup-schedule.ps1: там задачи по расписанию (отработал —
# вышел), а веб-сервер живёт постоянно. Это другой тип задачи: триггер «при
# загрузке системы», без ограничения времени выполнения, с автоперезапуском.
#
# Запуск от имени СИСТЕМЫ — намеренно:
#   • процесс идёт в сессии 0, поэтому окна консоли не появляется вообще
#     (не нужен VBS-лаунчер, как для light/daily);
#   • сервер поднимается до входа пользователя и переживает выход из системы.
# Веб-серверу это по силам: он только читает monitor.db и файлы снимков,
# в сеть за камерами не ходит — доступ к SMB-шарам ему не нужен.
#
# Использование:
#   .\setup-web-task.ps1            — создать/пересоздать и запустить
#   .\setup-web-task.ps1 -Remove    — удалить задачу
#
# Требует прав администратора.

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$TaskName = 'AutoCameraWeb'
$ProjectDir = $PSScriptRoot

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Задача '$TaskName' удалена. Веб-карта больше не поднимается автоматически."
  } else {
    Write-Host "Задачи '$TaskName' нет — удалять нечего."
  }
  exit 0
}

# node.exe вызываем напрямую, без обёртки powershell: меньше звеньев в цепочке
# и не нужна возня с политикой выполнения скриптов.
$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { $NodeExe = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $NodeExe)) { throw "node.exe не найден. Установите Node.js 22.5+ или поправьте путь в скрипте." }

if (-not (Test-Path (Join-Path $ProjectDir 'server\app.js'))) {
  throw "Не найден server\app.js — запускайте скрипт из корня проекта."
}

# --disable-warning гасит ExperimentalWarning от node:sqlite: модуль встроенный
# и работает стабильно, но помечен экспериментальным и иначе шумит в логе.
$action = New-ScheduledTaskAction -Execute $NodeExe `
  -Argument '--disable-warning=ExperimentalWarning server/app.js' `
  -WorkingDirectory $ProjectDir

# Два триггера:
#   1) при загрузке системы — обычный старт;
#   2) каждые 5 минут — самолечение.
#
# Второй нужен, потому что штатный «перезапуск при сбое» (RestartCount) на
# убитый процесс не срабатывает: проверено 03.08.2026 — процесс завершили,
# задача вернулась в Ready с результатом 0xFFFFFFFF и сама не поднялась.
# Повторяющийся триггер надёжнее и проще: раз в 5 минут Планировщик пробует
# запустить задачу, а MultipleInstances=IgnoreNew гасит попытку, если сервер
# уже работает. Живой процесс не трогается, мёртвый поднимается за ≤5 минут.
#
# Повтор задаём через -Once с большой конечной длительностью (10 лет). Вариант
# -Daily с -RepetitionInterval/-RepetitionDuration на этой сборке Windows 10 не
# принимается (AmbiguousParameterSet), а [TimeSpan]::MaxValue ненадёжен между
# сборками. 10 лет = практически «навсегда»; на каждой перезагрузке задачу и так
# заново поднимает триггер -AtStartup, так что переживать за renew не нужно.
$trigStartup = New-ScheduledTaskTrigger -AtStartup
$trigHeal = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

# ExecutionTimeLimit = 0 — процесс долгоживущий, Планировщик не должен его убивать.
# IgnoreNew — второй экземпляр не запускать: порт всё равно один. На этом же
# флаге держится самолечение выше.
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName `
  -Action $action -Trigger @($trigStartup, $trigHeal) -Principal $principal -Settings $settings `
  -Description 'Веб-карта состояния камер (AutoCamera v3). Постоянный процесс.' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

$info = Get-ScheduledTaskInfo -TaskName $TaskName
$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host ""
Write-Host "Задача '$TaskName' создана и запущена."
Write-Host "  Состояние:    $state"
Write-Host "  Последний старт: $($info.LastRunTime)"

# WEB_HOST/WEB_PORT берутся из .env — показываем, куда идти.
$envFile = Join-Path $ProjectDir '.env'
$webHost = '127.0.0.1'; $webPort = '8081'
if (Test-Path $envFile) {
  $lines = Get-Content $envFile -Encoding UTF8
  $h = ($lines | Select-String '^WEB_HOST=(.+)$').Matches.Groups[1].Value
  $p = ($lines | Select-String '^WEB_PORT=(.+)$').Matches.Groups[1].Value
  if ($h) { $webHost = $h }
  if ($p) { $webPort = $p }
}
Write-Host "  Адрес:        http://${webHost}:${webPort}"
Write-Host ""
Write-Host "Проверить:  Get-ScheduledTask -TaskName $TaskName"
Write-Host "Логи:       logs\web-<дата>.log"
Write-Host "Удалить:    .\setup-web-task.ps1 -Remove"
