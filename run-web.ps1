# run-web.ps1 — запуск веб-интерфейса карты (v3).
#
# Веб-сервер, в отличие от прогонов мониторинга, живёт постоянно: его ставят
# в Планировщик на триггер «при запуске системы» с перезапуском при сбое,
# а не на расписание.
#
# Локально: .\run-web.ps1  (Ctrl+C — остановка)
#
# --disable-warning гасит ExperimentalWarning от node:sqlite: модуль встроенный
# и стабильно работает, но помечен экспериментальным и иначе шумит в логе.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
& node --disable-warning=ExperimentalWarning server/app.js
exit $LASTEXITCODE
