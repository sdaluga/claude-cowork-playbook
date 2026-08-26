"""
Example 01 — Account Research Agent
===================================

WHAT THIS DOES
--------------
Give it a company name. It researches the company on the web, reads any local
files you point it at, and writes a structured account brief to disk as
Markdown. One command, one artifact, no babysitting.

WHY THIS IS THE FIRST EXAMPLE
-----------------------------
It is the smallest thing that is still a *real* agent. There is no orchestration
framework here and no prompt-chaining library. There is one call to `query()`,
a list of tools the agent is allowed to touch, and a loop that prints what it is
doing. The SDK runs the agent loop -- plan, call a tool, look at the result,
decide what is next -- until the task is done.

THE MENTAL MODEL
----------------
    your prompt  ->  [ agent loop ]  ->  artifact on disk
                        |  ^
                        v  |
                     tools (Read, Write, WebSearch, WebFetch, Glob)

Everything else in this repo is a variation on that picture: more tools
(example 02), or a longer-lived loop behind an HTTP port (example 03).

RUN IT
------
    pip install -r requirements.txt
    export ANTHROPIC_API_KEY=sk-ant-...
    python agent.py "State Farm"
    python agent.py "Snowflake" --focus "competitive position in data platforms"

Output lands in ./output/<company-slug>-brief.md
"""

from __future__ import annotations

import argparse
import asyncio
import re
import sys
from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    query,
)

# --------------------------------------------------------------------------- #
# 1. Configuration
# --------------------------------------------------------------------------- #

# Where the agent is allowed to write. We create it up front and hand the agent
# a working directory, so it never has a reason to wander around your filesystem.
OUTPUT_DIR = Path(__file__).parent / "output"

# The system prompt is where you put *judgment*, not instructions for a single
# run. Think of it as onboarding a new analyst: what good looks like, what to
# never do, how to handle uncertainty. The per-run prompt (below) is the task.
SYSTEM_PROMPT = """\
You are a senior enterprise account researcher. You write briefs that a
technology seller can walk into a CIO meeting with.

Standards you hold yourself to:
- Every factual claim about the company is sourced with a URL. If you cannot
  source it, you leave it out rather than guessing.
- You distinguish clearly between what is publicly reported and what is your
  own inference. Inferences get labeled as such.
- You prefer primary sources (the company's own filings, newsroom, careers
  page, engineering blog) over secondary commentary.
- You are specific. "Investing in AI" is useless. "Named a Chief AI Officer in
  March and posted 40 roles referencing Databricks" is useful.
- Recency matters. If the newest thing you can find is two years old, you say
  so rather than presenting stale news as current.

You never fabricate a source URL. A brief with three sourced facts beats a
brief with twenty invented ones.
"""


# The task prompt. Note that it describes the *deliverable*, not the steps.
# You are not writing a script; you are writing a work order. The agent decides
# how many searches it needs and in what order.
TASK_TEMPLATE = """\
Research the company **{company}** and write an account brief.

{focus_clause}

Produce a single Markdown file at `output/{slug}-brief.md` with these sections:

1. **Snapshot** — what the company does, size, segment, headquarters, and
   fiscal year end. Five bullets maximum.
2. **Strategic priorities** — the two or three things leadership has publicly
   said matter most right now, each with a source link and a date.
3. **Technology signals** — evidence about their stack, cloud posture, data
   platform, and AI adoption. Job postings, conference talks, case studies,
   engineering blogs. Cite each one.
4. **Org and people** — named executives relevant to a technology conversation
   (CIO, CTO, CDO, CISO), with links.
5. **Where a technology partner creates value** — three specific, defensible
   plays, each tied to a signal you found above. No generic "digital
   transformation" filler.
6. **Open questions** — what you could not determine and would need to ask in
   a discovery call.
7. **Sources** — every URL you used, as a numbered list.

Start by searching. Do not write the file until you have gathered enough to
fill sections 2 and 3 with real, sourced material.
"""


