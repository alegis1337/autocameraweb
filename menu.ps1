# AutoCamera Monitor
# Корень проекта — папка самого menu.ps1. Абсолютный путь тут был зашит
# намертво (с именем пользователя ВМ): проект нельзя было перенести, а имя
# уезжало в репозиторий. Fallback на текущую папку — для случая, когда
# $PSScriptRoot пуст (запуск построчной вставкой в консоль).
$ProjectDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$Version    = "v3.5"
Set-Location $ProjectDir

# UTF-8 для вывода node-скриптов (имена систем в systems.json — кириллица).
# Без этого Russian-вывод из node превращается в кашу на консоли cp866/1251.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8

# Транслит кириллицы в латиницу — для отображения имён систем/камер
# в стиле остального меню (всё на translit'е). Маппинг сделан по
# Unicode code points (0x0410..0x044F + 0x0401/0x0451), а не по буквенным
# литералам — это важно, т.к. menu.ps1 хранится в UTF-8 без BOM, а PS 5.1
# читает его в системной cp1251. Литералы кириллицы внутри файла поэтому
# бьются, а целочисленные сравнения — нет.
function ConvertTo-Translit {
    param([string]$Text)
    if (-not $Text) { return $Text }
    $upper = @('A','B','V','G','D','E','Zh','Z','I','Y','K','L','M','N','O','P','R','S','T','U','F','Kh','Ts','Ch','Sh','Sch','','Y','','E','Yu','Ya')
    $lower = @('a','b','v','g','d','e','zh','z','i','y','k','l','m','n','o','p','r','s','t','u','f','kh','ts','ch','sh','sch','','y','','e','yu','ya')
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $Text.ToCharArray()) {
        $code = [int]$ch
        if     ($code -ge 0x0410 -and $code -le 0x042F) { $null = $sb.Append($upper[$code - 0x0410]) }
        elseif ($code -ge 0x0430 -and $code -le 0x044F) { $null = $sb.Append($lower[$code - 0x0430]) }
        elseif ($code -eq 0x0401)                       { $null = $sb.Append('Yo') }
        elseif ($code -eq 0x0451)                       { $null = $sb.Append('yo') }
        else                                            { $null = $sb.Append($ch) }
    }
    return $sb.ToString()
}

# Список объектов для меню — из config/systems.json, а не зашит в скрипт:
# имена объектов это данные заказчика, а menu.ps1 лежит в публичном репозитории.
# Побочный плюс: добавили систему в конфиг — она сразу появилась в меню.
function Get-Systems {
    $file = Join-Path $ProjectDir "config\systems.json"
    if (-not (Test-Path $file)) { return @() }
    try {
        $json = Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return @()
    }
    return @($json | Where-Object { $_.id })
}

# Группы объектов: имена берём из .env (REPORT_GROUPS вида "<Группа>:<СУФФИКС>").
function Get-Groups {
    $raw = Get-EnvValue "REPORT_GROUPS"
    $out = @()
    foreach ($part in ($raw -split ",")) {
        $name = ($part -split ":")[0].Trim()
        if ($name) { $out += $name }
    }
    return $out
}

# Имя переменной с адресатами группы: REPORT_TO_<СУФФИКС> из REPORT_GROUPS.
function Get-GroupEnvKey {
    param($Group)
    $raw = Get-EnvValue "REPORT_GROUPS"
    foreach ($part in ($raw -split ",")) {
        $kv = $part -split ":"
        if ($kv[0].Trim() -eq $Group -and $kv.Count -gt 1 -and $kv[1].Trim()) {
            return "REPORT_TO_" + $kv[1].Trim()
        }
    }
    return "REPORT_TO"
}

function Get-GroupRecipients {
    param($Group)
    return Get-EnvValue (Get-GroupEnvKey $Group)
}

function Get-EnvValue {
    param($Key)
    $envFile = Join-Path $ProjectDir ".env"
    $lines = Get-Content $envFile -Encoding UTF8
    foreach ($line in $lines) {
        if ($line -match "^${Key}=(.*)$") { return $Matches[1] }
    }
    return ""
}

function Set-EnvValue {
    param($Key, $Value)
    $envFile = Join-Path $ProjectDir ".env"
    $lines = Get-Content $envFile -Encoding UTF8
    $found = $false
    $newLines = @()
    foreach ($line in $lines) {
        if ($line -match "^${Key}=") {
            $newLines += "${Key}=${Value}"
            $found = $true
        } else {
            $newLines += $line
        }
    }
    if (-not $found) { $newLines += "${Key}=${Value}" }
    $newLines | Set-Content $envFile -Encoding UTF8
}

