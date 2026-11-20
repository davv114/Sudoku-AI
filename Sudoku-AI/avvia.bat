@echo off
rem Avvia AI Sudoku Vision & Tutor con il server locale Python.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 server.py
) else (
  python server.py
)
pause
