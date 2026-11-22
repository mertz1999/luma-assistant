# Projects and project memory

Projects group assistant sessions and provide shared instructions and reusable memories. The same backend and React controls run in the web application and Luma Desktop 0.2.0.

## Use projects

Use the sidebar's **New project** icon to create a project and click its folder to expand its sessions. Click the **+** on a project to start a session with that project selected. Use the project label in the chat header to move an inactive session. Unassigned chats appear under **Recents**. The **Filter sessions** icon applies to both project sessions and Recents.

The project selector does not grant filesystem access or change a session's workspace. Desktop folders must still be enabled through the native picker. A cloud project uses the server's workspaces; a local desktop project uses the Mac's workspaces.

Use **Project settings** to rename a project, edit project instructions, or turn agent memory editing on/off. Instructions are separate from learned memories and cannot be changed through memory tools. A schedule created while a project is selected keeps that project for its future executions.

## Use memory

Open **Project memory** above the conversation. Add facts, decisions, preferences, or lessons; search existing items; edit or remove them. Changes require a reason and optimistic revision checks. If another session changes an item while you edit, refresh/reopen the item before saving.

Every successful change appends an immutable revision containing before/after content, reason, timestamp, and author. Agent changes also record the stable Luma session ID and run ID. **Activity** lists changes from users and sessions. Item history supports **Undo last change** and **Restore this version**, both recorded as new revisions. Removing an item excludes it from subsequent search/context; **Show removed memories** and history keep it recoverable. Deletion does not remove text from older conversations or run contexts.

At the start of each new or resumed turn, Luma adds project instructions and a bounded selection of current memories to the runner prompt. Relevant title/content matches are ranked before recency; the agent can search and fetch additional items. Run context records identify exactly which memory revisions were included. Removed memories are not retrieved for later turns.

## Agent tools

The built-in `luma-memory` MCP service uses the existing API process at `/api/mcp/memory`. No extra MCP daemon or database server is required.

| Tool | Behavior |
| --- | --- |
| `memory_search` | Search active items in the session's project |
| `memory_get` | Read an item and its current revision |
| `memory_add` | Save a reusable item; identical active items are reused |
| `memory_update` | Change an item using `expectedRevision` |
| `memory_remove` | Soft-delete an item using `expectedRevision` |
| `memory_history` | Read immutable revision history |
| `memory_undo` | Undo the latest change or restore a historical revision |

Project identity and authorship come from a random run capability issued by Luma, not model-supplied project/session IDs. The capability is valid for that project and stable session only, expires after 24 hours at most, and is revoked when the run completes, fails, or stops. It cannot authenticate to normal password/JWT API routes. Changing session membership invalidates existing grants. Plan and Ask modes receive read-only memory access. Disabling agent editing is enforced immediately on the server, including already-running sessions. Human edits remain available.

Codex receives a run-specific HTTP MCP configuration and reads its bearer token from the run environment. Claude receives a private, owner-readable MCP config file, removed on normal run completion. Cursor gets a static user-level `luma-memory` entry whose URL and token are interpolated from the individual process environment; concurrent runs do not overwrite one another's credentials. Existing unmanaged Cursor entries are preserved; a conflicting `luma-memory` entry is reported instead of overwritten. The service is usable only with a valid Luma run capability. The same project memory tools are available to Codex, Claude, and Cursor in both Cloud and This Mac.

The memory boundary applies to Luma API/MCP access. Host filesystem access still follows each runner's execution permissions; an unrestricted server shell is not a separate tenant or container. The assistant continues to use the deployment's existing password/JWT identity model.

## Persistence and environment boundaries

Metadata, stable session aliases, memory items, immutable revisions, and run-context records live in `data/projects.sqlite`, or the configured `LUMA_DATA_DIR`. Schema creation is transactional and additive; the existing message database and session log format are not rewritten. Runner thread IDs become aliases of stable Luma IDs, preserving project membership and memory attribution across provisional sessions, resumes, and reruns.

Cloud and **This Mac** keep separate databases and project selections. This release does not automatically upload local project names, instructions, memories, folders, or transcripts to a cloud server. Cloud–Mac synchronization is a separate feature. Switching desktop connections continues to isolate browser storage and queued messages.

## Build, test, and deploy

```bash
npm install
npm run test:projects
npm run test:model-catalog
npm run typecheck
npm run build
```

Deploy the updated server and web build using the existing deployment workflow (`make deploy-start` on the deployment host). An old cloud server does not gain project APIs merely by installing the new desktop client.

```bash
npm run package -w @luma/desktop
```

Desktop installers are written under `apps/desktop/release/<version>/` and signed exclusively with Reza's configured Apple Development identity. Versioned release folders preserve older app binaries. The desktop package includes the shared server, memory MCP implementation, SQLite database driver, and web controls; it requires no separate development server.
