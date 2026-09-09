@echo off
title OmniRoute Cookie Sync Bridge
echo Starting OmniRoute Cookie Sync Bridge on port 20129...
cd /d "%~dp0..\bridge"
node server.mjs
pause
