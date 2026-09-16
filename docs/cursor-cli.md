# Cursor Agent runner (Luma)

Luma can run [Cursor Agent CLI](https://cursor.com/docs/cli/overview) as a third runner beside Codex and Claude Code.

## Requirements

1. Cursor CLI available as `cursor` on `PATH`, or set `CURSOR_PATH` to the binary
   (macOS app path example: `/Applications/Cursor.app/Contents/Resources/app/bin/cursor`).
2. Auth via `CURSOR_API_KEY` (or `CURSOR_AUTH_TOKEN`), or a prior `cursor agent login` on the host.
3. Optional: `make ensure-cursor-mcp` / `make ensure-mcps` writes Luma MCP URLs into `~/.cursor/mcp.json`.

## How Luma invokes Cursor

```bash
cursor agent -p \
  --output-format stream-json \
  --stream-partial-output \
  --trust \
  --workspace <cwd> \
  --model <model or model[effort=high]> \
  --sandbox enabled|disabled \
  --approve-mcps \
  --force \
  [--plan | --mode ask] \
  [--resume <session_id>] \
  [--worktree] \
  "<prompt>"
```

Luma maps Cursor `stream-json` events into the same timeline shapes used for Claude/Codex (assistant messages, tool rows, turn completed).

## Models and effort

- Models are account-dependent. Luma loads them via `cursor agent --list-models` when authenticated (`GET /api/cursor/models` and bootstrap).
- Default model: `DEFAULT_CURSOR_MODEL` (default `composer-2.5`).
- Effort is **not** a separate Cursor CLI flag. When the selected model supports effort, Luma encodes it as a model bracket, e.g. `claude-opus-4-6[effort=high]`.
- Composer / Auto models typically have no effort control; the UI disables the effort selector.

## Plan / Ask modes

| Luma control | Cursor CLI |
|---|---|
| Plan mode (`/plan` or plan toggle) | `--plan` |
| Ask toggle (Cursor only) | `--mode ask` |
| Normal agent | (default) |

Plan and Ask force read-only sandbox + never approval policy, same as Codex/Claude plan mode.

## Skills and agents

Cursor does not load `~/.codex/skills` or `~/.claude/skills` natively.

Luma keeps parity by:

- injecting selected `SKILL.md` / `AGENT.md` content into the prompt (same as other runners)
- also discovering `~/.cursor/skills-cursor` when present

## MCP

`scripts/ensure-cursor-mcp.cjs` merges into `~/.cursor/mcp.json`:

- `luma-tel` → `http://127.0.0.1:9013/mcp`
- `luma-images` → `http://127.0.0.1:9015/mcp`
- optional `luma-tasks` when `ENABLE_TASK_MANAGER_MCP=1`

Non-interactive runs pass `--approve-mcps` (disable with `CURSOR_APPROVE_MCPS=0`).

## Env reference

```bash
DEFAULT_RUNNER=cursor
CURSOR_PATH=cursor
CURSOR_API_KEY=cursor_...
DEFAULT_CURSOR_MODEL=composer-2.5
CURSOR_FORCE=1
CURSOR_APPROVE_MCPS=1
CURSOR_WORKTREE=0
```

## Resume

Cursor emits `session_id` on stream events. Luma stores it as the session/thread id and passes `--resume <id>` on follow-up turns.

## Notes

- One shared `CURSOR_API_KEY` on the host bills that Cursor account for all Luma users.
- Cloud Agent / SDK handoff is optional future work; v1 uses local CLI only.
- Optional worktrees: set `CURSOR_WORKTREE=1` to pass `--worktree` on every Cursor run.