function Show-Menu {
    Clear-Host

    # Объекты и группы читаем из конфига и .env — в скрипте их имён нет.
    $script:MenuSystems = Get-Systems
    $reportFallback = Get-EnvValue "REPORT_TO"
    $helpdeskTo     = Get-EnvValue "HELPDESK_TO"

    # schedule.json v2: две задачи — light (каждые N минут) и daily (раз в день).
    $schedulePath = Join-Path $ProjectDir "config\schedule.json"
    $schedInfo = "ne nastroeno"
    if (Test-Path $schedulePath) {
        $sch       = Get-Content $schedulePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $lightCfg  = $sch.light
        $dailyCfg  = $sch.daily
        if ($lightCfg -and $dailyCfg) {
            $lightInt = [int]$lightCfg.intervalMinutes
            $lightDur = [int]$lightCfg.durationHours
            if ($lightDur -ge 24) {
                $lightDesc = "Light kazhdye ${lightInt}min kruglosutochno (24/7)"
            } else {
                $lightDesc = "Light $($lightCfg.startTimeMSK) MSK kazhdye ${lightInt}min (${lightDur}ch okno)"
            }
            $schedInfo = "$lightDesc, Daily $($dailyCfg.startTimeMSK) MSK"
            $lightOk = $false; $dailyOk = $false
            if ($lightCfg.taskName) {
                $lightOk = [bool](Get-ScheduledTask -TaskName $lightCfg.taskName -ErrorAction SilentlyContinue)
            }
            if ($dailyCfg.taskName) {
                $dailyOk = [bool](Get-ScheduledTask -TaskName $dailyCfg.taskName -ErrorAction SilentlyContinue)
            }
            if     ($lightOk -and $dailyOk) { $schedInfo += " [AKTIVNO]" }
            elseif ($lightOk -or  $dailyOk) { $schedInfo += " [chastichno]" }
            else                            { $schedInfo += " [ne primeneno]" }
        } else {
            $schedInfo = "staryy format schedule.json (net light/daily)"
        }
    }

    Write-Host ""
    $title = "  |        AutoCamera Monitor  $Version          |"
    Write-Host "  +------------------------------------------+" -ForegroundColor Cyan
    Write-Host $title -ForegroundColor Cyan
    Write-Host "  +------------------------------------------+" -ForegroundColor Cyan
    Write-Host ""
    foreach ($g in Get-Groups) {
        $to = Get-GroupRecipients $g
        if (-not $to) { $to = "$reportFallback (fallback)" }
        Write-Host ("  Otchet " + (ConvertTo-Translit $g).PadRight(10) + ": ") -NoNewline -ForegroundColor Gray
        Write-Host "$to" -ForegroundColor DarkCyan
    }
    Write-Host "  Helpdesk:         " -NoNewline -ForegroundColor Gray
    Write-Host "$helpdeskTo" -ForegroundColor DarkCyan
    Write-Host "  Zapusk:    " -NoNewline -ForegroundColor Gray
    Write-Host "$schedInfo" -ForegroundColor DarkCyan
    Write-Host ""
    Write-Host "   1  Proverit VSE sistemy " -NoNewline -ForegroundColor White
    Write-Host "(s otpravkoy email)" -ForegroundColor DarkGray
    Write-Host "   T  Testovaya proverka VSEKH " -NoNewline -ForegroundColor Yellow
    Write-Host "(bez otpravki email)" -ForegroundColor DarkGray
    Write-Host "   --------------------------------" -ForegroundColor DarkGray
    # Пункты 2..N строятся по config/systems.json: номер = позиция в конфиге + 1.
    $lastGroup = ""
    $n = 1
    foreach ($s in $script:MenuSystems) {
        $n++
        if ($s.group -and $s.group -ne $lastGroup) {
            $lastGroup = $s.group
            Write-Host ("   --- " + (ConvertTo-Translit $s.group).ToUpper() + " ---") -ForegroundColor Cyan
        }
        $label = ConvertTo-Translit $s.name
        $type  = ""
        if ($label -match '^(.*?)\s*\(([^)]*)\)\s*$') { $label = $Matches[1]; $type = $Matches[2] }
        Write-Host ("  " + $n.ToString().PadLeft(2) + "  " + $label.PadRight(15)) -NoNewline -ForegroundColor White
        if ($type) { Write-Host "($type)" -ForegroundColor DarkGray } else { Write-Host "" }
    }
    Write-Host "   --------------------------------" -ForegroundColor DarkGray
    Write-Host "   R  Otkryt posledniy otchet" -ForegroundColor Yellow
    Write-Host "   V  Otkryt live-monitor" -ForegroundColor Yellow
    Write-Host "   H  Otchet za period (mesyats / dni)" -ForegroundColor Yellow
    Write-Host "   L  Otkryt logi" -ForegroundColor Yellow
    Write-Host "   --------------------------------" -ForegroundColor DarkGray
    Write-Host "   S  Nastroit raspisanie" -ForegroundColor Magenta
    Write-Host "   E  Nastroit email-adresa" -ForegroundColor Magenta
    Write-Host "   G  Upravlenie kamerami (seryy / aktiv / udalit)" -ForegroundColor Magenta
    Write-Host ""
    Write-Host "   0  Vyhod" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host ""
    Write-Host ""
}

