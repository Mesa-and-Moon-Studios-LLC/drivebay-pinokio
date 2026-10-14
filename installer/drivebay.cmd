@echo off
setlocal
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0launcher.mjs" %*
