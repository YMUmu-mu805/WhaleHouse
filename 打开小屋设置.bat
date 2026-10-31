@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo   WhaleHouse - 打开小屋设置
echo   ----------------------------------------
echo.

set "PORT=3210"
if exist "settings.json" (
  for /f "tokens=2 delims=:," %%a in ('findstr /i "uiPort" settings.json') do (
    set "P=%%a"
    set "P=!P: =!"
    if not "!P!"=="" set "PORT=!P!"
  )
)

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"

if not defined NODE_EXE (
  if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
    set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  )
)

if not defined NODE_EXE (
  if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar.unpacked\node.exe" (
    set "NODE_EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar.unpacked\node.exe"
  )
)

if not defined NODE_EXE (
  echo   [x] 没找到 node.exe
  echo.
  echo   这个包要有 Node.js 才能跑。装一个（https://nodejs.org）或者
  echo   把 DSH 里自带的 node 路径告诉我，我帮你改成写死的。
  echo.
  pause
  exit /b 1
)

echo   node: %NODE_EXE%
echo   端口: %PORT%
echo.
echo   正在打开设置界面...（关掉这个窗口就等于关掉服务）
echo.

start "WhaleHouse 小屋服务" /min "%NODE_EXE%" "src\ui.mjs"

rem 等它起来再开浏览器
for /l %%i in (1,1,20) do (
  timeout /t 1 >nul
  powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient('127.0.0.1',%PORT%)).Close(); exit 0 } catch { exit 1 }" >nul 2>nul && goto :opened
)
:opened

start "" "http://127.0.0.1:%PORT%/?panel=1&tab=layout"

echo   已打开：http://127.0.0.1:%PORT%/
echo   如果浏览器没自动弹出来，就把上面这个地址复制到浏览器里。
echo.
echo   设置完可以直接关掉浏览器；要停止服务，关掉那个最小化的
echo   「WhaleHouse 小屋服务」窗口（或者直接关这个窗口）。
echo.
pause
