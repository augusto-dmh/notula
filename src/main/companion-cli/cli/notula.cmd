@echo off
rem notula: Notula's companion CLI launcher (Windows). Written by Notula; do not edit.
setlocal
set "NOTULA_EXE=__NOTULA_EXE__"
set "NOTULA_APP_ARGS=__NOTULA_APP_ARGS__"
__NOTULA_DEV_ENV__
where node >nul 2>nul || goto electron
node -e "process.exit(Number(process.versions.node.split('.')[0])>=18?0:1)" >nul 2>nul || goto electron
node "%~dp0notula-cli.cjs" %*
exit /b %ERRORLEVEL%
:electron
set "ELECTRON_RUN_AS_NODE=1"
"%NOTULA_EXE%" "%~dp0notula-cli.cjs" %*
exit /b %ERRORLEVEL%
