# Launched at user logon via a Windows Startup-folder shortcut/.cmd
# ("Luma Assistant.cmd" in shell:startup) -- NOT a Task Scheduler task.
# Registering an actual Scheduled Task was tried first and requires
# elevated privileges this account does not have ("Access is denied"
# from both Register-ScheduledTask and schtasks /Create); the Startup
# folder is the standard unprivileged per-user alternative. Runs in the
# interactive user's own session so PATH picks up the same
# node/npm/codex/claude the user already has configured -- Codex and
# Claude Code are only ever resolved from PATH (or CODEX_PATH /
# CLAUDE_CODE_EXECUTABLE in .env), never hardcoded.
#
# Rotates PM2's operational stdout/stderr logs BEFORE (re)starting, so a
# log file that grew large while the machine was last on never keeps
# growing unbounded across a logon cycle. Uses rotate-logs.cjs, not
# `pm2 install pm2-logrotate` -- that install fails inside npm's own
# installer on this machine (reproduced: a shell-quoting bug in PM2's
# module-installer truncates the path at the space in this account's
# profile directory, "C:\Users\it hp"), a third-party bug unrelated to
# this repo's own code. rotate-logs.cjs also safely reloads PM2's log
# handles afterward if PM2 was already running (see its own header).
#
# `pm2 resurrect` replays the process list saved by the last `pm2 save`
# (dump.pm2). It is a no-op if those processes are already running
# (PM2 is single-daemon-per-Windows-account via %HOMEPATH%\.pm2), so
# this script is safe to invoke more than once -- e.g. if it also fires
# after an unexpected PM2 daemon restart, or is run manually to verify
# the registration works.
#
# To update what starts: `pm2 startOrReload scripts\pm2\ecosystem.config.cjs`
# then `pm2 save` again from a normal shell -- this script does not need
# to change.

$ErrorActionPreference = 'Stop'
Set-Location -Path (Join-Path $PSScriptRoot '..\..')
& node scripts\pm2\rotate-logs.cjs
& npx pm2 resurrect
