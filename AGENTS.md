# AGENTS.md

Use `config.yaml` as the source of truth for repo locations and default workspace.

## Config Path
- Primary fixed path: `~/config/agentic-assistant/config.yaml`

## Repo Discovery
- Read config from the fixed path first, then fallback to repo-local config if needed.
- Resolve repositories from `repos.<name>`.
- When a repo is requested by name (for example `atlas`, `coding`, `agentfa-admin`), use the mapped path from config.

## Default Workspace
- `default_workspace` in `config.yaml` defines the primary workspace path.
- If the user does not explicitly override workspace, operate in `default_workspace`.

## Scope and Safety
- Work only in the requested repo path from `config.yaml`.
- Do not modify other repos unless explicitly requested.
- Use absolute paths from `config.yaml` for file references and commands.

## Implementation Confirmation
- If the user does not explicitly ask for implementation, do not implement by default.
- First ask the user whether implementation is approved.
- If approval is not given, respond with explanation/guidance only and make no code changes.

## Atlas Remaining Tasks Workflow
- If the user asks for remaining tasks on any module:
- Locate the Atlas repository from `repos.atlas` in config.
- In Atlas, find the module folder under `bugs/` and `urgent/`.
- Also open `open_bugs.md`.
- List only tasks that are still open or pending.

- If the user asks to update task status:
- Use the same Atlas sources (`bugs/`, `urgent/`, and `open_bugs.md`).
- Update status in the related module files.
- Update the matching summary entries in `open_bugs.md`.
