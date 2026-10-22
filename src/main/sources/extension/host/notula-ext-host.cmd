@echo off
rem notula-ext-host: the browser extension's native-messaging host launcher (Windows). Written by Notula; do not edit.
rem It must print nothing: any stray byte on stdout breaks the browser's framing.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"__NOTULA_EXE__" "%~dp0notula-ext-host.cjs" %*
exit /b %ERRORLEVEL%
