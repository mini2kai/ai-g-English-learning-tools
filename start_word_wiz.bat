@echo off
REM Word Wiz for Kids - One-click launcher (Windows)
setlocal

set PORT=18080

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

echo 启动后端服务：http://localhost:%PORT%/
start "WordWiz Server" cmd /c "python server.py --port %PORT%"
timeout /t 2 >nul
start "" "http://localhost:%PORT%/"

echo 服务器已启动。若需停止，请关闭名为 “WordWiz Server” 的窗口。
pause