function Setup-Schedule {
    # schedule.json v2: два блока — light (каждые N мин) и daily (раз в день).
    $configPath = Join-Path $ProjectDir "config\schedule.json"
    $config     = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json

    if (-not $config.light -or -not $config.daily) {
        Clear-Host
        Write-Host ""
        Write-Host "  Oshibka: config\schedule.json ne soderzhit blokov 'light' i 'daily'." -ForegroundColor Red
        Write-Host "  Format v2 ozhidaet:" -ForegroundColor Gray
        Write-Host "    { light: { taskName, intervalMinutes, startTimeMSK, durationHours }," -ForegroundColor DarkGray
        Write-Host "      daily: { taskName, startTimeMSK } }" -ForegroundColor DarkGray
        Read-Host "  Enter - nazad"
        return
    }

    Clear-Host
    Write-Host ""
    Write-Host "  === Nastroyka raspisaniya (v2: Light + Daily) ===" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Tekushchie nastroyki:" -ForegroundColor White
    Write-Host "    Light  (proverka statusov + live.html, bez email):" -ForegroundColor Gray
    Write-Host "      Start (MSK):  $($config.light.startTimeMSK)" -ForegroundColor DarkCyan
    Write-Host "      Interval:     kazhdye $([int]$config.light.intervalMinutes) min" -ForegroundColor DarkCyan
    Write-Host "      Duration:     $([int]$config.light.durationHours) ch" -ForegroundColor DarkCyan
    Write-Host "    Daily  (snapshoty + email + helpdesk):" -ForegroundColor Gray
    Write-Host "      Start (MSK):  $($config.daily.startTimeMSK)" -ForegroundColor DarkCyan

    $lightExisting = Get-ScheduledTask -TaskName $config.light.taskName -ErrorAction SilentlyContinue
    $dailyExisting = Get-ScheduledTask -TaskName $config.daily.taskName -ErrorAction SilentlyContinue
    Write-Host ""
    if ($lightExisting) { Write-Host "    Zadacha '$($config.light.taskName)': DA"  -ForegroundColor Green }
    else                { Write-Host "    Zadacha '$($config.light.taskName)': NET" -ForegroundColor Yellow }
    if ($dailyExisting) { Write-Host "    Zadacha '$($config.daily.taskName)': DA"  -ForegroundColor Green }
    else                { Write-Host "    Zadacha '$($config.daily.taskName)': NET" -ForegroundColor Yellow }

    Write-Host ""
    Write-Host "  1  Izmenit vremya zapuska Light (MSK)" -ForegroundColor White
    Write-Host "  2  Izmenit interval Light (minut)" -ForegroundColor White
    Write-Host "  3  Izmenit Duration Light (chasov)" -ForegroundColor White
    Write-Host "  4  Izmenit vremya zapuska Daily (MSK)" -ForegroundColor White
    Write-Host "  5  Primenit raspisanie (sozdat obe zadachi)" -ForegroundColor Green
    Write-Host "  6  Udalit obe zadachi iz planirovshchika" -ForegroundColor Red
    Write-Host "  0  Nazad" -ForegroundColor DarkGray
    Write-Host ""

    $ch = Read-Host "  Vyberi punkt"
    switch ($ch) {
        "1" {
            $newTime = Read-Host "  Vremya zapuska Light MSK (naprimer 06:00)"
            if ($newTime -match '^\d{1,2}:\d{2}$') {
                $config.light.startTimeMSK = $newTime
                $config | ConvertTo-Json -Depth 5 | Set-Content $configPath -Encoding UTF8
                Write-Host "  Light start: $newTime MSK" -ForegroundColor Green
            } else { Write-Host "  Nevernyy format" -ForegroundColor Red }
        }
        "2" {
            $val = Read-Host "  Interval Light v minutakh (naprimer 15)"
            try {
                $mins = [int]$val
                if ($mins -lt 1) { throw "minimum 1" }
                $config.light.intervalMinutes = $mins
                $config | ConvertTo-Json -Depth 5 | Set-Content $configPath -Encoding UTF8
                Write-Host "  Light interval: kazhdye $mins min" -ForegroundColor Green
            } catch { Write-Host "  Nevernyy format (nuzhno tseloe >= 1)" -ForegroundColor Red }
        }
        "3" {
            $val = Read-Host "  Duration Light v chasakh (naprimer 14)"
            try {
                $hrs = [int]$val
                if ($hrs -lt 1 -or $hrs -gt 24) { throw "1..24" }
                $config.light.durationHours = $hrs
                $config | ConvertTo-Json -Depth 5 | Set-Content $configPath -Encoding UTF8
                Write-Host "  Light duration: $hrs ch" -ForegroundColor Green
            } catch { Write-Host "  Nevernyy format (1..24)" -ForegroundColor Red }
        }
        "4" {
            $newTime = Read-Host "  Vremya zapuska Daily MSK (naprimer 14:00)"
            if ($newTime -match '^\d{1,2}:\d{2}$') {
                $config.daily.startTimeMSK = $newTime
                $config | ConvertTo-Json -Depth 5 | Set-Content $configPath -Encoding UTF8
                Write-Host "  Daily start: $newTime MSK" -ForegroundColor Green
            } else { Write-Host "  Nevernyy format" -ForegroundColor Red }
        }
        "5" {
            Write-Host ""
            Write-Host "  Sozdayu zadachi (Light + Daily)..." -ForegroundColor Cyan
            & powershell.exe -ExecutionPolicy Bypass -File "$ProjectDir\setup-schedule.ps1"
        }
        "6" {
            Write-Host ""
            & powershell.exe -ExecutionPolicy Bypass -File "$ProjectDir\setup-schedule.ps1" -Remove
        }
    }
    Write-Host ""
    Read-Host "  Enter - nazad"
}

