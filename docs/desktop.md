# Luma Desktop for macOS

The first desktop version reuses Luma's web UI and server, with separate Cloud and This Mac environments. No cloud address is bundled: enter your existing Luma HTTPS origin in Desktop settings and sign in with the server's normal password.

Download the Apple silicon preview and its checksum from [GitHub Releases](https://github.com/mertz1999/luma-assistant/releases).

## Build and run

```bash
npm install
npm run build -w @luma/desktop
npm run start -w @luma/desktop
```

`build` creates a development-signed `.app` under `apps/desktop/release/<version>/`. `npm run package -w @luma/desktop` also creates a DMG. The build uses `/Applications/Xcode.app/Contents/Developer` through `DEVELOPER_DIR`, without changing the system-wide Xcode selection.

Version 0.2.0 adds [projects and project memory](projects-memory.md), including session-managed memories, revision history, undo, and restoration. Cloud servers need the corresponding server/web update to expose those features in Cloud mode.

The signing identity is explicitly restricted to **Apple Development: reza.tz780210@gmail.com**, team **R4HM99JM59**. A missing identity fails the build; it never falls back to another account. The checked-in configuration does not use Hossein's identity. Development signing is intended for local testing. Public distribution still needs Reza's Developer ID Application certificate and notarization credentials.

Native SQLite and PTY dependencies are installed and rebuilt in a repository-specific staging directory under `~/Library/Caches/luma-desktop/`, outside npm's monorepo discovery. They use versions compatible with Electron's V8 runtime, independently of the web server's native dependencies. This preserves ordinary Node.js development and deployment.

## Local sessions

1. Open Luma Desktop and choose **This Mac**.
2. Choose a project folder through the native macOS folder picker.
3. Choose Codex, Claude Code, or Cursor Agent when creating a session. Select **workspace-write** or **read-only** in session settings.
4. Add or remove enabled folders in Desktop settings. Stop active local runs before removing a folder. Removing a folder restarts the engine to revoke open-terminal grants; existing chat history is retained.

The app detects Codex, Claude Code, and the standalone Cursor Agent CLI from the Mac's PATH and common install locations. Reopen Luma after installing a CLI. A missing CLI appears in Desktop settings. Install and sign in to Codex normally, then quit and reopen Luma. The app imports an existing file-based Codex login into private app storage without copying global MCP settings. File-based credentials are stored with owner-only permissions; Keychain-only provider logins are not imported in this version. If login needs refreshing, run `CODEX_HOME="$HOME/Library/Application Support/Luma Desktop/runtime/codex" codex login` in Terminal while Luma is closed.

Claude Code uses your regular CLI profile and macOS login Keychain. Sign in through `claude auth login` in Terminal. If you start Luma from a shell with `CLAUDE_CONFIG_DIR` set, Luma uses that profile. Existing Luma Claude transcripts are copied to the CLI profile when needed for resume. For [Cursor Agent](https://cursor.com/docs/cli/reference/authentication), copy the sign-in command under **Desktop settings → Local runners** into Terminal to sign in to Luma's separate Cursor profile. Choose your runner in **New session**.

Session smoke tests use deterministic CLI stubs.

Local history, settings, logs, and isolated runner state live under `~/Library/Application Support/Luma Desktop/`. Closing the window or switching to Cloud keeps the local engine running. Quitting Luma stops local runs and terminals. Local schedules need the app running and the Mac awake; missed-run catch-up and a separate always-on background service are not included.

## Connection isolation

The app serves its bundled interface through a secure `luma://` protocol. Each cloud origin receives a different hostname, separate from `luma://local`. Chromium therefore separates saved login tokens, queued prompts, and browser storage across connections. Changing environments reloads the interface and its query cache; sessions remain on their original backend. There is no automatic history or file synchronization.

Only API traffic is proxied to the selected endpoint; remote pages cannot acquire the desktop bridge. HTTPS cloud URLs cannot include credentials, paths, queries, or fragments. Redirected API requests fail rather than forwarding credentials to another origin. The loopback-only local backend uses a randomly generated password and JWT secret on each launch. Backend secrets are removed from agent and terminal environments. The renderer has context isolation and process sandboxing, no Node integration, a narrow validated IPC bridge, and a restrictive CSP.

Cloud sign-in stores a revocable session token in the connection's Chromium storage. The cloud server expires it after 48 hours of inactivity. Typing, clicking, and scrolling in Luma extend the session while the app is connected. Sign-out revokes it immediately on a reachable cloud server.

Open **Voice settings** from the sidebar menu or click **Set up dictation** in the composer. Enter the provider's HTTPS base URL, API key, and model ID. For Liara, use the base URL ending in `/v1` and model `openai/whisper-large-v3`. Luma adds `/audio/transcriptions` to the URL. Click **Record**, allow microphone access, speak, then stop to put the transcript in the editor. This Mac and Cloud each use their own provider settings. Cloud mode requires the updated server.

## Remote Macs

Remote access requires Luma Desktop 0.3.0 and the matching Luma Cloud release.

1. Sign in to the Luma Cloud PWA, open **Remote Macs** from the sidebar, and select **Pair a Mac**.
2. Open **Desktop settings → Remote access**. Enter the same Luma Cloud HTTPS URL, name the Mac, paste the one-time code, and choose which enabled folders to share. Select **Pair this Mac** within five minutes.
3. In the PWA, choose the Mac and open a session. Titles, statuses, and text messages refresh while the view is open.
4. To send follow-ups and stop runs, turn on **Allow sending messages and stopping runs from Luma Cloud** in Desktop settings and select **Save remote access**.
5. Choose **Unpair this Mac** in Desktop or **Remove Mac** in the PWA to revoke access.

The Mac opens an outbound WebSocket to `/api/remote/connect`. TLS reverse proxies must forward WebSocket upgrades to the Luma API. The cloud relay stores device registrations and short-lived pairing codes. It holds requests and responses in memory while forwarding them; session history stays in Desktop's database. The Mac uses its Keychain to encrypt the device credential. Existing sessions keep their Mac-side runner, project memory, workspace, and sandbox when you send a follow-up. The cloud view supports existing sessions and text follow-ups.

A paired Mac is accessible to signed-in members of that Luma Cloud instance. The current password sign-in represents a single shared account. Pair only to a cloud instance whose signed-in users are allowed to access the selected sessions.

Desktop reconnects after a network interruption. Keep the Mac awake and Luma Desktop running. Closing the window keeps remote access available until you quit the app.

## Folder enforcement and limits

The local API checks selected workspaces against the native picker allowlist and resolves attachment symlinks before accessing files. Agent subprocesses and terminals run under a macOS Seatbelt filesystem profile. Only the current workspace is granted project-content access. The profile also grants access to the current runner's profile, private temporary files, and required system/runtime directories. Read-only sessions cannot write project files. Unrestricted sessions are rejected. Luma applies the outer sandbox to all three runners.

This is a filesystem boundary, not network isolation or a virtual machine. Network/model access and OS services remain available; project tools and external services need their own trust review. macOS's `sandbox-exec` is required and the app fails closed if it is unavailable. Claude Code can read its global configuration and the login Keychain database. Codex and Cursor use app-private profiles. Review any project-owned agent/tool configuration before enabling a folder. System/runtime exceptions include `/System`, `/usr`, `/Library`, `/Applications`, `/opt`, and the runner's executable directory; avoid placing private projects in these runtime locations. Git can read its standard global configuration/ignore files, and Apple's command-line tools can maintain their narrowly named `xcrun_db-*` cache files. These exceptions do not grant access to other project folders.

## Validation

```bash
npm run test -w @luma/desktop
npm run typecheck
npm run test:model-catalog
```

Desktop tests check cloud URL validation, connection storage origins, private settings, canonical folders, symlink escapes, environment-secret filtering, and actual macOS sandbox read/write restrictions.
