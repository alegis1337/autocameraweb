@echo off
title AutoCamera Monitor
mode con: cols=60 lines=40
powershell.exe -NoExit -ExecutionPolicy Bypass -File "%~dp0menu.ps1"
