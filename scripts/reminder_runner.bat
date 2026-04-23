@echo off
REM Abraham Portfolio — Market-open reminder runner.
REM Triggered by Windows Task Scheduler at 08:50 Taipei Mon-Fri.
REM Fetches fresh prices first, then sends Discord webhook reminder.

cd /d C:\Users\Adam\Abraham\abraham-portfolio

REM Force UTF-8 stdout so Chinese / emoji prints don't crash on cp1252 console.
set PYTHONIOENCODING=utf-8

REM Step 1: refresh portfolio snapshot (fetch_prices needs yfinance)
"C:\Users\Adam\AppData\Local\Programs\Python\Python312\python.exe" scripts\fetch_prices.py

REM Step 2: build + POST reminder to Discord webhook
"C:\Users\Adam\AppData\Local\Programs\Python\Python312\python.exe" scripts\market_reminder.py

exit /b %ERRORLEVEL%