# Добавить один или несколько адресов К СУЩЕСТВУЮЩЕМУ списку (старые не трогаем).
# Дубли (без учёта регистра) пропускаются.
function Add-EmailToList {
    param($Key, $Label)
    Write-Host ""
    Write-Host "  Mozhno ukazat neskolko adresov cherez zapyatuyu (naprimer: a@x.ru, b@x.ru)" -ForegroundColor Gray
    $new = Read-Host "  Dobavit adres(a) k spisku ($Label)"
    $parts = @($new.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($parts.Count -eq 0) {
        Write-Host "  Nichego ne vvedeno - spisok bez izmeneniy" -ForegroundColor Yellow
        return
    }
    $bad = $parts | Where-Object { $_ -notmatch '@' }
    if ($bad) {
        Write-Host "  Nevernyy format email v: $($bad -join ', ')" -ForegroundColor Red
        return
    }
    # Текущий список -> массив
    $current = Get-EnvValue $Key
    $existing = @()
    if ($current) { $existing = @($current.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    # Добавляем новые в конец, дубли (-notcontains регистронезависим) пропускаем
    $merged = @($existing)
    $added  = @()
    foreach ($p in $parts) {
        if ($merged -notcontains $p) { $merged += $p; $added += $p }
    }
    $clean = ($merged -join ',')
    Set-EnvValue $Key $clean
    if ($added.Count -gt 0) {
        Write-Host "  Dobavleno: $($added -join ', ')" -ForegroundColor Green
    } else {
        Write-Host "  Vse ukazannye adresa uzhe byli v spiske - bez izmeneniy" -ForegroundColor Yellow
    }
    Write-Host "  ${Label} teper: $clean" -ForegroundColor DarkCyan
}

# Полностью очистить список адресов (с подтверждением).
function Clear-EmailList {
    param($Key, $Label)
    $current = Get-EnvValue $Key
    if (-not $current) {
        Write-Host "  ${Label}: spisok uzhe pust" -ForegroundColor Yellow
        return
    }
    Write-Host ""
    Write-Host "  Tekushchie adresa: $current" -ForegroundColor DarkCyan
    $confirm = Read-Host "  Ubrat VSE adresa iz spiska '$Label'? (da/net)"
    if ($confirm -match '^(da|d|yes|y)$') {
        Set-EnvValue $Key ""
        Write-Host "  ${Label}: spisok ochishchen (budet ispolzovatsya fallback REPORT_TO)" -ForegroundColor Yellow
    } else {
        Write-Host "  Otmeneno - spisok bez izmeneniy" -ForegroundColor DarkGray
    }
}

# Подменю управления одним списком рассылки: добавить / очистить.
function Manage-EmailList {
    param($Key, $Label)
    while ($true) {
        $current = Get-EnvValue $Key
        Clear-Host
        Write-Host ""
        Write-Host "  === $Label : adresa rassylki ===" -ForegroundColor Cyan
        Write-Host ""
        if ($current) {
            $addrs = @($current.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
            Write-Host "  Tekushchie adresa ($($addrs.Count)):" -ForegroundColor White
            $i = 1
            foreach ($a in $addrs) { Write-Host ("    {0}. {1}" -f $i, $a) -ForegroundColor DarkCyan; $i++ }
        } else {
            Write-Host "  Spisok pust (ispolzuetsya fallback REPORT_TO)" -ForegroundColor DarkGray
        }
        Write-Host ""
        Write-Host "  A  Dobavit adres(a) k spisku (starye ostayutsya)" -ForegroundColor White
        Write-Host "  C  Ubrat VSE adresa iz spiska" -ForegroundColor White
        Write-Host "  0  Nazad" -ForegroundColor DarkGray
        Write-Host ""
        $ch = Read-Host "  Vyberi punkt"
        switch ($ch.ToUpper()) {
            "A" { Add-EmailToList $Key $Label; Write-Host ""; Read-Host "  Enter..." }
            "C" { Clear-EmailList  $Key $Label; Write-Host ""; Read-Host "  Enter..." }
            "0" { return }
            default { }
        }
    }
}

function Setup-Email {
    while ($true) {
        $groups         = Get-Groups
        $reportFallback = Get-EnvValue "REPORT_TO"
        $helpdeskTo     = Get-EnvValue "HELPDESK_TO"

        Clear-Host
        Write-Host ""
        Write-Host "  === Nastroyka email-adresov ===" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  Tekushchie adresa:" -ForegroundColor White
        $gi = 0
        foreach ($g in $groups) {
            $gi++
            $to = Get-GroupRecipients $g
            Write-Host ("    " + $gi + "  Otchet " + (ConvertTo-Translit $g).PadRight(12) + ": ") -NoNewline -ForegroundColor Gray
            if ($to) { Write-Host "$to" -ForegroundColor DarkCyan }
            else     { Write-Host "(ispolzuetsya fallback: $reportFallback)" -ForegroundColor DarkGray }
        }
        Write-Host "    Fallback REPORT_TO:  " -NoNewline -ForegroundColor Gray
        Write-Host "$reportFallback" -ForegroundColor DarkGray
        Write-Host "    Helpdesk:            " -NoNewline -ForegroundColor Gray
        Write-Host "$helpdeskTo" -ForegroundColor DarkCyan
        Write-Host ""
        $gi = 0
        foreach ($g in $groups) {
            $gi++
            Write-Host ("  " + $gi + "  Rassylka " + (ConvertTo-Translit $g) + " (dobavit / ochistit)") -ForegroundColor White
        }
        Write-Host "  H  Rassylka HELPDESK  (dobavit / ochistit)" -ForegroundColor White
        Write-Host "  F  Fallback REPORT_TO (dobavit / ochistit)" -ForegroundColor DarkGray
        Write-Host "  0  Nazad" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  Zakazchiku - otchet o rabote kamer." -ForegroundColor DarkGray
        Write-Host "  Helpdesk - odno pismo: polomki + na chto obratit vnimanie." -ForegroundColor DarkGray
        Write-Host ""

        $ch = Read-Host "  Vyberi punkt"
        switch ($ch) {
            { $_ -match '^\d+$' -and [int]$_ -ge 1 -and [int]$_ -le $groups.Count } {
                $g = $groups[[int]$_ - 1]
                Manage-EmailList (Get-GroupEnvKey $g) (ConvertTo-Translit $g)
            }
            "H" { Manage-EmailList "HELPDESK_TO" "Helpdesk" }
            "h" { Manage-EmailList "HELPDESK_TO" "Helpdesk" }
            "F" { Manage-EmailList "REPORT_TO"   "Fallback" }
            "f" { Manage-EmailList "REPORT_TO"   "Fallback" }
            "0" { return }
            default { }
        }
    }
}

function Manage-OneSystem {
    param($SysId, $SysName)

    while ($true) {
        Clear-Host
        Write-Host ""
        $sysNameAscii = ConvertTo-Translit $SysName
        Write-Host "  === Kamery: $sysNameAscii ($SysId) ===" -ForegroundColor Cyan
        Write-Host ""

        # Используем НОВЫЙ manage-cameras.mjs (он поддерживает delete; формат list тот же).
        $raw = & node "$ProjectDir\src\manage-cameras.mjs" list $SysId 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  Oshibka: $raw" -ForegroundColor Red
            Read-Host "  Enter - nazad"
            return
        }

        $items = @()
        foreach ($line in $raw) {
            if ($line -match '^(\d+)\|(.+)\|(gray|active)\|(name|channel)$') {
                $items += [pscustomobject]@{
                    Pos    = [int]$Matches[1]
                    Label  = $Matches[2]
                    Status = $Matches[3]
                    Kind   = $Matches[4]
                }
            }
        }

        if ($items.Count -eq 0) {
            Write-Host "  Net kamer dlya etoy sistemy" -ForegroundColor Yellow
            Read-Host "  Enter - nazad"
            return
        }

        $grayCount   = ($items | Where-Object { $_.Status -eq 'gray' }).Count
        $activeCount = $items.Count - $grayCount
        Write-Host "  Vsego kamer: $($items.Count)   |   Aktivnyh: $activeCount   |   Seryh: $grayCount" -ForegroundColor White
        Write-Host ""

        foreach ($it in $items) {
            $num   = "{0,3}" -f $it.Pos
            $label = ConvertTo-Translit $it.Label
            if ($it.Status -eq 'gray') {
                Write-Host "  $num  [SERAYA] " -NoNewline -ForegroundColor DarkGray
                Write-Host "$label" -ForegroundColor DarkGray
            } else {
                Write-Host "  $num  [aktiv]  " -NoNewline -ForegroundColor Green
                Write-Host "$label" -ForegroundColor White
            }
        }

        Write-Host ""
        Write-Host "  Vvedite nomer kamery, ili 0 - nazad" -ForegroundColor Gray
        $ans = Read-Host "  Nomer kamery"
        if ($ans -eq "0" -or -not $ans) { return }
        if ($ans -notmatch '^\d+$') {
            Write-Host "  Nuzhno chislo" -ForegroundColor Red
            Start-Sleep -Seconds 1
            continue
        }

        $pos = [int]$ans
        $selected = $items | Where-Object { $_.Pos -eq $pos } | Select-Object -First 1
        if (-not $selected) {
            Write-Host "  Net kamery s nomerom $pos" -ForegroundColor Red
            Start-Sleep -Seconds 1
            continue
        }

        # Подменю действий для выбранной камеры
        $selLabelAscii = ConvertTo-Translit $selected.Label
        Write-Host ""
        Write-Host "  Vybrana kamera: $selLabelAscii [$($selected.Status)]" -ForegroundColor Cyan
        Write-Host ""
        if ($selected.Status -eq 'gray') {
            Write-Host "  1  Snyat seryy marker (vernut v otslezhivanie)" -ForegroundColor Green
        } else {
            Write-Host "  1  Pomenit SERYM (perestat otslezhivat)" -ForegroundColor Yellow
        }
        Write-Host "  2  UDALIT iz konfiga (sovsem ubrat iz otcheta)" -ForegroundColor Red
        Write-Host "  0  Otmena" -ForegroundColor DarkGray
        Write-Host ""

        $act = Read-Host "  Vyberi deystvie"
        $cmd = $null
        switch ($act) {
            "1" { $cmd = if ($selected.Status -eq 'gray') { 'ungray' } else { 'gray' } }
            "2" {
                Write-Host ""
                Write-Host "  Vy uvereny, chto khotite SOVSEM udalit kameru '$($selected.Label)'?" -ForegroundColor Yellow
                $confirm = Read-Host "  Vvedite 'yes' dlya podtverzhdeniya"
                if ($confirm -eq 'yes') { $cmd = 'delete' }
            }
            default { continue }
        }
        if (-not $cmd) { continue }

        $result = & node "$ProjectDir\src\manage-cameras.mjs" $cmd $SysId $pos 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  Oshibka: $result" -ForegroundColor Red
            Read-Host "  Enter..."
            continue
        }

        $resStr = ($result -join "`n")
        # Форматы вывода manage-cameras.mjs:
        #   ok|gray|<label>            ok|ungray|<label>
        #   ok|delete|<label>          ok|grayed-fallback|<label>
        #   noop|<action>|<label>
        if ($resStr -match '^ok\|grayed-fallback\|(.+)$') {
            $lbl = ConvertTo-Translit $Matches[1]
            Write-Host "  Kamera '$lbl' pomechena SERYM" -ForegroundColor Yellow
            Write-Host "  (Eto NVR-kanal - fizicheski udalit nelzya, NVR ego vsegda otdaet.)" -ForegroundColor DarkGray
        } elseif ($resStr -match '^ok\|(gray|ungray|delete)\|(.+)$') {
            $action = $Matches[1]; $label = ConvertTo-Translit $Matches[2]
            switch ($action) {
                'gray'   { Write-Host "  Kamera '$label' pomechena SERYM (otslezhivanie otklyucheno)" -ForegroundColor Yellow }
                'ungray' { Write-Host "  Kamera '$label' AKTIVIROVANA (otslezhivanie vklyucheno)"  -ForegroundColor Green  }
                'delete' { Write-Host "  Kamera '$label' UDALENA iz konfiga"                       -ForegroundColor Red    }
            }
        } elseif ($resStr -match '^noop\|(.+)\|(.+)$') {
            $lbl = ConvertTo-Translit $Matches[2]
            Write-Host "  Bez izmeneniy: $lbl" -ForegroundColor DarkGray
        } else {
            Write-Host "  $(ConvertTo-Translit $resStr)" -ForegroundColor Yellow
        }
        Start-Sleep -Seconds 1
    }
}

function Manage-GrayCameras {
    while ($true) {
        Clear-Host
        Write-Host ""
        Write-Host "  === Upravlenie kamerami ===" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  Seraya kamera = ne otslezhivaetsya v otchete i ne sozdaet zayavki v helpdesk" -ForegroundColor DarkGray
        Write-Host "  Udalenie     = sovsem ubirat kameru iz otcheta i konfiga"               -ForegroundColor DarkGray
        Write-Host ""

        $raw = & node "$ProjectDir\src\manage-cameras.mjs" list-systems 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  Oshibka: $raw" -ForegroundColor Red
            Read-Host "  Enter - nazad"
            return
        }

        $systems = @()
        foreach ($line in $raw) {
            if ($line -match '^([^|]+)\|([^|]+)\|(\d+)\|(\d+)$') {
                $systems += [pscustomobject]@{
                    Id    = $Matches[1]
                    Name  = $Matches[2]
                    Gray  = [int]$Matches[3]
                    Total = [int]$Matches[4]
                }
            }
        }

        if ($systems.Count -eq 0) {
            Write-Host "  Net sistem v config\systems.json" -ForegroundColor Yellow
            Read-Host "  Enter - nazad"
            return
        }

        $i = 1
        $map = @{}
        foreach ($s in $systems) {
            $num     = "{0,2}" -f $i
            $stats   = "(seryh: $($s.Gray) iz $($s.Total))"
            $nameTr  = ConvertTo-Translit $s.Name
            Write-Host "  $num  $nameTr" -NoNewline -ForegroundColor White
            Write-Host "  $stats" -ForegroundColor DarkGray
            $map[[string]$i] = $s
            $i++
        }

        Write-Host ""
        Write-Host "   A  Dobavit novoe ustroystvo (kameru ili registrator)" -ForegroundColor Green
        Write-Host "   0  Nazad" -ForegroundColor DarkGray
        Write-Host ""

        $ans = Read-Host "  Vyberi punkt"
        if ($ans -eq "0" -or -not $ans) { return }
        if ($ans -eq "A" -or $ans -eq "a") { Add-NewDevice; continue }
        if (-not $map.ContainsKey($ans)) {
            Write-Host "  Net takogo punkta" -ForegroundColor Red
            Start-Sleep -Seconds 1
            continue
        }

        $sys = $map[$ans]
        Manage-OneSystem -SysId $sys.Id -SysName $sys.Name
    }
}

# ─── Мастер «Добавить устройство» ────────────────────────────────────────────
#
# Пользователь вводит IP + (опционально) логин/пароль.
# Скрипт пробует определить тип через src/detect-device.js.
# В зависимости от типа — предлагает добавить как новую систему или
# в существующую (для одиночных Hikvision-камер — в систему hikvision-multi).
function Add-NewDevice {
    Clear-Host
    Write-Host ""
    Write-Host "  === Dobavit novoe ustroystvo ===" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Vvedite dannye, kotorye u vas est. Skript sam poprobuet" -ForegroundColor Gray
    Write-Host "  ponyat chto eto za ustroystvo (NVR/kamera/TRASSIR/...)." -ForegroundColor Gray
    Write-Host ""

    $ip = Read-Host "  IP-adres ili host (naprimer 192.168.1.45)"
    if (-not $ip) { return }

    $portInput = Read-Host "  HTTP-port (Enter = 80)"
    $port = if ($portInput) { $portInput } else { "80" }

    $user = Read-Host "  Login (Enter - bez avtorizatsii)"
    $pass = ""
    if ($user) {
        $secPass = Read-Host "  Parol" -AsSecureString
        $pass = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPass))
    }

    Write-Host ""
    Write-Host "  Proveryayu ustroystvo (eto zaymet 5-15 sek)..." -ForegroundColor Cyan
    $raw = & node "$ProjectDir\src\detect-device.js" $ip $port $user $pass 2>&1
    try {
        $info = ($raw -join "`n") | ConvertFrom-Json
    } catch {
        Write-Host "  Oshibka razbora otveta detektora:" -ForegroundColor Red
        Write-Host "  $raw" -ForegroundColor DarkGray
        Read-Host "  Enter..."
        return
    }

    if (-not $info.ok) {
        Write-Host ""
        Write-Host "  NE NAYDENO: $($info.error)" -ForegroundColor Red
        if ($info.probedPorts) {
            Write-Host "  Porty: HTTP=$($info.probedPorts.http) | 8080=$($info.probedPorts.trassir) | 554=$($info.probedPorts.rtsp)" -ForegroundColor DarkGray
        }
        Write-Host "  Proverte adres / set / kredsy i poprobyte snova." -ForegroundColor Gray
        Read-Host "  Enter..."
        return
    }

    # ── Показываем что обнаружили
    Write-Host ""
    Write-Host "  NAYDENO:" -ForegroundColor Green
    Write-Host "    Tip:     $($info.kind)" -ForegroundColor White
    if ($info.vendor)        { Write-Host "    Vendor:  $($info.vendor)" -ForegroundColor White }
    if ($info.model)         { Write-Host "    Model:   $($info.model)" -ForegroundColor White }
    if ($info.channelCount)  { Write-Host "    Kanalov: $($info.channelCount)" -ForegroundColor White }
    if ($info.notes)         { Write-Host "    Note:    $($info.notes)" -ForegroundColor DarkYellow }
    Write-Host ""

    # ── Имя системы / группа
    $sysName = Read-Host "  Imya obekta (kak budet v otchete)"
    if (-not $sysName) { Write-Host "  Otmena" -ForegroundColor Yellow; Read-Host "  Enter..."; return }

    Write-Host ""
    $groups = Get-Groups
    if ($groups.Count -eq 0) {
        Write-Host "  V .env ne zadan REPORT_GROUPS - gruppu vybrat ne iz chego" -ForegroundColor Yellow
        Read-Host "  Enter..."; return
    }
    $gi = 0
    foreach ($g in $groups) { $gi++; Write-Host ("  " + $gi + " = " + (ConvertTo-Translit $g)) -ForegroundColor Gray }
    $grpAns = Read-Host "  Vyberi gruppu (nomer)"
    $group = ""
    if ($grpAns -match '^\d+$' -and [int]$grpAns -ge 1 -and [int]$grpAns -le $groups.Count) {
        $group = $groups[[int]$grpAns - 1]
    }
    if (-not $group) { Write-Host "  Otmena (gruppa ne vybrana)" -ForegroundColor Yellow; Read-Host "  Enter..."; return }

    # ── Генерируем уникальный id для системы (latin slug по имени)
    $slug = ($sysName -replace '[^a-zA-Z0-9]+', '-').Trim('-').ToLower()
    if (-not $slug) { $slug = "obj-$([int](Get-Random -Maximum 9999))" }
    $envPrefix = ($slug -replace '-','_').ToUpper()

    # ── Записываем пароль в .env (если был указан)
    if ($user -and $pass) {
        $userKey = "${envPrefix}_USER"
        $passKey = "${envPrefix}_PASS"
        & node "$ProjectDir\src\manage-cameras.mjs" append-env $userKey $user | Out-Null
        & node "$ProjectDir\src\manage-cameras.mjs" append-env $passKey $pass | Out-Null
        Write-Host "  Kredsy zapisany v .env: $userKey / $passKey" -ForegroundColor DarkGray
    }

    # ── Готовим JSON для add-system в зависимости от обнаруженного типа
    $sysJson = $null
    switch ($info.suggestedSystemType) {
        'hikvision' {
            $sysJson = @{
                id = $slug; name = "$sysName"; group = $group
                type = 'hikvision'; enabled = $true
                displayMode = 'grid'; gridColumns = 4
                urlEnv = "${envPrefix}_URL"; userEnv = "${envPrefix}_USER"; passEnv = "${envPrefix}_PASS"
                maxChannelId = [int]$info.channelCount
            }
            & node "$ProjectDir\src\manage-cameras.mjs" append-env "${envPrefix}_URL" "http://${ip}:${port}/doc/page/login.asp" | Out-Null
        }
        'hiwatch' {
            $sysJson = @{
                id = $slug; name = "$sysName"; group = $group
                type = 'hiwatch'; enabled = $true
                displayMode = 'grid'; gridColumns = 4
                urlEnv = "${envPrefix}_URL"; userEnv = "${envPrefix}_USER"; passEnv = "${envPrefix}_PASS"
                maxChannelId = [int]$info.channelCount
            }
            & node "$ProjectDir\src\manage-cameras.mjs" append-env "${envPrefix}_URL" "http://${ip}:${port}/doc/page/login.asp" | Out-Null
        }
        'hikvision-multi' {
            # Одиночная Hikvision-камера — спросим, куда её добавить.
            Write-Host ""
            # Куда добавить: в существующую систему типа hikvision-multi
            # (её id берём из конфига — в меню имён объектов нет) или новой системой.
            $multi = @(Get-Systems | Where-Object { $_.type -eq 'hikvision-multi' })
            Write-Host ""
            Write-Host "  Eto odinochnaya kamera. Kuda dobavit?" -ForegroundColor Cyan
            $mi = 0
            foreach ($m in $multi) {
                $mi++
                Write-Host ("    " + $mi + "  V sistemu: " + (ConvertTo-Translit $m.name)) -ForegroundColor White
            }
            Write-Host "    N  Sozdat novuyu sistemu" -ForegroundColor White
            $where = Read-Host "  Vybor"
            if ($where -match '^\d+$' -and [int]$where -ge 1 -and [int]$where -le $multi.Count) {
                $targetId = $multi[[int]$where - 1].id
                $camJson = @{
                    name = $sysName; host = $ip; port = [int]$port
                    userEnv = "${envPrefix}_USER"; passEnv = "${envPrefix}_PASS"
                }
                $camJsonPath = Join-Path $env:TEMP "autocam-cam-$([int](Get-Random)).json"
                $camJson | ConvertTo-Json | Set-Content $camJsonPath -Encoding UTF8
                $r = & node "$ProjectDir\src\manage-cameras.mjs" add-cam $targetId $camJsonPath 2>&1
                Remove-Item $camJsonPath -ErrorAction SilentlyContinue
                Write-Host ""
                Write-Host "  $r" -ForegroundColor Green
                Read-Host "  Enter..."
                return
            }
            $sysJson = @{
                id = $slug; name = "$sysName"; group = $group
                type = 'hikvision-multi'; enabled = $true
                displayMode = 'grid'; gridColumns = 3
                cameras = @( @{
                    index = 0; name = $sysName; host = $ip; port = [int]$port
                    userEnv = "${envPrefix}_USER"; passEnv = "${envPrefix}_PASS"
                } )
            }
        }
        'trassir-sdk' {
            # Заполняем cameraGuids автоматически из info.cameras
            $guids = @{}
            foreach ($c in $info.cameras) { $guids[$c.guid] = $c.name }
            $sysJson = @{
                id = $slug; name = "$sysName"; group = $group
                type = 'trassir-sdk'; enabled = $true
                displayMode = 'grid'; gridColumns = 5
                host = $ip; port = [int]$info.portUsed
                userEnv = "${envPrefix}_USER"; passEnv = "${envPrefix}_PASS"
                cameraGuids = $guids
            }
        }
        'ipanda-rtsp' {
            # Обобщённый RTSP — спросим минимум полей
            $rtspPath = Read-Host "  RTSP-path dlya odnoy kamery (Enter = '/Streaming/Channels/101')"
            if (-not $rtspPath) { $rtspPath = "/Streaming/Channels/101" }
            $sysJson = @{
                id = $slug; name = "$sysName"; group = $group
                type = 'ipanda-rtsp'; enabled = $true
                displayMode = 'grid'; gridColumns = 3
                rtspUser = $user; rtspPass = $pass
                cameras = @( @{ index = 0; name = $sysName; ip = $ip; rtspPath = $rtspPath } )
            }
        }
        default {
            Write-Host "  Tip '$($info.suggestedSystemType)' poka ne avtomatiziruetsya v mastere." -ForegroundColor Yellow
            Write-Host "  Otredaktiruyte config/systems.json vruchnuyu." -ForegroundColor Gray
            Read-Host "  Enter..."
            return
        }
    }

    # ── Показать что собираемся создать и спросить подтверждение
    Write-Host ""
    Write-Host "  Budet sozdana takaya sistema:" -ForegroundColor Cyan
    $sysJson | ConvertTo-Json -Depth 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    Write-Host ""
    $confirm = Read-Host "  Sozdat? (yes/no)"
    if ($confirm -ne 'yes') {
        Write-Host "  Otmena" -ForegroundColor Yellow
        Read-Host "  Enter..."
        return
    }

    # ── Записываем
    $sysJsonPath = Join-Path $env:TEMP "autocam-sys-$([int](Get-Random)).json"
    $sysJson | ConvertTo-Json -Depth 5 | Set-Content $sysJsonPath -Encoding UTF8
    $result = & node "$ProjectDir\src\manage-cameras.mjs" add-system $sysJsonPath 2>&1
    Remove-Item $sysJsonPath -ErrorAction SilentlyContinue
    Write-Host ""
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  OK: $result" -ForegroundColor Green
        Write-Host "  Sistema dobavlena v config/systems.json." -ForegroundColor Green
        Write-Host "  Sleduyushchiy zapusk monitoringa uvidit ee avtomaticheski." -ForegroundColor Gray
    } else {
        Write-Host "  Oshibka: $result" -ForegroundColor Red
    }
    Read-Host "  Enter..."
}

