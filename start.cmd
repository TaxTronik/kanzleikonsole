@echo off
REM ============================================================================
REM TaxTronik — Ein-Klick-Start (Windows). Einfach doppelklicken.
REM Faehrt den ganzen Stack containerisiert hoch (Docker Desktop vorausgesetzt).
REM Argumente werden durchgereicht, z. B.:  start.cmd -Build
REM ============================================================================
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\win\Start-TaxTronik.ps1" %*
echo.
pause
