---
name: agent-creator
description: Use when a user wants to create, refine, or install a repo-owned Luma Assistant agent under agents/<slug>/AGENT.md. Gather missing requirements with concise questions, then produce a complete agent prompt defining main work, inputs, outputs, tools, operating rules, and validation.
---

# Agent Creator

Use this skill to help a user create a Luma Assistant agent for themselves.

## Goal

Create or update a repo-owned agent at:

```text
agents/<slug>/AGENT.md
```

The agent file must contain YAML frontmatter followed by the exact prompt the scheduled agent will run.

## Required Agent Definition

Before writing the agent, make sure these fields are known:

- Main work: the agent's primary job and success criteria.
- Input: what data, files, services, dates, or user-provided details the agent should use. Write "None" only when no input is needed.
- Output: the exact expected result format and delivery destination.
- Tools: required MCP tools, shell commands, web access, app connectors, or "No special tools".
- Schedule or trigger: when the agent should run, or whether it is manual only.
- Scope and boundaries: what the agent must not do.
- Failure behavior: what to report when inputs or tools are unavailable.

Useful optional fields:

- Audience or recipient.
- Tone and formatting.
- Timezone/date handling.
- Privacy or security constraints.
- Examples of good and bad outputs.
- Post-run actions, such as sending a Telegram message or writing a file.

## Clarifying Questions

If any required field is incomplete, ask concise questions before creating files. Prefer one short batch of questions, similar to plan mode, and continue after the user answers.

Ask only what changes the implementation. Do not ask about fields that are already clear from the request or repo context.

Use this style:

```markdown
I need these details before creating the agent:

1. What should the agent mainly do?
2. What input should it read or receive?
3. What output should it produce, and where should it deliver it?
4. Which tools or services may it use?
```

If the environment provides a structured user-input tool, use it for mutually exclusive choices when helpful. Otherwise ask normal chat questions.

## Creation Workflow

1. Inspect existing agents under `agents/` and follow the local `AGENT.md` style.
2. Pick a slug from the agent name using lowercase letters, numbers, and hyphens.
3. Create `agents/<slug>/AGENT.md`.
4. Include frontmatter:

```markdown
---
name: Human Friendly Name
description: One sentence describing what the agent does.
---
```

5. Write the prompt body with clear sections for objective, inputs, output, tools, workflow, rules, and failure behavior.
6. Keep instructions concrete enough that the scheduled run can execute without more context.
7. If the agent should use a repo skill, state that the schedule should select that skill in Luma Assistant.

## Prompt Template

```markdown
---
name: Agent Name
description: Short description.
---

You are my <role>.

Main work:
- <primary job>
- Success means <observable outcome>.

Input:
- <required input or None>

Output:
- <required format and destination>

Tools:
- <allowed or required tools>

Workflow:
1. <step>
2. <step>
3. <step>

Rules:
- Do not invent missing data.
- Ask for clarification when running interactively and required input is missing.
- For scheduled runs, report missing data clearly and stop instead of guessing.
- Do not modify external services unless the agent instructions explicitly allow it.

Failure behavior:
- If a required tool, file, or input is unavailable, report exactly what failed and what was attempted.
```

## Validation

After creating or updating an agent:

- Confirm the file path.
- Confirm all required fields are represented in the prompt.
- Run a lightweight check such as `find agents -name AGENT.md` or `sed -n` to verify the file is readable.
- Tell the user that Luma Assistant discovers agents from `agents/**/AGENT.md`; use the app reload control or restart the server if it is already running.
