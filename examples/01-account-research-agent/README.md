# Example 01 — Account Research Agent

**One file. One `query()` call. A sourced, structured account brief on disk.**

This is the "hello world" of the Claude Agent SDK that actually earns its keep. You hand it a company name; it searches, reads, cross-checks, and writes a Markdown brief with every claim linked to a source.

```bash
python agent.py "State Farm"
python agent.py "Snowflake" --focus "competitive position in data platforms"
```

---

## What you're looking at

```
your prompt  ──►  ┌─────────────────┐  ──►  output/state-farm-brief.md
                  │   agent loop     │
                  │  plan → tool →   │
                  │  observe → plan  │
                  └────────┬─────────┘
                           │
              WebSearch · WebFetch · Read · Write · Glob
```

There is no orchestration framework in this file. `query()` runs the loop. You choose the tools, the guardrails, and the budget — the agent chooses the steps.

## The three levers

Every production agent you build comes down to tuning these three. They're annotated inline in [`agent.py`](agent.py).

| Lever | In this example | Why it matters |
|---|---|---|
| **Tools** | `WebSearch, WebFetch, Read, Write, Glob` — and `Bash` explicitly denied | The tool list *is* the blast radius. Writing a research brief never requires a shell, so it doesn't get one. |
| **Permissions** | `permission_mode="acceptEdits"` | Auto-approves file writes so the run is unattended. Human-in-the-loop products use a `can_use_tool` callback instead — see [example 02](../02-document-pipeline-agent/). |
| **Budget** | `max_turns=40`, `max_budget_usd=2.00` | An agent without a bound is a bill without a bound. Both caps stop the loop before your invoice does. |

Two more settings do quiet but important work:

- **`cwd`** scopes the agent's filesystem to this example's directory.
- **`setting_sources=[]`** stops the agent loading `CLAUDE.md`, project settings, or personal skills from the host. In a shared runner this is the line between an isolated agent and one tenant's context bleeding into another's.

## Setup

```bash
cd examples/01-account-research-agent
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...                  # Windows: $env:ANTHROPIC_API_KEY="sk-ant-..."
python agent.py "State Farm"
```

> The SDK reads `ANTHROPIC_API_KEY` from the process environment. It does **not** load `.env` files for you — use `python-dotenv` if you keep it in a file.

## What a run looks like

```
  Researching: State Farm
  Output:      output/state-farm-brief.md
  ------------------------------------------------------------

  I'll start with the company's own newsroom and careers page, then look for
  recent technology signals before writing anything.
  -> WebSearch
  -> WebFetch
  -> WebSearch
  -> WebFetch
  -> WebFetch

  I have enough on strategic priorities and stack signals. Writing the brief.
  -> Write
  ------------------------------------------------------------
  Finished: success
  Tool calls: 18
  Cost: $0.4127
```

That `Cost:` line is not decoration. Emit a per-run cost from every agent you deploy, or you will learn what your agents cost from finance instead of from your dashboard.

## The prompt is a work order, not a script

Look at `TASK_TEMPLATE` in `agent.py`. It describes the **deliverable** — seven named sections, sourcing rules, a bar for what counts as specific — and says nothing about how many searches to run or in what order. That's the shift that makes agents different from prompt chains: you specify the outcome and the constraints, and the loop figures out the path.

The `SYSTEM_PROMPT` holds the *judgment* that's true across every run: cite everything, prefer primary sources, label inferences as inferences, never invent a URL. Onboarding instructions for a new analyst, not instructions for one task.

## Make it yours

| You want | Change this |
|---|---|
| A different deliverable | Rewrite `TASK_TEMPLATE`. Keep it outcome-shaped. |
| Reads from a local corpus too | Add `add_dirs=["/path/to/your/docs"]` to the options. |
| Cheaper runs | `model="claude-haiku-4-5-20251001"` and drop `max_turns` to ~20. |
| Deeper reasoning | Add `thinking={"type": "enabled", "budget_tokens": 16000}`. |
| Structured output instead of Markdown | Ask for JSON in the prompt and add a schema to the task. |
| Batch mode over a list of accounts | Wrap `run()` in `asyncio.gather` with a semaphore of 3–5. |

## Where this breaks

Worth knowing before you point it at something that matters:

- **Web search quality is the ceiling.** For a company with a thin public footprint, sections 2 and 3 will be thin, and the agent will say so rather than invent. That's the system prompt working, not failing.
- **`max_turns=40` is a hard stop.** If the run ends with a non-`success` subtype, it likely ran out of turns mid-research. Raise it, or narrow `--focus`.
- **No caching.** Two runs on the same company do the same searches and cost the same. If you're doing this over a large account list, put a cache in front of `WebFetch` via a hook — [example 02](../02-document-pipeline-agent/) shows the hook mechanism.

---

**Next:** [Example 02 — Document Pipeline Agent](../02-document-pipeline-agent/) adds custom tools, lifecycle hooks, and subagents.
