"""
Lifecycle hooks: the agent's flight recorder and its circuit breaker.
=====================================================================

WHAT A HOOK IS
--------------
A hook is your code, running at a fixed point in the agent's lifecycle, in
your process, synchronously, before or after the agent does something.

    PreToolUse   -- fires before a tool runs. Can allow, deny, or rewrite it.
    PostToolUse  -- fires after a tool runs. Sees the result.

WHY YOU WANT THEM
-----------------
Two reasons, and they are the two questions every risk reviewer asks about an
agent:

    "What did it actually do?"      -> PreToolUse writes an audit log.
    "What stops it doing X?"        -> PreToolUse denies X deterministically.

The second one is the important one. A system prompt that says "never write
outside the output directory" is a *request*. A PreToolUse hook that inspects
the path and returns a deny is a *rule*. Models are persuadable; hooks are not.
Put anything you would have to defend in a compliance review in a hook.

HOOKS vs. PERMISSION CALLBACKS
------------------------------
Both intercept tool calls. Rough division of labour:

  - `can_use_tool` is a permission *decision* per call -- often interactive,
    often "ask the human." One callback for the whole agent.
  - Hooks are *policy and observability* -- non-interactive, matcher-scoped,
    and you can register several. They are also where you put side effects
    like logging, metrics, and cache warming.

This file uses both, so you can see the shapes side by side.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from claude_agent_sdk import HookMatcher
from claude_agent_sdk.types import PermissionResultAllow, PermissionResultDeny

# Where the flight recorder writes. One JSON object per line, so you can
# `jq` it, ship it to a log aggregator, or replay it.
AUDIT_LOG = Path(__file__).parent / "output" / "audit.jsonl"

# The only directory this agent is allowed to write into. Anything else is a
# hard deny, regardless of what the prompt says or what the model decides.
WRITE_ALLOWLIST = (Path(__file__).parent / "output").resolve()

_RUN_STARTED = time.time()


# --------------------------------------------------------------------------- #
# Hook 1 — audit every tool call before it runs
# --------------------------------------------------------------------------- #


async def audit_tool_use(
    input_data: dict[str, Any],
    tool_use_id: str | None,
    context: Any,
) -> dict[str, Any]:
    """
    PreToolUse hook. Appends one line to the audit log for every tool call the
    agent attempts -- including the ones that get denied downstream.

    Returning an empty dict means "no opinion, carry on." A hook only changes
    behaviour when it returns a decision (see `guard_writes` below).
    """
    AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)

    entry = {
        "t": round(time.time() - _RUN_STARTED, 3),
        "event": "PreToolUse",
        "tool": input_data.get("tool_name"),
        "tool_use_id": tool_use_id,
        # Truncate: tool inputs can carry an entire file's contents, and an
        # audit log that nobody can open is not an audit log.
        "input": _truncate(input_data.get("tool_input", {})),
    }
    with AUDIT_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")

    return {}


# --------------------------------------------------------------------------- #
# Hook 2 — deterministic write guard
# --------------------------------------------------------------------------- #


async def guard_writes(
    input_data: dict[str, Any],
    tool_use_id: str | None,
    context: Any,
) -> dict[str, Any]:
    """
    PreToolUse hook scoped to Write/Edit. Denies any write whose resolved path
    falls outside the output allowlist.

    Note `.resolve()`: it collapses `..` segments, so a path like
    `output/../../etc/hosts` is caught. Path checks that operate on the raw
    string are the classic way this control gets bypassed.
    """
    tool_name = input_data.get("tool_name", "")
    if tool_name not in ("Write", "Edit", "NotebookEdit"):
        return {}

    raw_path = (input_data.get("tool_input") or {}).get("file_path")
    if not raw_path:
        return {}

    target = Path(raw_path).resolve()
    if WRITE_ALLOWLIST not in target.parents and target != WRITE_ALLOWLIST:
        reason = (
            f"Blocked: writes are restricted to {WRITE_ALLOWLIST}. "
            f"Attempted: {target}"
        )
        _log_denial(tool_name, str(target), reason)
        # This shape tells the agent loop to refuse the call and hand the
        # reason back to the model, which can then correct course.
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        }

    return {}


# --------------------------------------------------------------------------- #
# Hook 3 — record results, so the log shows outcomes and not just intent
# --------------------------------------------------------------------------- #


async def record_result(
    input_data: dict[str, Any],
    tool_use_id: str | None,
    context: Any,
) -> dict[str, Any]:
    """PostToolUse hook. Logs that a tool completed, and roughly how big the
    result was. Pair this with `audit_tool_use` and your log answers both
    "what did it try" and "what came back"."""
    AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)

    response = input_data.get("tool_response")
    entry = {
        "t": round(time.time() - _RUN_STARTED, 3),
        "event": "PostToolUse",
        "tool": input_data.get("tool_name"),
        "tool_use_id": tool_use_id,
        "result_chars": len(str(response)) if response is not None else 0,
    }
    with AUDIT_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")

    return {}


# --------------------------------------------------------------------------- #
# Wiring
# --------------------------------------------------------------------------- #


def build_hooks() -> dict[str, list[HookMatcher]]:
    """
    Returns the `hooks=` value for ClaudeAgentOptions.

    `matcher=None` means "every tool". A matcher string scopes the hook to
    matching tool names, which keeps hot-path hooks cheap.
    """
    return {
        "PreToolUse": [
            HookMatcher(matcher=None, hooks=[audit_tool_use]),
            HookMatcher(matcher="Write|Edit|NotebookEdit", hooks=[guard_writes]),
        ],
        "PostToolUse": [
            HookMatcher(matcher=None, hooks=[record_result]),
        ],
    }


# --------------------------------------------------------------------------- #
# Permission callback — the interactive-shaped control
# --------------------------------------------------------------------------- #


async def confirm_destructive_tools(
    tool_name: str,
    input_data: dict[str, Any],
    context: Any,
):
    """
    `can_use_tool` callback. One function, consulted for tool calls that the
    allow-list does not already auto-approve.

    In a CLI you would prompt the operator here. In a web app you would push a
    card into the UI and await the click. In an unattended pipeline -- which
    is what this example is -- you encode the decision, which is what we do:
    Bash is refused outright, everything else proceeds unmodified.

    You can also *rewrite* the call instead of allowing or denying it, by
    returning PermissionResultAllow(updated_input=...). That is how you
    transparently redirect a write into a sandbox rather than failing it.
    """
    if tool_name == "Bash":
        return PermissionResultDeny(
            message=(
                "This pipeline does not run shell commands. Use the ledger "
                "tools for validation and recording."
            ),
            # interrupt=True stops the whole run instead of letting the agent
            # try something else. Use it when a denial means the plan itself
            # was wrong, not just one step.
            interrupt=False,
        )

    return PermissionResultAllow(updated_input=input_data)


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def _truncate(payload: Any, limit: int = 400) -> Any:
    text = json.dumps(payload, default=str)
    if len(text) <= limit:
        return payload
    return {"_truncated": text[:limit] + f"... [{len(text)} chars]"}


def _log_denial(tool: str, target: str, reason: str) -> None:
    AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
    with AUDIT_LOG.open("a", encoding="utf-8") as fh:
        fh.write(
            json.dumps(
                {
                    "t": round(time.time() - _RUN_STARTED, 3),
                    "event": "Denied",
                    "tool": tool,
                    "target": target,
                    "reason": reason,
                }
            )
            + "\n"
        )
