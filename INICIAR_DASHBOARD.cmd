@echo off
setlocal
set "NODE_BIN=C:\Users\carlos.saraiva\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
set "PATH=%NODE_BIN%;%PATH%"
cd /d "%~dp0"

if not exist "%NODE_BIN%\node.exe" (
  echo Node.js do Codex nao foi encontrado em:
  echo %NODE_BIN%
  pause
  exit /b 1
)

echo Iniciando Dashboard de Operacoes...
echo Interface: http://localhost:3000
echo API:       http://127.0.0.1:8788
echo.
rem O servidor web pode j? estar aberto pelo Codex; n?o encerre a API se ele informar isso.
call node_modules\.bin\concurrently.cmd -n API,WEB -c blue,green "node server\index.mjs" "node_modules\.bin\vinext.cmd dev"
endlocal
