# setup-schedule.ps1 — Setup Windows Task Scheduler for AutoCamera v2
#
# Creates TWO scheduled tasks:
#   1. "AutoCamera Light" — every N minutes, runs `node src/index.js --light`
#      (status checks + timeline + live.html, no email/snapshots/helpdesk).
#   2. "AutoCamera Daily" — once a day, runs `node src/index.js --daily`
#      (snapshots + email with day history + helpdesk).
#
# Config: config/schedule.json (two-section format — see file).
#
# Usage:
#   .\setup-schedule.ps1            — create/replace both tasks
#   .\setup-schedule.ps1 -Remove    — unregister both tasks

param(
    [switch]$Remove
)

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $ProjectDir "config\schedule.json"

if (-not (Test-Path $ConfigPath)) {
    Write-Host "  Error: config not found $ConfigPath" -ForegroundColor Red
    exit 1
}

$config    = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$lightCfg  = $config.light
$dailyCfg  = $config.daily

if (-not $lightCfg -or -not $dailyCfg) {
    Write-Host "  Error: schedule.json must contain 'light' and 'daily' sections" -ForegroundColor Red
    Write-Host "  See README or config/schedule.json template." -ForegroundColor DarkGray
    exit 1
}

$LightTaskName = $lightCfg.taskName
$DailyTaskName = $dailyCfg.taskName

# ─── Remove mode ─────────────────────────────────────────────────────────────
if ($Remove) {
    foreach ($name in @($LightTaskName, $DailyTaskName, "AutoCamera Monitor")) {
        $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($existing) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Host "  Task '$name' removed." -ForegroundColor Green
        }
    }
    exit 0
}

# ─── Helpers ─────────────────────────────────────────────────────────────────
function MskToLocal([string]$mskTime) {
    $parts = $mskTime -split ':'
    $h = [int]$parts[0]
    $m = [int]$parts[1]
    $localUtcOffset = [int][System.TimeZoneInfo]::Local.BaseUtcOffset.TotalHours
    $mskUtcOffset   = 3
    $diff           = $localUtcOffset - $mskUtcOffset
    $local          = [int]($h + $diff)
    if ($local -lt 0)  { $local += 24 }
    if ($local -ge 24) { $local -= 24 }
    return "{0:00}:{1:00}" -f $local, $m
}

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
    Write-Host "  Error: node.exe not found in PATH" -ForegroundColor Red
    exit 1
}

