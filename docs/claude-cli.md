# Claude CLI Runner Reference

Source documentation:

- CLI reference: https://code.claude.com/docs/en/cli-reference
- Model and effort configuration: https://code.claude.com/docs/en/model-config
- Cost and thinking notes: https://code.claude.com/docs/en/costs

## Luma Assistant Integration

Luma Assistant runs Claude Code by spawning the `claude` CLI directly. The server uses `CLAUDE_CODE_EXECUTABLE` when set, otherwise `claude` from `PATH`.

New Claude turns use:

```bash
claude -p --output-format stream-json --verbose \
  --model "$CLAUDE_MODEL" \
  --tools default \
  --permission-mode bypassPermissions \
  --allow-dangerously-skip-permissions \
  -- "$PROMPT"
```

Resume turns add:

```bash
--resume "$SESSION_ID"
```

Luma stores every raw stream JSON line and stderr line in the run event log. It also maps known Claude messages into the shared chat pipeline:

- `system/init` messages provide the Claude session id for Luma resume.
- `assistant` text becomes assistant chat output.
- Visible `thinking` blocks become reasoning entries.
- `tool_use` blocks become command/tool status entries.
- `user` `tool_result` blocks complete command/tool entries with output.
- `result` messages update usage, summary, final status, and permission denials.

## Permissions

Non-plan Claude runs always use:

```bash
--permission-mode bypassPermissions \
--allow-dangerously-skip-permissions
```

On hosts that run Luma as root, set `CLAUDE_BYPASS_AS_ROOT=1` in `.env`. Luma then sets `IS_SANDBOX=1` in the Claude subprocess environment so Claude Code accepts `bypassPermissions`.

Plan-mode runs use Luma's shared `plan.md` prompt wrapper, matching the Codex runner. Luma normalizes the run config to read-only planning semantics and sends Claude the same plan instructions from the repository root:

```bash
--permission-mode dontAsk \
--allowedTools Read,Glob,Grep \
--disallowedTools Bash,Edit,Write,NotebookEdit,ExitPlanMode,EnterPlanMode,Task,TaskOutput,TodoWrite,WebFetch,WebSearch,KillShell,Skill,SlashCommand
```

This avoids Claude Code's native `ExitPlanMode` workflow and keeps planning output controlled by `plan.md`. The Approvals dock was removed; Codex uses `approval_policy=never` with `danger-full-access` by default.

## Effort

Current Claude Code docs document `--effort` and `CLAUDE_CODE_EFFORT_LEVEL`. Luma probes the installed CLI once:

- If `--effort` is accepted, Luma passes the selected effort as a CLI flag.
- If the CLI rejects `--effort`, Luma sets `CLAUDE_CODE_EFFORT_LEVEL=<effort>` and emits a run-log warning because older CLI builds may not enforce the setting.

Luma only captures thinking summaries or thinking blocks emitted by Claude Code. It does not expose hidden chain-of-thought.

## Environment Variables

```env
DEFAULT_RUNNER=codex
CLAUDE_DEFAULT_MODEL=sonnet
CLAUDE_CODE_EXECUTABLE=
CLAUDE_AUTH_MODE=oauth
# CLAUDE_AUTH_MODE=api_key # intentionally use ANTHROPIC_API_KEY instead
# Required when the Luma server process runs as root:
# CLAUDE_BYPASS_AS_ROOT=1
```

The default `CLAUDE_AUTH_MODE=oauth` uses the logged-in Claude Code account and removes inherited `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_AGENT_SDK_CLIENT_APP` from the Claude subprocess. Set `CLAUDE_AUTH_MODE=api_key` when you intentionally want to use Anthropic API-key billing.

## Skills

Claude Code reads user skills from `~/.claude/skills/<slug>/SKILL.md` and project skills from `.claude/skills/<slug>/SKILL.md`. Luma syncs repo-managed `skills/**/SKILL.md` folders into `~/.claude/skills` on server startup and manual reload, using the same managed marker used for Codex skill sync. Selected skills are still injected into the prompt for the active turn so explicit selections work for both runners.
