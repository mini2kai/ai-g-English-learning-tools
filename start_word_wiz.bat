@echo off
REM Word Wiz for Kids - One-click launcher (Windows)
setlocal

set PORT=8080

REM Go to the directory of this script
cd /d "%~dp0"

REM Enter the site directory if nested
if exist "Demo2\index.html" (
  cd Demo2
)

REM Check Python
where python >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Python。请先安装 Python 3 并将其加入 PATH，然后重新运行此腳本。
  pause
  exit /b 1
)

echo 启动本地服务器：http://localhost:%PORT%/
REM Run server in a new console window so this script can also open the browser
start "WordWiz Server" cmd /c "python -m http.server %PORT%"
timeout /t 1 >nul
start "" "http://localhost:%PORT%/"

echo 服务器已启动。若需停止，请关闭名为 “WordWiz Server” 的窗口。
pause


