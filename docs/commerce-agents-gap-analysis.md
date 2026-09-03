# commerce-agents gap analysis

Reference: [anthropics/commerce-agents](https://github.com/anthropics/commerce-agents), commit
`fd4d59224ab96b43c6dc6888207c67b3bd5a24cf`, Apache-2.0, retrieved 2026-09-03. Cloned to
`C:\projects\references\commerce-agents` (outside both this repo and Dalil, not committed here).

Inspected directly: `docs/safety.md`, `commerce-common/commerce_common/fencing.py`,
`commerce-common/commerce_common/execution.py`, `merchant-agent/core/merchant_agent/gates.py`.
Not marketing copy — the actual source.

## The one fact that shapes every row below

commerce-agents owns its entire agent loop: it defines its own tool schemas, and every tool
call is dispatched through its own `execution.py`/`executor.py`, which can hold, deny, or
rewrite the call *before* it runs and feed a structured result back to the model. That is
what makes fencing, provenance gates, and staged-write approval possible in one place.

Luma does not own an agent loop. It spawns the Codex CLI or the Claude Code CLI as an
external subprocess and lets that CLI run its own built-in tool loop (its own Read, Write,
Bash, WebFetch, etc.). Luma has no visibility into, or control over, an individual tool call
inside that loop. It only controls: the prompt text it constructs before spawning, and
whichever MCP servers it registers for the run (`luma-tel`, `luma-images`, `luma-taskmanager`
— Luma's own code) — plus the process itself (start, kill, timeout).

This single architectural fact is why most commerce-agents patterns below are marked
**NOT BOUNDED AT THIS LAYER** rather than implemented as a weaker imitation. Building a real
per-tool-call interception layer for Codex/Claude's native tools would mean replacing their
built-in Read/Write/Bash/WebFetch with Luma-mediated equivalents — i.e., building a second
agent framework, which this mission explicitly forbids.

## Gap matrix

| Pattern | commerce-agents approach | Luma equivalent | Status | Gap? | Decision |
|---|---|---|---|---|---|
| Third-party content fencing | Every tool result and retrieved page is sanitized (strips invisible/control chars, forged turn markers, transcript tags) and wrapped in a source-literal fence before the model reads it (`fencing.py`) | **None** for content Codex/Claude's own WebFetch/Read tools retrieve (invisible to Luma). **None** for `apps/telegram-mcp`'s `get_last_uploaded_file`, which returns raw bytes of an uploaded document — from any Telegram user who can message the configured chat — as a tool result with zero sanitization, only a byte-length cap | **ABSENT** (for the one surface Luma's own code controls) | **YES — real, concrete, exploitable** | **IMPLEMENT** (P0, scoped to Luma-authored MCP tool results, starting with telegram-mcp) |
| Provenance-gated sensitive writes | A tool call that writes (add-to-cart, stage a price change) is checked against ids the model actually observed via a tool result *this session*, tracked in session state (`gates.py`) | None — Luma cannot see individual `Edit`/`Write`/`git commit` calls inside Codex/Claude's own loop to gate them | **ABSENT** | Real, but **NOT BOUNDED AT THIS LAYER** — the gate has to sit between the model and the write tool; Luma isn't there | **DO NOT IMPLEMENT.** A weaker after-the-fact heuristic (diff the commit against some "observed" set) would be security theater, not a real gate. Dalil's own corrections-log convention (`/content/corrections/`) is the actual mitigation in place today, enforced by prompt instruction + human review of local commits before push, same as everything else |
| Staged changes + approval boundary | `apply_change` succeeds only for change ids a human marked approved through a portal/host route (`require_host_approval`) | Luma already has an unconditional, structural version: every mission produces only **local commits**; push/deploy/publish are never performed by any Luma-spawned process, full stop — verified repeatedly by live denial tests | **PARTIAL, but stronger in the relevant sense** — commerce-agents stages because it *can* apply; Luma never reaches "apply" at all | Not a gap for Dalil's actual risk model | **NOT NEEDED.** Adding an explicit `STAGED`/`AWAITING_APPROVAL` mission-state enum would be state for its own sake — nothing currently reads it, and the real boundary (no push/deploy code path exists) is already unconditional, not merely gated |
| Mechanical approval token for production actions | N/A directly (commerce-agents' "production action" is `apply_change`, gated by the host's approval mark) | Push/deploy denial is **prompt-based only** (documented honestly in the prior mission's report) | **ABSENT**, confirmed | Real, but the only way to make it mechanical is to intercept `git push` specifically inside a subprocess Luma doesn't control — same class of problem as provenance gating | **DO NOT IMPLEMENT** this mission. (A future, genuinely bounded option — never explored yet — would be running scheduled Dalil missions against a git remote with no push access at all, so a `git push` simply fails on its own rather than needing interception. Left as a documented idea, not built.) |
| Runtime-independent action contracts | One tool/action definition shared by all three commerce-agents runtimes | Both Codex and Claude get the same `RunConfig`/`policy-engine`/`resource-watchdog`/`credential-store` checks inside `startRun` — one call path, not duplicated per runner | **VERIFIED EQUIVALENT** | No | No action |
| Capability switches | Unavailable backend actions are removed from the tool list entirely, not just told "no" | MCP servers are opt-in per project via `.env` (`ENABLE_TASK_MANAGER_MCP`, `TELEGRAM_MCP_*`, `IMAGE_MCP_*`); `sandbox` (`read-only`/`workspace-write`/`danger-full-access`) is a real, enforced mode, not a prompt suggestion | **VERIFIED EQUIVALENT** for what Luma actually controls (which MCP servers exist, what the filesystem sandbox allows) | No — Dalil has no finer-grained action surface than that to switch | No action |
| Bounded tool/agent loops | `max_tool_iterations`, `max_search_results`, `compact_history_above_tokens`, wall-clock and per-turn budgets on the analysis delegate | `MAX_CONCURRENT_RUNS` caps how many runs can be active *simultaneously*. **Nothing caps how long any single run may execute.** Confirmed by reading `startRun`/the spawn path directly: no timeout, no `setTimeout`-based kill, no max-duration constant anywhere in `apps/server/src/index.ts` | **ABSENT** | **YES — real, and directly dangerous for unattended scheduled Dalil missions**: a stuck run would hold the mutation-lock on `C:\Dalilfinance` forever, silently, with nobody watching | **IMPLEMENT** (P1) |
| No-progress detection | N/A explicitly in commerce-agents (its bound is turn/token count, not semantic repetition) | None | ABSENT | Real but unbounded to implement well (defining "no progress" for an arbitrary coding-agent transcript is not a small, testable rule) | **NOT IMPLEMENTED this mission** — the max-duration cap below is the bounded, testable version of the same underlying risk (a run that never ends), without needing to parse the run's own semantics |
| Memory/mission-state validation | A recovered session re-validates rather than trusting persisted authority | `reconcileStaleRunPid` (crash recovery) and `evaluateRunStartPolicy`/`evaluateResourcePolicy` (re-run on every `startRun` call, including scheduled/rerun paths, not just the HTTP route) already do exactly this — verified by direct code reading in the prior mission and by tests | **VERIFIED EQUIVALENT** | No | No action |
| Host-authored business rules | Business rules live in code (`gates.py`, `config.py`), not model reasoning | Documented honestly in the prior mission: workspace isolation, credential isolation, and the new one-mutating-run-per-workspace guard are **mechanical**; "no push/no deploy/no fabricated data" are **prompt-only** | Mixed, already correctly classified | Already covered by the two rows above (provenance, approval token) | No new action — already documented, not re-litigated here |
| Event normalization | Structured events across all three runtimes | The hash-chained audit log already emits the same event shapes (`run.created`, `policy.decision`, `resource.decision`, `run.process_started`, `run.process_terminated`, `mission.*`, now `workspace.mutation_lock`) regardless of `runner` — verified live for both a Codex run and (via unit tests resolving the real Claude CLI) the Claude path | **VERIFIED EQUIVALENT** | No | No action |

## Decision

Two genuine, bounded gaps identified. Implementing both, one at a time, each with its own
tests, live verification, and commit:

1. **P0 — Third-party content fencing** for `apps/telegram-mcp`'s `get_last_uploaded_file`,
   via a new shared `packages/shared/src/fencing.ts` (independently written in TypeScript,
   not ported from the Python reference — the *concept* is credited, the code is not copied).
2. **P1 — Maximum run duration**, a real wall-clock cap on spawned Codex/Claude processes,
   force-terminated via the already-tested `killProcessTree`, audited, and dogfooded through
   a real scheduled Dalil mission (this one *is* Dalil-relevant — every Dalil scheduled
   mission benefits, since none of them use Telegram).

Everything else in the table above is either already equivalent, structurally unreachable at
Luma's orchestration layer without building a second agent framework (explicitly forbidden),
or not a real gap for Dalil's actual risk model. Not implementing them is the correct call,
not a shortfall.