function Open-LastReport {
    $report = Get-ChildItem "$ProjectDir\reports\report-*.html" -ErrorAction SilentlyContinue |
              Where-Object { $_.Name -match '^report-[\d\-]+\.html$' } |
              Sort-Object LastWriteTime -Descending |
              Select-Object -First 1
    if ($report) {
        Write-Host ""
        Write-Host "  Otchet: $($report.Name)" -ForegroundColor Green
        Start-Process $report.FullName
    }
}

function Open-LiveMonitor {
    $live = Join-Path $ProjectDir "reports\live.html"
    if (Test-Path $live) {
        Write-Host ""
        Write-Host "  Otkryvayu live-monitor (auto-refresh 30 sek)..." -ForegroundColor Yellow
        Start-Process $live
    } else {
        Write-Host ""
        Write-Host "  Net live.html. Zapustite proverku snachala (1, T ili odnu iz sistem)." -ForegroundColor Red
    }
}

function Run-PeriodReport {
    Write-Host ""
    Write-Host "  === Otchet za period ===" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Sobiraet zhurnal sboev kamer za vybrannye dni (vklyuchitelno)."
    Write-Host "  Dannye berutsya iz state/timeline-*.json (pishet light-progon, 15min)."
    Write-Host ""
    Write-Host "  Bystrye varianty:" -ForegroundColor Yellow
    Write-Host "    1  Za posledniy den (segodnya)"
    Write-Host "    2  Za posledniye 3 dnya"
    Write-Host "    3  Za posledniye 7 dney"
    Write-Host "    4  Za posledniye 30 dney"
    Write-Host "    5  Vvesti daty vruchnuyu (YYYY-MM-DD)"
    Write-Host ""
    $ans = Read-Host "  Vyberite (1-5) ili Enter dlya otmeny"
    if (-not $ans) { return }

    $today = Get-Date
    switch ($ans) {
        "1" { $from = $today; $to = $today }
        "2" { $from = $today.AddDays(-2); $to = $today }
        "3" { $from = $today.AddDays(-6); $to = $today }
        "4" { $from = $today.AddDays(-29); $to = $today }
        "5" {
            $fromStr = Read-Host "  S kakogo chisla (YYYY-MM-DD)"
            $toStr   = Read-Host "  Po kakoe chislo (YYYY-MM-DD)"
            try {
                $from = [datetime]::ParseExact($fromStr, 'yyyy-MM-dd', $null)
                $to   = [datetime]::ParseExact($toStr,   'yyyy-MM-dd', $null)
            } catch {
                Write-Host ""
                Write-Host "  Nepravilnyy format daty. Otmena." -ForegroundColor Red
                Read-Host "  Enter..."
                return
            }
        }
        default {
            Write-Host "  Otmena." -ForegroundColor DarkGray
            return
        }
    }

    $fromYmd = $from.ToString('yyyy-MM-dd')
    $toYmd   = $to.ToString('yyyy-MM-dd')

    Write-Host ""
    Write-Host "  Sobirayu otchet za $fromYmd -- $toYmd..." -ForegroundColor Yellow

    Push-Location $ProjectDir
    try {
        $out = & node src/period-report.js $fromYmd $toYmd 2>&1
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($code -ne 0) {
        Write-Host ""
        Write-Host "  Oshibka:" -ForegroundColor Red
        $out | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
        Read-Host "  Enter..."
        return
    }

    # period-report.js pechataet absolyutnyy put k HTML poslednem strokoy
    $path = ($out | Select-Object -Last 1).ToString().Trim()
    if (Test-Path $path) {
        Write-Host ""
        Write-Host "  Otchet sohranen: $path" -ForegroundColor Green
        Write-Host "  Otkryvayu v brauzere..." -ForegroundColor Yellow
        Start-Process $path
    } else {
        Write-Host ""
        Write-Host "  Skript otrabotal, no fayl ne nayden po puti: $path" -ForegroundColor Red
        Write-Host "  Vyvod skripta:"
        $out | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
    Write-Host ""
    Read-Host "  Enter..."
}

function Run-Check {
    param($OnlyId, [switch]$DryRun)
    Write-Host ""
    if ($OnlyId) {
        Write-Host "  Proverka: $OnlyId (bez otpravki email) ..." -ForegroundColor Cyan
        node src/index.js --dry-run --only $OnlyId
    } elseif ($DryRun) {
        Write-Host "  TESTOVAYA proverka VSEKH sistem (bez otpravki email) ..." -ForegroundColor Yellow
        node src/index.js --dry-run
    } else {
        Write-Host "  Polnaya proverka + otpravka email ..." -ForegroundColor Cyan
        node src/index.js
    }
    Open-LastReport
    Write-Host ""
    Write-Host "  Enter - nazad v menyu" -ForegroundColor DarkGray
    Read-Host
}

while ($true) {
    Show-Menu
    $choice = Read-Host "  Vyberi punkt"
    switch ($choice) {
        "1"  { Run-Check }
        "T"  { Run-Check -DryRun }
        "t"  { Run-Check -DryRun }
        # Пункты 2..N — объекты из config/systems.json (см. Show-Menu).
        { $_ -match '^\d+$' -and [int]$_ -ge 2 -and [int]$_ -le ($script:MenuSystems.Count + 1) } {
            Run-Check $script:MenuSystems[[int]$_ - 2].id
        }
        "R"  { Open-LastReport; Write-Host ""; Read-Host "  Enter..." }
        "r"  { Open-LastReport; Write-Host ""; Read-Host "  Enter..." }
        "V"  { Open-LiveMonitor; Write-Host ""; Read-Host "  Enter..." }
        "v"  { Open-LiveMonitor; Write-Host ""; Read-Host "  Enter..." }
        "H"  { Run-PeriodReport }
        "h"  { Run-PeriodReport }
        "L"  { Start-Process "$ProjectDir\logs" }
        "l"  { Start-Process "$ProjectDir\logs" }
        "S"  { Setup-Schedule }
        "s"  { Setup-Schedule }
        "E"  { Setup-Email }
        "e"  { Setup-Email }
        "G"  { Manage-GrayCameras }
        "g"  { Manage-GrayCameras }
        "0"  { exit }
    }
}
