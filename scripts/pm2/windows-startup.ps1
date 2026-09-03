# Resurrects the PM2-managed Luma Assistant process list at user logon.
#
# Registered as a Windows Task Scheduler task named "Luma Assistant",
# trigger "At log on" for this user, action running this script via
# powershell.exe. Runs in the interactive user's own session (not
# "whether user is logged on or not") so PATH picks up the same
# node/npm/codex/claude the user already has configured -- Codex and
# Claude Code are only ever resolved from PATH (or CODEX_PATH /
# CLAUDE_CODE_EXECUTABLE in .env), never hardcoded.
#
# `pm2 resurrect` replays the process list saved by the last `pm2 save`
# (dump.pm2). It is a no-op if those processes are already running
# (PM2 is single-daemon-per-Windows-account via %HOMEPATH%\.pm2), so
# this script is safe to invoke more than once -- e.g. if the task also
# fires after an unexpected PM2 daemon restart, or if it is run
# manually to verify the registration works.
#
# To update what starts: `pm2 startOrReload scripts\pm2\ecosystem.config.cjs`
# then `pm2 save` again from a normal shell -- this script does not need
# to change.

$ErrorActionPreference = 'Stop'
Set-Location -Path (Join-Path $PSScriptRoot '..\..')
& npx pm2 resurrect
