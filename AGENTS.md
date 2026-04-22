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
