@echo off
REM Republish the GitHub Pages snapshot from the CURRENT database/frontend
REM state, without re-running the pipeline (fetch/extract/enrich). Use this
REM after a code-only change (prompt, UI, config) that doesn't need a fresh
REM pipeline run but must still reach shehzanwar.github.io/signal-harvester
REM -- the live Docker dashboard (frontend/dist/, mounted into the
REM container) updates immediately on `npm run build` and does NOT need
REM this script; only the static site/ snapshot requires this explicit step.
REM
REM For a full cycle (pipeline + publish), use publish.cmd instead.
REM
REM Usage:
REM   scripts\publish_site.cmd                         (uses default profile)
REM   scripts\publish_site.cmd configs\profiles\foo.yaml

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
ECHO [1/3] Building static frontend...
CD "%PROJECT_DIR%\frontend"
CALL npm run build:static
IF ERRORLEVEL 1 (
    ECHO Frontend build failed. Aborting publish.
    EXIT /B 1
)
CD /D "%PROJECT_DIR%"

ECHO.
ECHO [2/3] Exporting data to site/...
python -m harvester --profile "%PROFILE%" export --out site
IF ERRORLEVEL 1 (
    ECHO Export failed. Aborting publish.
    EXIT /B 1
)

ECHO.
ECHO [3/3] Committing and pushing site/...
git add site/
git commit -m "snapshot: %DATE% %TIME%"
IF ERRORLEVEL 1 (
    ECHO Nothing to commit -- site/ already up to date.
    EXIT /B 0
)
git push origin main
IF ERRORLEVEL 1 (
    ECHO Git push failed. Check your remote is configured.
    EXIT /B 1
)

ECHO.
ECHO Site published.
DEACTIVATE
