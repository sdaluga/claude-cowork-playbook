# Contributing

Thanks for being here. This repo is a teaching resource first, so the bar for a
change is "does it make someone faster or safer", not "is it clever".

## What's most welcome

1. **Working examples in other domains.** Legal, healthcare, finance ops,
   research, support. The scaffolding here is deliberately generic; a real
   example from your world is worth more than another abstraction.
2. **`SessionStore` backends.** The contract logic is done — `examples/03-inbox-triage-service/src/session-store.ts` implements it once against a five-method `BlobBackend` seam and ships a mounted-volume backend. S3, Postgres and Redis are five methods each, and the mappings (including the Postgres DDL) are already written at the bottom of that file. Bring tests: the existing 33 are named for the mistake each one prevents, and a new backend should pass the same ones.
3. **Corrections.** Docs move. If something here has drifted from the official
   documentation, that's a bug — open an issue with the doc link.
4. **Failure stories.** A short doc on how an agent broke in production, and
   what control would have caught it, is genuinely valuable.

## What isn't

- Framework wrappers. This repo shows the SDK, not a layer over it.
- Examples without comments explaining *why*. The comments are the product.
- Anything that needs a paid third-party service to run.

## Ground rules for code

- **Comment the why, not the what.** `# increment i` is noise;
  `# .resolve() collapses .., so output/../../etc/hosts is caught` is the point.
- **Every example must run** with an API key and nothing else installed
  globally.
- **Every example must bound itself.** `max_turns` and `max_budget_usd` are
  not optional in this repo, even in a toy.
- **Never widen a tool list for convenience.** If an example needs `Bash`,
  the README has to say why.
- **No real credentials, ever** — including in comments, test fixtures, and
  sample documents.

## Ground rules for docs

- Link the official documentation rather than restating it at length. This
  repo's value is the connective tissue and the scar tissue, not a mirror.
- If you state a number (RAM per agent, a cost, a limit), say where it comes
  from.
- Prefer a table or a diagram over three paragraphs.

## Submitting

1. Fork, branch, commit with a clear message.
2. Run what you changed. Python examples: `python agent.py`. TypeScript:
   `npm run typecheck`.
3. Open a PR describing what someone can now do that they couldn't before.

Small PRs get reviewed fast. A 900-line PR that restructures three directories
will sit for a while — open an issue first and let's agree on the shape.

## Reporting a security issue

Please don't open a public issue for a vulnerability in the examples. Open a
GitHub security advisory on this repo instead. For issues in the Claude Agent
SDK itself, report them to Anthropic through the SDK repositories.