def build_options(output_dir: Path) -> ClaudeAgentOptions:
    """
    Assemble the agent's configuration.

    Three things are worth understanding here, because they are the three
    levers you will actually reach for in production.
    """
    return ClaudeAgentOptions(
        system_prompt=SYSTEM_PROMPT,
        # -- Lever 1: TOOLS ------------------------------------------------ #
        # The tool list is your blast radius. This agent can search the web,
        # fetch pages, look at files, and write files. It cannot run shell
        # commands, because nothing about writing a research brief requires a
        # shell. Every tool you add is a new thing that can go wrong at 2am.
        allowed_tools=["WebSearch", "WebFetch", "Read", "Write", "Glob"],
        # Belt and braces: explicitly deny the dangerous ones. `allowed_tools`
        # already excludes them, but an explicit deny survives someone later
        # copy-pasting this config and widening the allow list.
        disallowed_tools=["Bash", "Edit", "NotebookEdit"],
        # -- Lever 2: PERMISSIONS ------------------------------------------ #
        # "acceptEdits" auto-approves file writes so the run is unattended.
        # In a human-in-the-loop product you would use the default mode and
        # supply a `can_use_tool` callback instead -- see example 02.
        permission_mode="acceptEdits",
        # -- Lever 3: BUDGET ----------------------------------------------- #
        # An agent without a bound is a bill without a bound. `max_turns` caps
        # how many tool-use round trips it takes before it has to stop. A
        # research task like this typically finishes in 15-25.
        max_turns=40,
        # Hard dollar ceiling for a single run. The SDK stops the loop when the
        # run's spend crosses this. Set it to something you would not mind
        # seeing on an invoice a hundred times.
        max_budget_usd=2.00,
        # The agent's filesystem lives here. Combined with the tool list, this
        # is the practical sandbox: it reads and writes inside this directory.
        cwd=str(output_dir.parent),
        # Pin the model rather than inheriting whatever the environment has.
        # Research is judgment work, so it gets the reasoning model.
        model="claude-sonnet-5",
        # If the primary model is unavailable, degrade instead of failing.
        fallback_model="claude-haiku-4-5-20251001",
        # Multi-tenant hygiene. `setting_sources=[]` stops the agent from
        # loading CLAUDE.md files, project settings, or personal skills off the
        # host filesystem. In a shared runner that is the difference between an
        # isolated agent and one tenant's context leaking into another's.
        setting_sources=[],
    )


# --------------------------------------------------------------------------- #
# 2. The run loop
# --------------------------------------------------------------------------- #


def slugify(name: str) -> str:
    """'State Farm Insurance' -> 'state-farm-insurance'"""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


async def run(company: str, focus: str | None) -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    slug = slugify(company)

    focus_clause = (
        f"Pay particular attention to: {focus}\n" if focus else ""
    )
    prompt = TASK_TEMPLATE.format(
        company=company, slug=slug, focus_clause=focus_clause
    )

    print(f"\n  Researching: {company}")
    print(f"  Output:      {OUTPUT_DIR / f'{slug}-brief.md'}")
    print("  " + "-" * 60)

    tool_calls = 0

    # `query()` returns an async iterator. Each item is one message from the
    # agent loop: Claude's reasoning, a tool call, a tool result, or the final
    # outcome. You are watching the agent think, not polling a job queue.
    async for message in query(prompt=prompt, options=build_options(OUTPUT_DIR)):

        if isinstance(message, AssistantMessage):
            for block in message.content:
                # A text block is Claude's reasoning out loud.
                if hasattr(block, "text"):
                    text = block.text.strip()
                    if text:
                        print(f"\n  {text}")
                # A block with a `name` is a tool call. This is the single most
                # useful thing to log in production: it is the audit trail of
                # what the agent actually did, as opposed to what it said.
                elif hasattr(block, "name"):
                    tool_calls += 1
                    print(f"  -> {block.name}")

        elif isinstance(message, ResultMessage):
            # The terminal message. `subtype` tells you how the run ended:
            # "success", or an error variant such as hitting max_turns.
            print("\n  " + "-" * 60)
            print(f"  Finished: {message.subtype}")
            print(f"  Tool calls: {tool_calls}")

            # Cost accounting. Log this. Every agent you deploy should emit a
            # per-run cost line, or you will find out what it costs from
            # finance instead of from your dashboard.
            usd = getattr(message, "total_cost_usd", None)
            if usd is not None:
                print(f"  Cost: ${usd:.4f}")

            return 0 if message.subtype == "success" else 1

    return 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Research a company and write a sourced account brief."
    )
    parser.add_argument("company", help='Company name, e.g. "State Farm"')
    parser.add_argument(
        "--focus",
        default=None,
        help='Optional angle, e.g. "their data platform strategy"',
    )
    args = parser.parse_args()

    try:
        return asyncio.run(run(args.company, args.focus))
    except KeyboardInterrupt:
        print("\n  Interrupted.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
