@echo off
chcp 65001 >nul
rem Запуск редактора: start.bat <папка сайта>
where py >nul 2>nul && (py -3 "%~dp0afisha.py" %*) || (python "%~dp0afisha.py" %*)
if errorlevel 1 pause
