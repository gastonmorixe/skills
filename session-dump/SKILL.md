---
name: session-dump
description: Generate a continuation-ready markdown dump for an external coding-agent session, starting with Claude Code session IDs. Use when the user needs to continue prior work from a Claude session, inspect where session history is stored, dump tool calls/subagents/tasks/plans/teams metadata, or build a citation-heavy session handoff. The bundled Bun TypeScript CLI runs standalone and supports reference-first output with opt-in raw inclusion.
---

# Session Dump

Use this skill when a user gives you a session id from another agent and wants a full, citation-heavy dump that another agent can use to continue work.

The bundled CLI is Bun-first TypeScript and currently supports:

- `claude` provider
- reference-first markdown dumps by default
- opt-in raw inclusion for referenced artifacts
- built-in heuristic redaction with no third-party runtime dependencies

## Entry point

From the skill directory, run:

```bash
bun run session-dump --provider claude --session <session-id>
```

Or directly:

```bash
bun run ./src/index.ts --provider claude --session <session-id>
```

## Defaults

- Main transcript is inlined
- Related artifacts are cited by absolute path
- Raw referenced file content is not embedded unless requested
- Redaction is enabled by default

## Useful flags

- `--output <file>`: write the markdown dump to a file
- `--include-raw`: inline all discovered related artifacts
- `--include-subagents`: inline subagent transcripts
- `--include-tool-results`: inline spilled tool-result files
- `--include-debug`: inline debug log content
- `--include-history`: inline matching `history.jsonl` entries
- `--include-tasks`: inline task JSON files
- `--include-teams`: inline team config and inbox files
- `--include-plans`: inline plan files
- `--no-redact`: disable heuristic redaction
- `--json-index <file>`: write a machine-readable artifact manifest
- `--strict`: fail when a referenced artifact is missing

## Claude artifact model

The Claude adapter checks these locations:

- `~/.claude/projects/*/<session-id>.jsonl` for the canonical transcript
- sibling `subagents/` and `tool-results/`
- `~/.claude/debug/<session-id>.txt`
- `~/.claude/history.jsonl`
- `~/.claude/tasks/<session-id>/`
- `~/.claude/teams/*/config.json` and inboxes when linked by `leadSessionId`
- `~/.claude/plans/*.md` from explicit plan references and slug matches
- `~/.claude/session-env/` opportunistically

## Output contract

The dump is deterministic and markdown-only in v1. It includes:

- session identity and metadata
- artifact inventory with absolute paths
- main transcript rendering
- related artifact sections
- explicit missing-data notes
- non-LLM continuation notes derived from transcript structure

## Testing

Use Bun’s built-in test runner:

```bash
bun test
bun test --coverage
```

If you update parsing or redaction behavior, run coverage and keep tests focused on:

- transcript discovery
- persisted-output path extraction
- redaction heuristics
- artifact rendering behavior
