@echo off
setlocal
cd /d "%~dp0"
python -m venv .build-env
if errorlevel 1 goto failure
.build-env\Scripts\python.exe -m pip install pyinstaller==6.22.2
if errorlevel 1 goto failure
.build-env\Scripts\python.exe build_windows.py
if errorlevel 1 goto failure
echo Build complete. Open the application folder in dist.
exit /b 0
:failure
echo Build failed. Python with Tcl/Tk is required.
pause
exit /b 1
