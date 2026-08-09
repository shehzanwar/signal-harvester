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

REM Root cause, found by actually isolating it rather than guessing further
REM (two earlier attempts here — a timestamped file inside logs\, then
REM %TEMP% instead — both still failed intermittently, which ruled out
REM "something external watches the logs\ folder"): the health-check step
REM and the pipeline step were both appending to the SAME log file back to
REM back. PowerShell's file handle on that shared file isn't always fully
REM released by the time cmd.exe opens it again a moment later for the
REM very next command's `>>` redirect — a plain race condition between two
REM processes, not an external lock at all. Proven by direct isolation:
REM the exact pipeline command run standalone (no preceding writer to the
REM same file) succeeded every time; only the back-to-back sequence into
REM one shared file failed. Fix: give each step its OWN log file, so
REM there's never a shared handle to race on. Still timestamped (not a
REM fixed name) and still retried below as cheap, harmless defense in
REM depth — but the separate-files change is what actually fixes this.
SET LOGSTAMP=
FOR /F "usebackq delims=" %%T IN (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"`) DO SET LOGSTAMP=%%T
IF "%LOGSTAMP%"=="" SET LOGSTAMP=unknown-%RANDOM%
SET HEALTHTEMPLOG=%TEMP%\signalharvester-healthcheck-%LOGSTAMP%.log
SET PIPETEMPLOG=%TEMP%\signalharvester-pipeline-%LOGSTAMP%.log
SET HEALTHLOGFILE=logs\healthcheck-%LOGSTAMP%.log
SET LOGFILE=logs\pipeline-run-%LOGSTAMP%.log

ECHO.
ECHO [1/5] Checking llama-server is up... (log: %HEALTHTEMPLOG%)
REM Replaces the old every-5-minutes watchdog scheduled task (which polled
REM whether the backend was healthy 24/7, whether or not a run was about
REM to happen) with a single check right before the one time per day it
REM actually matters. Same script, same restart-if-down logic — just
REM invoked here instead of on its own recurring trigger. If llama-server
REM was down and needs a fresh model load, this blocks until it's back
REM (or gives up) so the pipeline run right after doesn't start against a
REM backend still warming up.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%\scripts\ensure_llamaserver.ps1" >> "%HEALTHTEMPLOG%" 2>&1

ECHO.
ECHO [2/5] Running pipeline...
REM Task Scheduler's "Start a Program" action does not capture stdout/stderr
REM on its own -- without this redirect, a scheduled run's pipeline output
REM (including stage-by-stage social/comments logging) is discarded entirely
REM and unrecoverable after the fact. See %PIPETEMPLOG%.
REM
REM Retried up to 3x with a short pause -- cheap defense in depth in case
REM of a genuine transient issue. A failed `>>` redirect setup doesn't run
REM the command AND doesn't set a nonzero ERRORLEVEL, so this class of
REM failure needs its own detection (log file missing/empty), not just
REM `IF ERRORLEVEL 1` -- that check alone let this run silently for 3 days
REM straight the first time this was investigated. `ping -n` is used for
REM the delay, not TIMEOUT -- Git for Windows' own `timeout` (GNU
REM coreutils, incompatible /T flag) can shadow cmd's built-in on PATH
REM depending on how this script is invoked.
SET PIPELINE_ATTEMPT=0
:RETRY_PIPELINE
SET /A PIPELINE_ATTEMPT+=1
python -m harvester --profile "%PROFILE%" run >> "%PIPETEMPLOG%" 2>&1
SET PIPELINE_OK=1
IF NOT EXIST "%PIPETEMPLOG%" SET PIPELINE_OK=0
IF "%PIPELINE_OK%"=="1" FOR %%S IN ("%PIPETEMPLOG%") DO IF %%~zS EQU 0 SET PIPELINE_OK=0
IF "%PIPELINE_OK%"=="0" (
    IF %PIPELINE_ATTEMPT% LSS 3 (
        ECHO Pipeline did not run ^(attempt %PIPELINE_ATTEMPT%/3, log missing or empty^) -- retrying in 20s...
        ping -n 21 127.0.0.1 >NUL
        GOTO RETRY_PIPELINE
    )
    ECHO Pipeline did not run after 3 attempts -- %PIPETEMPLOG% was never created or stayed empty. Aborting publish.
    EXIT /B 1
)
IF ERRORLEVEL 1 (
    ECHO Pipeline failed. See %PIPETEMPLOG%. Aborting publish.
    EXIT /B 1
)

REM Archive both logs into the repo's logs\ folder, best-effort -- a
REM failure here means the run still succeeded, just isn't archived.
IF NOT EXIST "logs" MKDIR "logs" >NUL 2>&1
COPY /Y "%HEALTHTEMPLOG%" "%HEALTHLOGFILE%" >NUL 2>&1
COPY /Y "%PIPETEMPLOG%" "%LOGFILE%" >NUL 2>&1

ECHO.
ECHO [3/5] Building static frontend...
CD "%PROJECT_DIR%\frontend"
CALL npm run build:static
IF ERRORLEVEL 1 (
    ECHO Frontend build failed. Aborting publish.
    EXIT /B 1
)
CD /D "%PROJECT_DIR%"

ECHO.
ECHO [4/5] Exporting data to site/...
python -m harvester --profile "%PROFILE%" export --out site
IF ERRORLEVEL 1 (
    ECHO Export failed. Aborting publish.
    EXIT /B 1
)

ECHO.
ECHO [5/5] Committing and pushing site/...
git add site/
git commit -m "snapshot: %DATE% %TIME%"
git push origin main
IF ERRORLEVEL 1 (
    ECHO Git push failed. Check your remote is configured.
    EXIT /B 1
)

ECHO.
ECHO Publish complete.
DEACTIVATE
