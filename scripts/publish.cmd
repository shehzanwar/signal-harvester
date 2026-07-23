@echo off
REM End-to-end publish: run pipeline -> build static site -> export data -> git push
REM
REM Prerequisites:
REM   1. git init && git remote add origin <your-github-url>
REM   2. npm install in frontend/ (done once)
REM   3. Create a gh-pages or Cloudflare Pages branch targeting site/
REM
REM Usage:
REM   scripts\publish.cmd                         (uses default profile)
REM   scripts\publish.cmd configs\profiles\foo.yaml

SET PROJECT_DIR=%~dp0..
SET VENV=%PROJECT_DIR%\.venv
SET PROFILE=%~1
IF "%PROFILE%"=="" SET PROFILE=configs\profiles\daily-briefing.yaml

CD /D "%PROJECT_DIR%"

IF NOT EXIST "%VENV%\Scripts\activate.bat" (
    ECHO ERROR: Virtual environment not found. Run: python -m venv .venv ^&^& .venv\Scripts\pip install -e .[dev]
    EXIT /B 1
)

CALL "%VENV%\Scripts\activate.bat"

ECHO.
ECHO [1/4] Running pipeline...
python -m harvester --profile "%PROFILE%" run
IF ERRORLEVEL 1 (
    ECHO Pipeline failed. Aborting publish.
    EXIT /B 1
)

ECHO.
ECHO [2/4] Building static frontend...
CD "%PROJECT_DIR%\frontend"
CALL npm run build:static
IF ERRORLEVEL 1 (
    ECHO Frontend build failed. Aborting publish.
    EXIT /B 1
)
CD /D "%PROJECT_DIR%"

ECHO.
ECHO [3/4] Exporting data to site/...
python -m harvester --profile "%PROFILE%" export --out site
IF ERRORLEVEL 1 (
    ECHO Export failed. Aborting publish.
    EXIT /B 1
)

ECHO.
ECHO [4/4] Committing and pushing site/...
git add site/
git commit -m "snapshot: %DATE% %TIME%"
git push
IF ERRORLEVEL 1 (
    ECHO Git push failed. Check your remote is configured.
    EXIT /B 1
)

ECHO.
ECHO Publish complete.
DEACTIVATE
