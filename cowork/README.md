# Cowork: the no-code half of this repo

Everything in [`examples/`](../examples/) needs an API key, a terminal, and a deploy target. **Cowork needs none of that** — it's the same agentic architecture with no terminal, aimed at people who work with documents and files rather than repositories.

If you only read one page in this repo before trying something, read this one. The distance between "interesting" and "useful" is about twenty minutes here.

---

## What Cowork actually is

An agentic system that executes multi-step knowledge work on your behalf: research synthesis, document preparation, file management. It runs **remotely in the cloud**, so you can start a task, close the laptop, and come back to finished work.

Sessions can reach files on your computer through the desktop app's connected folders, and can drive Chrome to work on websites.

| Platform | Availability |
|---|---|
| Desktop (macOS/Windows) | All paid plans |
| Web (claude.ai) | Pro, Max, Team; Enterprise where enabled |
| Mobile (iOS/Android) | Pro, Max, Team; Enterprise where enabled |
| Chrome side panel | Max, Team, rolling out to Pro; Enterprise where enabled |

**To start:** find the message box on any surface, select **Cowork**, and describe the task.

## The three approval modes — pick deliberately

This is the setting people leave on the default and then wonder about later.

| Mode | Behaviour | Use it when |
|---|---|---|
| **Manually approve** | Claude pauses and asks before each action | You're learning what it does, or the task touches something you can't undo |
| **Automatically approve** | Works continuously, running safety checks as it goes | The normal working mode. Note: **consumes more of your usage limit** than the others |
| **Skip all approvals** | No interruptions, no automatic checks | Only for tasks you fully trust end to end |

Claude requires **explicit permission before permanently deleting any file**, in every mode.

## Skills: the highest-leverage thing here

A skill is a folder with a `SKILL.md` in it: YAML frontmatter that tells Claude *when* to use it, and Markdown that tells Claude *how*. The body loads only when the skill fires, so long reference material costs you nothing until it's needed.

Write a skill the moment you notice you're pasting the same instructions for the third time.

### Two working skills, ready to install

| Skill | What it does | Trigger |
|---|---|---|
| [`deal-brief`](skills/deal-brief/SKILL.md) | Turns a folder of call notes, emails, decks and contracts into a **one-page** executive brief with a clear ask and named risks | "deal brief", "prep me for this meeting", or pointing at an account folder |
| [`weekly-account-review`](skills/weekly-account-review/SKILL.md) | Runs a Monday review across a portfolio and produces one prioritised action list with the reasoning shown | "weekly review", "what should I work on this week" — built to run **on a schedule** |

Both are written to be read as well as run. The interesting parts aren't the mechanics — they're the constraints:

- `deal-brief` enforces **one page**. "If it doesn't fit, cut — do not shrink the font." A constraint the model can't wriggle out of produces better output than three paragraphs of encouragement.
- `weekly-account-review` **never asks a clarifying question**, because it's designed to fire at 7am Monday when nobody's there to answer. It states its assumption at the top and proceeds.
- Both require every claim to cite a file or a date. **"An uncited reason is an opinion wearing a suit."**

### Install one

1. Copy the skill folder (e.g. `skills/deal-brief/`).
2. Enable it for your **claude.ai account** — the skills settings on claude.ai, or **Customize** in the desktop app sidebar.
3. Start a Cowork session and either invoke it directly with `/deal-brief`, or just describe the task and let the `description` field trigger it.

> **The gotcha that costs people an afternoon:** Cowork and cloud sessions do **not** read `~/.claude/skills/` on your machine. They load the skills enabled for your **claude.ai account**, synced at session start. A skill that works in your local terminal will report as "not found" in a Cowork session or a scheduled task until you enable it on the account.
>
> Desktop *scheduled tasks* are the exception — they run locally and load skills from the same places any local session does.

### Frontmatter: six fields, not thirty

Claude Code accepts a large frontmatter vocabulary (`context: fork`, `model`, `hooks`, `paths`, …). **claude.ai skill uploads accept exactly six:**

```
name · description · license · compatibility · metadata · allowed-tools
```

Include anything else and the upload fails with a hard error rather than ignoring the field:

```
Unexpected key(s) in SKILL.md frontmatter: argument-hint.
Allowed properties are: allowed-tools, compatibility, description, license, metadata, name
```

Both skills here stick to the six, which is why they load in Cowork unchanged.

### Writing a good `description`

This is the single highest-leverage line in the file. It's what Claude reads to decide whether the skill is relevant — the body isn't loaded yet.

Put the **key use case first**, then the trigger phrases. The combined `description` and `when_to_use` text is truncated at **1,536 characters** in the skill listing.

❌ `description: Helps with account work.`
✅ `description: Turns a folder of raw account material into a one-page executive deal brief with a clear ask and named risks. Use when the user says "deal brief", "pursuit brief", "prep me for this meeting", or points at a folder of account files.`

## Scheduled tasks

Use `/schedule` or the **Scheduled** sidebar. Scheduled tasks run **in the cloud**, so your machine doesn't need to be awake and the desktop app doesn't need to be open.

Rules of thumb learned the hard way:

- **Write the prompt as a complete standalone instruction.** Every firing starts a fresh session with no memory of the conversation where you set it up.
- **Nobody is there to answer a question.** The task should decide and state its assumptions, not block. That constraint is baked into `weekly-account-review`.
- **Have it write a file, not just a message.** A Monday review you can open on Thursday is worth more than one that scrolled away.
- **Enable the skill on your claude.ai account first**, per the gotcha above.

## Connectors, plugins, projects

- **Connectors (MCP)** — Settings → Connectors, or the **+** menu. This is how Cowork reaches Gmail, Drive, Slack, Jira, and the rest.
- **Plugins** — bundles of skills, agents, hooks, and MCP servers that customise Claude for a role, team, or company. Some plugins with local MCP servers are desktop-only.
- **Projects** — workspaces with their own files, context, instructions, and memory. Put standing context here rather than re-pasting it.
- **Global and folder instructions** — Settings → Cowork for instructions that apply to every session; folder instructions on desktop for per-project context.

## Cowork or the Agent SDK?

The honest version of the decision:

| | **Cowork** | **Agent SDK** |
|---|---|---|
| Who runs it | A person, or a schedule | Your application |
| Setup | Paid plan, no code | API key, runtime, deploy target |
| Customise with | Skills, plugins, connectors, projects | Code, custom tools, hooks, subagents |
| Runs where | Anthropic's cloud | Your infrastructure, or Managed Agents |
| Best at | Judgment work on documents and files, run by the person who needs it | Repeatable work embedded in a product or pipeline |
| Ceiling | What you can express in a skill | What you can express in code |

The rule that holds up in practice: **if a person is going to look at the output every time, start with Cowork.** Move to the SDK when the same task runs a hundred times a day and nobody is looking.

Most teams need both, and the good news is that skills transfer — the Agent SDK loads skills too.

Full comparison: [`docs/02-cowork-vs-agent-sdk.md`](../docs/02-cowork-vs-agent-sdk.md).

---

**Next:** [`examples/01-account-research-agent`](../examples/01-account-research-agent/) — the same idea, in code.
