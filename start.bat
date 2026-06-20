@echo off
rem Forge launcher - creates a venv on first run, installs deps, serves on 8191.
rem ComfyUI is expected separately on 127.0.0.1:8188 (edit in Settings).
setlocal
cd /d "%~dp0"

if not exist "venv\Scripts\python.exe" (
  echo Creating virtual environment...
  python -m venv venv
)

call "venv\Scripts\activate.bat"

echo Installing/refreshing dependencies...
python -m pip install --upgrade pip
pip install -r requirements.txt

echo.
echo Forge running at http://127.0.0.1:8191   (Ctrl+C to stop)
python -m forge_server.server %*

echo.
echo Server stopped. Press any key to close.
pause >nul