# ─── Скрытый запуск без окна консоли ─────────────────────────────────────────
# Планировщик запускает node.exe (консольное приложение) в сессии залогиненного
# пользователя — при каждом старте всплывает окно консоли (раздражает раз в 15
# мин у light-задачи). Оборачиваем запуск в VBS-лаунчер: wscript.exe — GUI-хост
# без собственного окна — стартует node скрыто (WshShell.Run <cmd>, 0, False;
# 0 = SW_HIDE). Окно не появляется вообще. Задача остаётся в сессии пользователя,
# поэтому сетевой доступ / SMB работают и пароль хранить не нужно.
# Файл автогенерируется здесь (пути node.exe и проекта зашиваются на этой машине)
# и в git не коммитится (см. .gitignore).
$vbsPath = Join-Path $ProjectDir "run-hidden.vbs"
$vbsContent = @"
' run-hidden.vbs — АВТОГЕНЕРАЦИЯ setup-schedule.ps1, вручную не править.
' Запускает node src\index.js <mode> без окна консоли. Аргумент: --light | --daily.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$ProjectDir"
mode = ""
If WScript.Arguments.Count > 0 Then mode = WScript.Arguments(0)
sh.Run """$nodeExe"" src\index.js " & mode, 0, False
"@
Set-Content -Path $vbsPath -Value $vbsContent -Encoding ASCII
Write-Host "  Hidden-launcher sozdan: $vbsPath" -ForegroundColor DarkGray

# Common task settings
$taskSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 5)

# Remove legacy v1 task name if it exists (was just "AutoCamera Monitor")
$legacy = Get-ScheduledTask -TaskName "AutoCamera Monitor" -ErrorAction SilentlyContinue
if ($legacy) {
    Unregister-ScheduledTask -TaskName "AutoCamera Monitor" -Confirm:$false
    Write-Host "  Legacy task 'AutoCamera Monitor' removed." -ForegroundColor DarkGray
}

# ─── 1. LIGHT TASK ───────────────────────────────────────────────────────────
$lightInterval    = [int]$lightCfg.intervalMinutes
$lightStartLocal  = MskToLocal $lightCfg.startTimeMSK
$lightDurationH   = [int]$lightCfg.durationHours

Write-Host ""
Write-Host "  === AutoCamera Light ===" -ForegroundColor Cyan
Write-Host "  Start (MSK):     $($lightCfg.startTimeMSK)" -ForegroundColor White
Write-Host "  Start (local):   $lightStartLocal" -ForegroundColor White
Write-Host "  Interval:        every $lightInterval min" -ForegroundColor White
Write-Host "  Duration:        $lightDurationH hours" -ForegroundColor White

$lightAction = New-ScheduledTaskAction `
    -Execute "wscript.exe" `
    -Argument "`"$vbsPath`" --light" `
    -WorkingDirectory $ProjectDir

# Создаём DailyTrigger без Repetition сразу — Windows PowerShell 5.1 не позволяет
# задавать $trigger.Repetition.Interval напрямую (свойство read-only на свежесозданном
# CimInstance). Поэтому сначала регистрируем задачу, потом дополняем Repetition
# через Set-ScheduledTask на уже сохранённой задаче.
$lightTrigger = New-ScheduledTaskTrigger -Daily -At $lightStartLocal

$existing = Get-ScheduledTask -TaskName $LightTaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $LightTaskName -Confirm:$false
    Write-Host "  Old light task removed." -ForegroundColor DarkGray
}

Register-ScheduledTask `
    -TaskName $LightTaskName `
    -Action $lightAction `
    -Trigger $lightTrigger `
    -Settings $taskSettings `
    -Description "AutoCamera v2: light status check + timeline + live.html" `
    -RunLevel Highest | Out-Null

# Дополняем триггер настройками повторения
$registered = Get-ScheduledTask -TaskName $LightTaskName
$registered.Triggers[0].Repetition.Interval          = "PT${lightInterval}M"
$registered.Triggers[0].Repetition.Duration          = "PT${lightDurationH}H"
$registered.Triggers[0].Repetition.StopAtDurationEnd = $false
Set-ScheduledTask -InputObject $registered | Out-Null

Write-Host "  Task '$LightTaskName' created!" -ForegroundColor Green

# ─── 2. DAILY TASK ───────────────────────────────────────────────────────────
$dailyStartLocal = MskToLocal $dailyCfg.startTimeMSK

Write-Host ""
Write-Host "  === AutoCamera Daily ===" -ForegroundColor Cyan
Write-Host "  Start (MSK):     $($dailyCfg.startTimeMSK)" -ForegroundColor White
Write-Host "  Start (local):   $dailyStartLocal" -ForegroundColor White
Write-Host "  Mode:            once a day (snapshots + email + helpdesk)" -ForegroundColor White

$dailyAction = New-ScheduledTaskAction `
    -Execute "wscript.exe" `
    -Argument "`"$vbsPath`" --daily" `
    -WorkingDirectory $ProjectDir

$dailyTrigger = New-ScheduledTaskTrigger -Daily -At $dailyStartLocal

$existing = Get-ScheduledTask -TaskName $DailyTaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $DailyTaskName -Confirm:$false
    Write-Host "  Old daily task removed." -ForegroundColor DarkGray
}

Register-ScheduledTask `
    -TaskName $DailyTaskName `
    -Action $dailyAction `
    -Trigger $dailyTrigger `
    -Settings $taskSettings `
    -Description "AutoCamera v2: daily snapshots + email with day history + helpdesk" `
    -RunLevel Highest | Out-Null

Write-Host "  Task '$DailyTaskName' created!" -ForegroundColor Green

# ─── Summary ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Both tasks installed. Check status:" -ForegroundColor Yellow
Write-Host "    Get-ScheduledTask -TaskName '$LightTaskName'" -ForegroundColor DarkGray
Write-Host "    Get-ScheduledTask -TaskName '$DailyTaskName'" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Remove both:    .\setup-schedule.ps1 -Remove" -ForegroundColor DarkGray
Write-Host ""
