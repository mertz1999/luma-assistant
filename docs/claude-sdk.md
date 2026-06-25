# Claude Agent SDK Reference

Source documentation:

- Documentation index: https://code.claude.com/docs/llms.txt
- TypeScript Agent SDK reference: https://code.claude.com/docs/en/agent-sdk/typescript.md
- Permissions reference: https://code.claude.com/docs/en/agent-sdk/permissions.md

This repo uses the TypeScript package:

```bash
npm install @anthropic-ai/claude-agent-sdk
```

The SDK bundles a native Claude Code binary as an optional platform dependency. Luma first tries `CLAUDE_CODE_EXECUTABLE`, then `claude` from `PATH`, then the bundled SDK binary.

## Luma Assistant Integration

Luma Assistant uses `query()` from `@anthropic-ai/claude-agent-sdk` as a second coding runner beside Codex.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt,
  options: {
    cwd: workspace,
    model,
    resume: sessionId,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt: { type: "preset", preset: "claude_code" },
    tools: { type: "preset", preset: "claude_code" },
  },
});
```

The SDK returns an async generator of `SDKMessage` objects. Luma maps those messages into its existing run lifecycle:

- `assistant` messages become assistant timeline messages.
- `result` messages update token usage and final run status.
- `session_id` values become Luma session/thread ids for resume.
- `AbortController` plus `query.close()` stops active Claude runs.

## Permissions

Normal Claude runs use:

```ts
permissionMode: "bypassPermissions"
allowDangerouslySkipPermissions: true
```

Plan-mode runs use:

```ts
permissionMode: "plan"
```

This preserves Luma's read-only planning workflow while allowing full autonomous execution for normal Claude Code sessions.

## Environment Variables

```env
DEFAULT_RUNNER=codex
CLAUDE_DEFAULT_MODEL=sonnet
CLAUDE_CODE_EXECUTABLE=
CLAUDE_AUTH_MODE=oauth
# CLAUDE_AUTH_MODE=api_key # intentionally use ANTHROPIC_API_KEY instead
```

Claude authentication is handled by Claude Code / the Anthropic SDK environment. The default `CLAUDE_AUTH_MODE=oauth` uses the logged-in Claude Code account and removes inherited `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_AGENT_SDK_CLIENT_APP` from the Claude subprocess. Set `CLAUDE_AUTH_MODE=api_key` when you intentionally want to use Anthropic API-key billing.

## Skills

Claude Code reads user skills from `~/.claude/skills/<slug>/SKILL.md` and project skills from `.claude/skills/<slug>/SKILL.md`. Luma syncs repo-managed `skills/**/SKILL.md` folders into `~/.claude/skills` on server startup and manual reload, using the same managed marker used for Codex skill sync. Selected skills are still injected into the prompt for the active turn so explicit selections work for both runners.
