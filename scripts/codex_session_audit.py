#!/usr/bin/env python3
"""Generate a compact Markdown audit of recent Codex session token usage."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


TOKEN_PREVIEW_RE = re.compile(
    r"Tokens:\s*in\s+([0-9,]+),\s*out\s+([0-9,]+),\s*cached\s+([0-9,]+)"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session-index", default="/home/agentic-assistant/data/session-index.json")
    parser.add_argument("--codex-sessions-root", default="/root/.codex/sessions")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--include-running", action="store_true")
    parser.add_argument("--output", default="/home/agentic-assistant/reports/codex-session-token-audit-2026-06-21.md")
    parser.add_argument("--session-id", action="append", default=[])
    return parser.parse_args()


def utc_from_ms(value: Any) -> str:
    if not isinstance(value, (int, float)):
        return "unknown"
    return dt.datetime.fromtimestamp(value / 1000, tz=dt.UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


def short(value: str, limit: int = 180) -> str:
    value = " ".join(str(value).split())
    if len(value) <= limit:
        return value
    return value[: limit - 3] + "..."


def text_for_size(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=True, sort_keys=True)
    except TypeError:
        return str(value)


def fmt_int(value: Any) -> str:
    if value is None:
        return "unknown"
    try:
        return f"{int(value):,}"
    except (TypeError, ValueError):
        return "unknown"


def pct(part: int | None, whole: int | None) -> str:
    if not part or not whole:
        return "0.0%"
    return f"{part / whole * 100:.1f}%"


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_index(path: Path, limit: int, include_running: bool, session_ids: list[str]) -> list[dict[str, Any]]:
    sessions = read_json(path)
    if not isinstance(sessions, list):
        raise ValueError(f"Expected a list in {path}")

    if session_ids:
        wanted = set(session_ids)
        filtered = [session for session in sessions if session.get("id") in wanted]
    else:
        filtered = [
            session
            for session in sessions
            if include_running or session.get("status") != "running"
        ]
        filtered.sort(key=lambda item: item.get("updatedAt") or 0, reverse=True)
        filtered = filtered[:limit]
    return filtered


def build_raw_session_map(root: Path) -> dict[str, Path]:
    mapping: dict[str, Path] = {}
    if not root.exists():
        return mapping
    for path in root.rglob("*.jsonl"):
        match = re.search(r"-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$", path.name)
        if match:
            mapping[match.group(1)] = path
    return mapping


def parse_token_preview(text: str) -> dict[str, int] | None:
    match = TOKEN_PREVIEW_RE.search(text or "")
    if not match:
        return None
    input_tokens, output_tokens, cached_tokens = [int(part.replace(",", "")) for part in match.groups()]
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cached_input_tokens": cached_tokens,
        "reasoning_output_tokens": 0,
        "total_tokens": input_tokens + output_tokens,
    }


def command_signature(name: str, args_text: str) -> str:
    try:
        args = json.loads(args_text or "{}")
    except json.JSONDecodeError:
        return f"{name}: {short(args_text, 90)}"

    if name == "exec_command":
        cmd = args.get("cmd", "")
        return f"exec: {short(cmd, 110)}"
    if name == "apply_patch":
        return "apply_patch"
    return f"{name}: {short(json.dumps(args, sort_keys=True), 110)}"


def classify_session(summary: dict[str, Any]) -> tuple[str, list[str], list[str]]:
    reasons: list[str] = []
    recommendations: list[str] = []
    total = summary.get("total_tokens") or 0
    cached = summary.get("cached_input_tokens") or 0
    output = summary.get("output_tokens") or 0
    command_calls = summary.get("command_calls") or 0
    repeated_commands = summary.get("repeated_command_calls") or 0
    largest_output = summary.get("largest_output_bytes") or 0
    tool_calls = summary.get("tool_calls") or 0
    title = (summary.get("title") or "").lower()

    if total and cached / total >= 0.75:
        reasons.append("High cached context dominates token usage.")
        recommendations.append("Split long work into checkpointed subtasks and start fresh sessions from compact artifacts.")

    if repeated_commands >= 10 or (command_calls and repeated_commands / max(command_calls, 1) >= 0.25):
        reasons.append("Repeated shell/tool calls suggest exploration loops.")
        recommendations.append("Add a deterministic script for the repeated inspection or validation path.")

    if largest_output >= 500_000:
        reasons.append("Large command/tool output was returned to the model.")
        recommendations.append("Pipe large outputs through filters, summaries, counts, or report files instead of printing full content.")

    if command_calls >= 80:
        reasons.append("Heavy command volume suggests manual iteration.")
        recommendations.append("Batch discovery commands and use one-purpose scripts for repeatable repo analysis.")

    if tool_calls >= 120:
        reasons.append("High tool-call count increases transcript and context pressure.")
        recommendations.append("Use local analyzers and capped outputs before asking the model to reason over results.")

    if output and total and output / total < 0.003 and total >= 1_000_000:
        reasons.append("Very low final-output ratio for a high-token session.")
        recommendations.append("Force intermediate artifacts and stop conditions so progress is not trapped in chat history.")

    if "headroom" in title or "paper" in title or "pdf" in title:
        recommendations.append("For paper/PDF workflows, keep extraction, evaluation, and repair as separate artifact-based runs.")

    if "insurance" in title or "coding" in title:
        recommendations.append("For coding sessions, require a short investigation plan, bounded test loop, and saved findings file.")

    if not reasons:
        reasons.append("No major burn signal beyond normal task execution.")
        recommendations.append("Keep using bounded command output and concise checkpoints.")

    if largest_output >= 500_000:
        category = "large-output-burn"
    elif repeated_commands >= 10:
        category = "tool-loop-burn"
    elif total and cached / total >= 0.75:
        category = "long-context-burn"
    elif command_calls >= 80:
        category = "manual-iteration-burn"
    else:
        category = "normal-or-small"
    return category, reasons, list(dict.fromkeys(recommendations))


def analyze_raw_session(path: Path) -> dict[str, Any]:
    token_best: dict[str, int] | None = None
    event_counts: Counter[str] = Counter()
    payload_type_counts: Counter[str] = Counter()
    tool_name_counts: Counter[str] = Counter()
    command_counts: Counter[str] = Counter()
    call_names: dict[str, str] = {}
    call_signatures: dict[str, str] = {}
    call_timestamps: dict[str, str] = {}
    largest_outputs: list[dict[str, Any]] = []
    parse_errors = 0
    line_count = 0
    file_bytes = path.stat().st_size if path.exists() else 0

    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line_count, line in enumerate(handle, start=1):
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                parse_errors += 1
                continue

            event_type = record.get("type") or "unknown"
            event_counts[event_type] += 1
            payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
            payload_type = payload.get("type") or payload.get("role") or "unknown"
            payload_type_counts[payload_type] += 1

            if event_type == "event_msg" and payload.get("type") == "token_count":
                info = payload.get("info") or {}
                usage = info.get("total_token_usage") or {}
                if usage.get("total_tokens") is not None:
                    if not token_best or usage.get("total_tokens", 0) >= token_best.get("total_tokens", 0):
                        token_best = {
                            "input_tokens": int(usage.get("input_tokens") or 0),
                            "cached_input_tokens": int(usage.get("cached_input_tokens") or 0),
                            "output_tokens": int(usage.get("output_tokens") or 0),
                            "reasoning_output_tokens": int(usage.get("reasoning_output_tokens") or 0),
                            "total_tokens": int(usage.get("total_tokens") or 0),
                        }

            if event_type == "response_item" and payload.get("type") == "function_call":
                name = payload.get("name") or "unknown"
                call_id = payload.get("call_id")
                args_text = payload.get("arguments") or ""
                signature = command_signature(name, args_text)
                tool_name_counts[name] += 1
                command_counts[signature] += 1
                if call_id:
                    call_names[call_id] = name
                    call_signatures[call_id] = signature
                    call_timestamps[call_id] = record.get("timestamp") or ""

            if event_type == "response_item" and payload.get("type") == "function_call_output":
                call_id = payload.get("call_id") or ""
                output = text_for_size(payload.get("output") or "")
                byte_len = len(output.encode("utf-8", errors="replace"))
                largest_outputs.append(
                    {
                        "bytes": byte_len,
                        "call_id": call_id,
                        "tool": call_names.get(call_id, "unknown"),
                        "signature": call_signatures.get(call_id, "unknown"),
                        "timestamp": call_timestamps.get(call_id, record.get("timestamp") or ""),
                        "preview": short(output, 220),
                    }
                )
                largest_outputs.sort(key=lambda item: item["bytes"], reverse=True)
                del largest_outputs[10:]

    repeated_command_calls = sum(count for count in command_counts.values() if count > 1)
    repeated_commands = [
        {"count": count, "signature": signature}
        for signature, count in command_counts.most_common(10)
        if count > 1
    ]

    return {
        "token_usage": token_best,
        "event_counts": dict(event_counts),
        "payload_type_counts": dict(payload_type_counts),
        "tool_name_counts": dict(tool_name_counts),
        "command_calls": sum(tool_name_counts.values()),
        "repeated_command_calls": repeated_command_calls,
        "repeated_commands": repeated_commands,
        "largest_outputs": largest_outputs,
        "largest_output_bytes": largest_outputs[0]["bytes"] if largest_outputs else 0,
        "parse_errors": parse_errors,
        "line_count": line_count,
        "file_bytes": file_bytes,
    }


def combine_session(index_session: dict[str, Any], raw_map: dict[str, Path]) -> dict[str, Any]:
    session_id = index_session.get("id") or ""
    raw_path = raw_map.get(session_id)
    raw_summary: dict[str, Any] = {}
    token_source = "none"
    token_usage = None

    if raw_path and raw_path.exists():
        raw_summary = analyze_raw_session(raw_path)
        token_usage = raw_summary.get("token_usage")
        if token_usage:
            token_source = "raw-jsonl"

    if not token_usage:
        token_usage = parse_token_preview(index_session.get("lastMessagePreview") or "")
        if token_usage:
            token_source = "session-index-preview"

    combined = {
        **index_session,
        "updatedAtText": utc_from_ms(index_session.get("updatedAt")),
        "rawPath": str(raw_path) if raw_path else "",
        "token_source": token_source,
        "input_tokens": token_usage.get("input_tokens") if token_usage else None,
        "cached_input_tokens": token_usage.get("cached_input_tokens") if token_usage else None,
        "output_tokens": token_usage.get("output_tokens") if token_usage else None,
        "reasoning_output_tokens": token_usage.get("reasoning_output_tokens") if token_usage else None,
        "total_tokens": token_usage.get("total_tokens") if token_usage else None,
        **raw_summary,
    }
    category, reasons, recommendations = classify_session(combined)
    combined["burn_category"] = category
    combined["burn_reasons"] = reasons
    combined["recommendations"] = recommendations
    return combined


def write_report(path: Path, sessions: list[dict[str, Any]], args: argparse.Namespace) -> None:
    sessions_by_tokens = sorted(
        sessions,
        key=lambda item: item.get("total_tokens") if item.get("total_tokens") is not None else -1,
        reverse=True,
    )
    known_total = sum((item.get("total_tokens") or 0) for item in sessions)
    top = sessions_by_tokens[0] if sessions_by_tokens else {}
    category_counts = Counter(item.get("burn_category") or "unknown" for item in sessions)

    lines: list[str] = []
    lines.append("# Codex Session Token Audit")
    lines.append("")
    lines.append(f"Generated: {dt.datetime.now(dt.UTC).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    lines.append(f"Session index: `{args.session_index}`")
    lines.append(f"Raw sessions root: `{args.codex_sessions_root}`")
    lines.append(f"Reviewed sessions: {len(sessions)}")
    lines.append(f"Known total tokens across reviewed sessions: {fmt_int(known_total)}")
    if top:
        lines.append(f"Highest-token session: `{top.get('id')}` - {short(top.get('title') or '', 90)} - {fmt_int(top.get('total_tokens'))} tokens")
    lines.append("")

    lines.append("## Executive Summary")
    lines.append("")
    if sessions:
        lines.append("- Most token burn is concentrated in a few long sessions rather than spread evenly.")
        lines.append("- The strongest repeated pattern is long context carryover: cached input is often the majority of total usage.")
        lines.append("- Large command output and repeated tool calls are the main avoidable local causes.")
        lines.append("- The best fix is not a bigger prompt. It is deterministic local scripts, capped command output, and artifact checkpoints.")
    else:
        lines.append("- No sessions matched the selected filter.")
    lines.append("")

    lines.append("## Burn Categories")
    lines.append("")
    lines.append("| Category | Sessions |")
    lines.append("| --- | ---: |")
    for category, count in category_counts.most_common():
        lines.append(f"| {category} | {count} |")
    lines.append("")

    lines.append("## Token Ranking")
    lines.append("")
    lines.append("| Rank | Session | Title | Updated | Tokens | Input | Output | Cached | Category |")
    lines.append("| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | --- |")
    for rank, item in enumerate(sessions_by_tokens, start=1):
        lines.append(
            "| "
            + " | ".join(
                [
                    str(rank),
                    f"`{item.get('id')}`",
                    short(item.get("title") or "", 80).replace("|", "\\|"),
                    item.get("updatedAtText") or "unknown",
                    fmt_int(item.get("total_tokens")),
                    fmt_int(item.get("input_tokens")),
                    fmt_int(item.get("output_tokens")),
                    fmt_int(item.get("cached_input_tokens")),
                    item.get("burn_category") or "unknown",
                ]
            )
            + " |"
        )
    lines.append("")

    lines.append("## Cross-Session Fixes")
    lines.append("")
    lines.append("1. For any command expected to print more than a screen, redirect to a file and summarize with `wc`, `rg`, `jq`, `head`, or `tail`.")
    lines.append("2. For repeated repository discovery, use one script that emits a compact JSON or Markdown summary instead of many exploratory commands.")
    lines.append("3. For long coding tasks, save a short checkpoint file with facts, decisions, failing tests, and next commands, then continue from that artifact in a fresh session.")
    lines.append("4. For PDF/research workflows, separate extraction, evaluation, and repair into different artifact-based runs.")
    lines.append("5. Before opening browser or Playwright loops, define success checks and a maximum number of retries.")
    lines.append("6. Use session-audit reports like this before creating new skills or agents, so reusable assets target measured waste instead of guesses.")
    lines.append("")

    lines.append("## Session Reviews")
    lines.append("")
    for rank, item in enumerate(sessions_by_tokens, start=1):
        lines.append(f"### {rank}. {short(item.get('title') or 'Untitled', 110)}")
        lines.append("")
        lines.append(f"- Session id: `{item.get('id')}`")
        lines.append(f"- Status: `{item.get('status')}`")
        lines.append(f"- Updated: {item.get('updatedAtText')}")
        lines.append(f"- Workspace: `{item.get('workspace') or 'unknown'}`")
        lines.append(f"- Token source: `{item.get('token_source')}`")
        lines.append(f"- Total tokens: {fmt_int(item.get('total_tokens'))}")
        lines.append(f"- Input tokens: {fmt_int(item.get('input_tokens'))}")
        lines.append(f"- Cached input tokens: {fmt_int(item.get('cached_input_tokens'))} ({pct(item.get('cached_input_tokens'), item.get('total_tokens'))} of total)")
        lines.append(f"- Output tokens: {fmt_int(item.get('output_tokens'))}")
        lines.append(f"- Reasoning output tokens: {fmt_int(item.get('reasoning_output_tokens'))}")
        lines.append(f"- Message count from index: {fmt_int(item.get('messageCount'))}")
        lines.append(f"- Raw log size: {fmt_int(item.get('file_bytes'))} bytes")
        lines.append(f"- Raw log lines: {fmt_int(item.get('line_count'))}")
        lines.append(f"- Function/tool calls: {fmt_int(item.get('command_calls'))}")
        lines.append(f"- Repeated command/tool calls: {fmt_int(item.get('repeated_command_calls'))}")
        lines.append(f"- Largest tool output: {fmt_int(item.get('largest_output_bytes'))} bytes")
        lines.append(f"- Burn category: `{item.get('burn_category')}`")
        if item.get("rawPath"):
            lines.append(f"- Raw log: `{item.get('rawPath')}`")
        lines.append("")
        lines.append("Burn reasons:")
        for reason in item.get("burn_reasons", []):
            lines.append(f"- {reason}")
        lines.append("")
        lines.append("Recommended fixes:")
        for recommendation in item.get("recommendations", []):
            lines.append(f"- {recommendation}")
        lines.append("")

        repeated = item.get("repeated_commands") or []
        if repeated:
            lines.append("Repeated commands/tools:")
            for repeated_item in repeated[:5]:
                lines.append(f"- {repeated_item['count']}x `{repeated_item['signature']}`")
            lines.append("")

        largest_outputs = item.get("largest_outputs") or []
        if largest_outputs:
            lines.append("Largest outputs:")
            for output in largest_outputs[:5]:
                lines.append(
                    f"- {fmt_int(output['bytes'])} bytes from `{output['signature']}` at {output.get('timestamp') or 'unknown'}"
                )
            lines.append("")

        tool_counts = item.get("tool_name_counts") or {}
        if tool_counts:
            lines.append("Tool counts:")
            for name, count in sorted(tool_counts.items(), key=lambda pair: pair[1], reverse=True)[:8]:
                lines.append(f"- `{name}`: {count}")
            lines.append("")

    lines.append("## Notes")
    lines.append("")
    lines.append("- The report intentionally avoids full transcript excerpts.")
    lines.append("- Token totals are exact when sourced from raw `token_count` events and fallback estimates when sourced from `session-index` previews.")
    lines.append("- Cached input tokens are not extra text generated by the assistant; they indicate repeated context carried through the session.")
    lines.append("")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    args = parse_args()
    index_path = Path(args.session_index)
    raw_root = Path(args.codex_sessions_root)
    sessions = load_index(index_path, args.limit, args.include_running, args.session_id)
    raw_map = build_raw_session_map(raw_root)
    combined = [combine_session(session, raw_map) for session in sessions]
    write_report(Path(args.output), combined, args)
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
