@echo off
setlocal
set ROOT=%~dp0
set VERSION=8.9
set CACHE=%ROOT%.gradle-bootstrap
set DIST=%CACHE%\gradle-%VERSION%
set ZIP=%CACHE%\gradle-%VERSION%-bin.zip
if not exist "%DIST%\bin\gradle.bat" (
  if not exist "%CACHE%" mkdir "%CACHE%"
  if not exist "%ZIP%" powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing 'https://services.gradle.org/distributions/gradle-%VERSION%-bin.zip' -OutFile '%ZIP%'"
  powershell -NoProfile -Command "Expand-Archive -Force '%ZIP%' '%CACHE%\extract'"
  if exist "%DIST%" rmdir /s /q "%DIST%"
  move "%CACHE%\extract\gradle-%VERSION%" "%DIST%" >nul
)
call "%DIST%\bin\gradle.bat" --no-daemon :app:assembleDebug %*
