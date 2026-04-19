#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  extractPersistedOutputPathsFromEntry,
  loadClaudeSession,
  resolveMessageContent,
} from "./providers/claude.ts";
import { redactText } from "./redact.ts";
import type {
  ArtifactRecord,
  CliOptions,
  LoadedSession,
  RenderedEvent,
} from "./types.ts";

const DEFAULT_MAX_INLINE_BYTES = 24_000;
const DUMPER_ENTRYPOINT = "src/index.ts";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  if ("help" in options) {
    printHelp();
    return 0;
  }

  const loaded = await loadClaudeSession(options);
  const rendered = await buildMarkdownDump(loaded, options);

  if (options.outputPath) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, rendered.markdown, "utf8");
  } else {
    process.stdout.write(rendered.markdown);
  }

  if (options.jsonIndexPath) {
    await mkdir(path.dirname(options.jsonIndexPath), { recursive: true });
    await writeFile(
      options.jsonIndexPath,
      JSON.stringify(
        {
          provider: loaded.provider,
          sessionId: loaded.sessionId,
          transcriptPath: loaded.transcriptPath,
          artifacts: rendered.artifacts,
          warnings: loaded.warnings,
          parseWarnings: loaded.parseWarnings,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  if (options.strict) {
    const missing = rendered.artifacts.filter((artifact) => !artifact.exists);
    if (missing.length > 0) {
      throw new Error(
        `Strict mode failed because ${missing.length} referenced artifact(s) were missing.`,
      );
    }
  }

  return 0;
}

type HelpResult = { help: true };

export function parseArgs(argv: string[]): CliOptions | HelpResult {
  const rootDir = path.join(os.homedir(), ".claude");
  const options: CliOptions = {
    provider: "claude",
    sessionId: "",
    rootDir,
    includeRaw: false,
    includeSubagents: false,
    includeToolResults: false,
    includeDebug: false,
    includeHistory: false,
    includeTasks: false,
    includeTeams: false,
    includePlans: false,
    redact: true,
    format: "markdown",
    maxInlineBytes: DEFAULT_MAX_INLINE_BYTES,
    strict: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "-h":
      case "--help":
        return { help: true };
      case "--provider":
        if (next !== "claude") {
          throw new Error(`Unsupported provider: ${String(next)}`);
        }
        options.provider = "claude";
        index += 1;
        break;
      case "--session":
        if (!next) {
          throw new Error("--session requires a value");
        }
        options.sessionId = next;
        index += 1;
        break;
      case "--root":
        if (!next) {
          throw new Error("--root requires a value");
        }
        options.rootDir = expandHome(next);
        index += 1;
        break;
      case "--output":
        if (!next) {
          throw new Error("--output requires a value");
        }
        options.outputPath = expandHome(next);
        index += 1;
        break;
      case "--json-index":
        if (!next) {
          throw new Error("--json-index requires a value");
        }
        options.jsonIndexPath = expandHome(next);
        index += 1;
        break;
      case "--include-raw":
        options.includeRaw = true;
        options.includeSubagents = true;
        options.includeToolResults = true;
        options.includeDebug = true;
        options.includeHistory = true;
        options.includeTasks = true;
        options.includeTeams = true;
        options.includePlans = true;
        break;
      case "--include-subagents":
        options.includeSubagents = true;
        break;
      case "--include-tool-results":
        options.includeToolResults = true;
        break;
      case "--include-debug":
        options.includeDebug = true;
        break;
      case "--include-history":
        options.includeHistory = true;
        break;
      case "--include-tasks":
        options.includeTasks = true;
        break;
      case "--include-teams":
        options.includeTeams = true;
        break;
      case "--include-plans":
        options.includePlans = true;
        break;
      case "--redact":
        options.redact = true;
        break;
      case "--no-redact":
        options.redact = false;
        break;
      case "--strict":
        options.strict = true;
        break;
      case "--max-inline-bytes":
        if (!next) {
          throw new Error("--max-inline-bytes requires a value");
        }
        options.maxInlineBytes = Number.parseInt(next, 10);
        if (Number.isNaN(options.maxInlineBytes) || options.maxInlineBytes <= 0) {
          throw new Error("--max-inline-bytes must be a positive integer");
        }
        index += 1;
        break;
      case "--format":
        if (next !== "markdown") {
          throw new Error(`Unsupported format: ${String(next)}`);
        }
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.sessionId) {
    throw new Error("--session is required");
  }

  return options;
}

export async function buildMarkdownDump(
  loaded: LoadedSession,
  options: CliOptions,
): Promise<{ markdown: string; artifacts: ArtifactRecord[] }> {
  const artifacts = [...loaded.artifacts];
  const artifactByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));

  const renderInline = (artifactPath: string, text: string): string => {
    const redaction = redactText(text, options.redact);
    const artifact = artifactByPath.get(artifactPath);
    if (artifact) {
      artifact.included = true;
      for (const category of redaction.categories) {
        if (!artifact.redactionCategories.includes(category)) {
          artifact.redactionCategories.push(category);
        }
      }
    }
    return redaction.text;
  };

  const sections: string[] = [];
  sections.push("# Session Dump");
  sections.push("");
  sections.push("## Session Identity");
  sections.push("");
  sections.push(`- Provider: \`${loaded.provider}\``);
  sections.push(`- Session ID: \`${loaded.sessionId}\``);
  sections.push(`- Canonical transcript: \`${loaded.transcriptPath}\``);
  sections.push(`- Project slug: \`${loaded.projectSlug}\``);
  sections.push(`- Dump generated at: \`${new Date().toISOString()}\``);
  sections.push(`- Dumper entrypoint: \`${DUMPER_ENTRYPOINT}\``);

  sections.push("");
  sections.push("## High-Level Metadata");
  sections.push("");
  sections.push(`- First transcript timestamp: ${loaded.firstTimestamp ?? "unknown"}`);
  sections.push(`- Last transcript timestamp: ${loaded.lastTimestamp ?? "unknown"}`);
  sections.push(`- CWDs seen: ${formatList(loaded.cwds)}`);
  sections.push(`- Entrypoints seen: ${formatList(loaded.entrypoints)}`);
  sections.push(`- Claude versions seen: ${formatList(loaded.versions)}`);
  sections.push(`- Models seen: ${formatList(loaded.models)}`);
  sections.push(`- Git branches seen: ${formatList(loaded.gitBranches)}`);
  sections.push(`- Slugs seen: ${formatList(loaded.slugs)}`);
  sections.push(`- Sidechains present: ${loaded.hasSidechains ? "yes" : "no"}`);
  sections.push(`- Subagents discovered: ${loaded.subagents.length}`);
  sections.push(`- Team names discovered: ${loaded.teamNames.length > 0 ? loaded.teamNames.join(", ") : "none"}`);
  sections.push(`- Task list ids discovered: ${loaded.taskListIds.length > 0 ? loaded.taskListIds.join(", ") : "none"}`);
  sections.push(`- Plan files discovered: ${loaded.planPaths.length}`);
  sections.push("");
  sections.push("### Event Counts");
  sections.push("");
  for (const [key, value] of Object.entries(loaded.eventCounts).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    sections.push(`- \`${key}\`: ${value}`);
  }
  if (Object.keys(loaded.attachmentCounts).length > 0) {
    sections.push("");
    sections.push("### Attachment Counts");
    sections.push("");
    for (const [key, value] of Object.entries(loaded.attachmentCounts).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      sections.push(`- \`${key}\`: ${value}`);
    }
  }

  sections.push("");
  sections.push("## Artifact Inventory");
  sections.push("");
  sections.push("| Kind | Path | Exists | Included | Size | Notes |");
  sections.push("| --- | --- | --- | --- | --- | --- |");
  for (const artifact of artifacts) {
    sections.push(
      `| \`${artifact.kind}\` | \`${escapePipes(artifact.path)}\` | ${artifact.exists ? "yes" : "no"} | ${artifact.included ? "yes" : "no"} | ${formatSize(artifact.sizeBytes)} | ${escapePipes(formatArtifactNotes(artifact))} |`,
    );
  }

  sections.push("");
  sections.push("## Main Transcript");
  sections.push("");
  sections.push(`Source: \`${loaded.transcriptPath}\``);
  sections.push("");
  for (const event of normalizeTranscriptEvents(loaded.entries)) {
    sections.push(...renderEvent(event, loaded.transcriptPath, renderInline));
  }

  sections.push("");
  sections.push("## Related Artifacts");
  sections.push("");

  sections.push(...(await renderSubagentSection(loaded, options, renderInline)));
  sections.push(...(await renderArtifactContentSection("Plan files", artifacts, "plan_file", options, renderInline)));
  sections.push(...(await renderArtifactContentSection("Task files", artifacts, "task_file", options, renderInline)));
  sections.push(...(await renderArtifactContentSection("Queued task outputs", artifacts, "queue_output", options, renderInline)));
  sections.push(...(await renderArtifactContentSection("Team files", artifacts, ["team_config", "team_inbox"], options, renderInline)));
  sections.push(...(await renderArtifactContentSection("Tool result spill files", artifacts, "tool_result_spill", options, renderInline)));
  sections.push(...(await renderArtifactContentSection("Debug logs", artifacts, "debug_log", options, renderInline)));
  sections.push(...renderHistorySection(loaded, options, renderInline));
  sections.push(...(await renderArtifactContentSection("Session env artifacts", artifacts, "session_env", options, renderInline)));

  sections.push("");
  sections.push("## Gaps / Missing Data");
  sections.push("");
  const missingArtifacts = artifacts.filter((artifact) => !artifact.exists);
  if (missingArtifacts.length === 0 && loaded.warnings.length === 0 && loaded.parseWarnings.length === 0) {
    sections.push("- No missing-data warnings were recorded.");
  } else {
    for (const warning of loaded.warnings) {
      sections.push(`- ${warning}`);
    }
    for (const warning of loaded.parseWarnings) {
      sections.push(`- ${warning}`);
    }
    for (const artifact of missingArtifacts) {
      sections.push(`- Missing referenced artifact: \`${artifact.path}\` (${artifact.relation})`);
    }
  }

  const redactedArtifacts = artifacts.filter((artifact) => artifact.redactionCategories.length > 0);
  sections.push("");
  sections.push("### Redaction Report");
  sections.push("");
  if (redactedArtifacts.length === 0) {
    sections.push(`- Redaction enabled: ${options.redact ? "yes" : "no"}`);
    sections.push("- No redactions were applied to inlined content.");
  } else {
    sections.push(`- Redaction enabled: ${options.redact ? "yes" : "no"}`);
    for (const artifact of redactedArtifacts) {
      sections.push(
        `- \`${artifact.path}\`: ${artifact.redactionCategories.join(", ")}`,
      );
    }
  }

  sections.push("");
  sections.push("## Continuation Notes");
  sections.push("");
  const continuationNotes = buildContinuationNotes(loaded);
  for (const note of continuationNotes) {
    sections.push(`- ${note}`);
  }

  return { markdown: `${sections.join("\n").trimEnd()}\n`, artifacts };
}

function normalizeTranscriptEvents(entries: LoadedSession["entries"]): RenderedEvent[] {
  const events: RenderedEvent[] = [];

  for (const entry of entries) {
    const raw = entry.raw as Record<string, unknown>;
    const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : undefined;
    const type = typeof raw.type === "string" ? raw.type : "unknown";

    switch (type) {
      case "user": {
        const message = raw.message as Record<string, unknown> | undefined;
        if (typeof message?.content === "string") {
          events.push({
            timestamp,
            heading: "User message",
            body: message.content,
            kind: "user_message",
          });
          break;
        }

        for (const block of resolveMessageContent(entry)) {
          if (block.type === "tool_result") {
            const toolUseId =
              typeof block.tool_use_id === "string" ? block.tool_use_id : "unknown";
            const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null, null, 2);
            events.push({
              timestamp,
              heading: `Tool result: ${toolUseId}`,
              body: content,
              kind: "tool_result",
            });
          } else if (block.type === "text" && typeof block.text === "string") {
            events.push({
              timestamp,
              heading: "User text block",
              body: block.text,
              kind: "user_text_block",
            });
          }
        }
        break;
      }

      case "assistant": {
        const message = raw.message as Record<string, unknown> | undefined;
        for (const block of resolveMessageContent(entry)) {
          if (block.type === "text" && typeof block.text === "string") {
            events.push({
              timestamp,
              heading: "Assistant message",
              body: block.text,
              kind: "assistant_message",
            });
          } else if (block.type === "tool_use") {
            const name = typeof block.name === "string" ? block.name : "unknown";
            events.push({
              timestamp,
              heading: `Tool call: ${name}`,
              body: summarizeToolUseBlock(block),
              kind: "tool_call",
            });
          } else if (block.type === "thinking") {
            events.push({
              timestamp,
              heading: "Assistant thinking block",
              body: describeThinkingBlock(block),
              kind: "assistant_thinking",
            });
          } else if (block.type === "redacted_thinking") {
            events.push({
              timestamp,
              heading: "Assistant redacted thinking block",
              body: "Redacted thinking content present in transcript.",
              kind: "assistant_redacted_thinking",
            });
          }
        }
        if (message && typeof message.stop_reason === "string") {
          events.push({
            timestamp,
            heading: "Assistant stop reason",
            body: message.stop_reason,
            kind: "assistant_stop_reason",
          });
        }
        break;
      }

      case "attachment": {
        const attachment = raw.attachment as Record<string, unknown> | undefined;
        events.push({
          timestamp,
          heading: `Attachment: ${String(attachment?.type ?? "unknown")}`,
          body: summarizeAttachment(attachment),
          kind: "attachment",
        });
        break;
      }

      case "system": {
        events.push({
          timestamp,
          heading: `System event: ${String(raw.subtype ?? "unknown")}`,
          body: summarizeSystemEvent(raw),
          kind: "system",
        });
        break;
      }

      case "last-prompt": {
        events.push({
          timestamp,
          heading: "Last prompt marker",
          body:
            typeof raw.lastPrompt === "string"
              ? raw.lastPrompt
              : "Last-prompt payload missing.",
          kind: "last_prompt",
        });
        break;
      }

      case "permission-mode": {
        events.push({
          timestamp,
          heading: "Permission mode",
          body:
            typeof raw.permissionMode === "string"
              ? raw.permissionMode
              : JSON.stringify(raw, null, 2),
          kind: "permission_mode",
        });
        break;
      }

      case "queue-operation": {
        events.push({
          timestamp,
          heading: `Queue operation: ${String(raw.operation ?? "unknown")}`,
          body: summarizeQueueOperation(raw),
          kind: "queue_operation",
        });
        break;
      }

      case "file-history-snapshot": {
        events.push({
          timestamp:
            typeof (raw.snapshot as Record<string, unknown> | undefined)?.timestamp ===
            "string"
              ? ((raw.snapshot as Record<string, unknown>).timestamp as string)
              : timestamp,
          heading: "File history snapshot",
          body: summarizeFileHistorySnapshot(raw),
          kind: "file_history_snapshot",
        });
        break;
      }

      default:
        break;
    }
  }

  return events;
}

function renderEvent(
  event: RenderedEvent,
  artifactPath: string,
  renderInline: (artifactPath: string, text: string) => string,
): string[] {
  const lines = [`### ${event.heading}`];
  if (event.timestamp) {
    lines.push("");
    lines.push(`- Timestamp: \`${event.timestamp}\``);
  }
  if (event.body) {
    lines.push("");
    lines.push("```text");
    lines.push(renderInline(artifactPath, event.body));
    lines.push("```");
  }
  lines.push("");
  return lines;
}

async function renderSubagentSection(
  loaded: LoadedSession,
  options: CliOptions,
  renderInline: (artifactPath: string, text: string) => string,
): Promise<string[]> {
  const lines: string[] = ["### Subagents", ""];
  if (loaded.subagents.length === 0) {
    lines.push("- No subagent transcripts were discovered.");
    lines.push("");
    return lines;
  }

  for (const subagent of loaded.subagents) {
    lines.push(`#### Agent \`${subagent.agentId}\``);
    lines.push("");
    lines.push(`- Transcript: \`${subagent.transcriptPath}\``);
    lines.push(`- Events: ${subagent.eventCount}`);
    lines.push(`- First timestamp: ${subagent.firstTimestamp ?? "unknown"}`);
    lines.push(`- Last timestamp: ${subagent.lastTimestamp ?? "unknown"}`);
    lines.push(
      `- First user prompt: ${subagent.firstUserPrompt ? `\`${truncate(subagent.firstUserPrompt, 120)}\`` : "not found"}`,
    );
    if (subagent.metaPath) {
      lines.push(`- Meta: \`${subagent.metaPath}\``);
    }
    if (options.includeRaw || options.includeSubagents) {
      lines.push("");
      lines.push("```text");
      lines.push(
        renderInline(
          subagent.transcriptPath,
          await Bun.file(subagent.transcriptPath).text(),
        ),
      );
      lines.push("```");
    }
    lines.push("");
  }
  return lines;
}

async function renderArtifactContentSection(
  heading: string,
  artifacts: ArtifactRecord[],
  kinds: ArtifactRecord["kind"] | ArtifactRecord["kind"][],
  options: CliOptions,
  renderInline: (artifactPath: string, text: string) => string,
): Promise<string[]> {
  const kindList = Array.isArray(kinds) ? kinds : [kinds];
  const matching = artifacts.filter((artifact) => kindList.includes(artifact.kind));
  const lines: string[] = [`### ${heading}`, ""];
  if (matching.length === 0) {
    lines.push("- None discovered.");
    lines.push("");
    return lines;
  }

  for (const artifact of matching) {
    lines.push(`#### \`${artifact.path}\``);
    lines.push("");
    lines.push(`- Relation: ${artifact.relation}`);
    lines.push(`- Exists: ${artifact.exists ? "yes" : "no"}`);
    lines.push(`- Size: ${formatSize(artifact.sizeBytes)}`);
    if (artifact.notes.length > 0) {
      lines.push(`- Notes: ${artifact.notes.join(" | ")}`);
    }
    if (artifact.exists && artifact.included && shouldInlineArtifact(artifact, options)) {
      lines.push("");
      lines.push("```text");
      lines.push(renderInline(artifact.path, await Bun.file(artifact.path).text()));
      lines.push("```");
    }
    lines.push("");
  }

  return lines;
}

function renderHistorySection(
  loaded: LoadedSession,
  options: CliOptions,
  renderInline: (artifactPath: string, text: string) => string,
): string[] {
  const lines: string[] = ["### History matches", ""];
  if (loaded.historyMatches.length === 0) {
    lines.push("- No matching history.jsonl entries were found.");
    lines.push("");
    return lines;
  }

  const historyPath =
    loaded.artifacts.find((artifact) => artifact.kind === "history_file")?.path ??
    path.join(loaded.transcriptPath, "..", "..", "..", "history.jsonl");

  lines.push(`- Source: \`${historyPath}\``);
  lines.push(`- Matches: ${loaded.historyMatches.length}`);
  lines.push("");

  if (options.includeRaw || options.includeHistory) {
    for (const match of loaded.historyMatches) {
      const body = JSON.stringify(match, null, 2);
      lines.push("```json");
      lines.push(renderInline(historyPath, body));
      lines.push("```");
      lines.push("");
    }
  }

  return lines;
}

function shouldInlineArtifact(artifact: ArtifactRecord, options: CliOptions): boolean {
  if (options.includeRaw) {
    return true;
  }
  return artifact.sizeBytes !== undefined && artifact.sizeBytes <= options.maxInlineBytes;
}

function buildContinuationNotes(loaded: LoadedSession): string[] {
  const notes: string[] = [];
  const lastHistory = loaded.historyMatches.at(-1);
  if (lastHistory?.display) {
    notes.push(`Last matching history entry: \`${truncate(lastHistory.display, 160)}\``);
  }
  const lastUserMessage = [...loaded.entries]
    .reverse()
    .map((entry) => entry.raw as Record<string, unknown>)
    .find((raw) => raw.type === "user" && typeof (raw.message as Record<string, unknown> | undefined)?.content === "string");
  const lastPromptEntry = [...loaded.entries]
    .reverse()
    .map((entry) => entry.raw as Record<string, unknown>)
    .find((raw) => raw.type === "last-prompt");

  if (
    lastUserMessage &&
    typeof (lastUserMessage.message as Record<string, unknown>).content === "string"
  ) {
    notes.push(
      `Last plain user message in transcript: \`${truncate((lastUserMessage.message as Record<string, unknown>).content as string, 160)}\``,
    );
  }
  if (typeof lastPromptEntry?.lastPrompt === "string") {
    notes.push(`Last prompt marker: \`${truncate(lastPromptEntry.lastPrompt, 160)}\``);
  }

  const lastAssistant = [...loaded.entries]
    .reverse()
    .map((entry) => entry.raw as Record<string, unknown>)
    .find((raw) => raw.type === "assistant");
  if (lastAssistant) {
    const message = lastAssistant.message as Record<string, unknown> | undefined;
    notes.push(
      `Last assistant event timestamp: \`${String(lastAssistant.timestamp ?? "unknown")}\``,
    );
    if (typeof message?.stop_reason === "string") {
      notes.push(`Last assistant stop reason: \`${message.stop_reason}\``);
    }
  }

  const lastToolResultEntry = [...loaded.entries]
    .reverse()
    .find((entry) => extractPersistedOutputPathsFromEntry(entry).length > 0);
  if (lastToolResultEntry) {
    notes.push(
      `Last persisted-output reference appeared on transcript line ${lastToolResultEntry.line}.`,
    );
  }

  if (loaded.historyMatches.some((match) => match.display === "/exit")) {
    notes.push("A matching `/exit` command exists in history.jsonl.");
  }
  if (loaded.subagents.length === 0) {
    notes.push("No subagent transcripts were found for this session.");
  }
  if (notes.length === 0) {
    notes.push("No deterministic continuation cues were derived beyond the transcript itself.");
  }
  return notes;
}

function summarizeAttachment(attachment?: Record<string, unknown>): string {
  if (!attachment) {
    return "Attachment payload missing.";
  }
  const parts: string[] = [];
  for (const key of [
    "hookName",
    "hookEvent",
    "toolUseID",
    "planFilePath",
    "command",
    "durationMs",
    "content",
    "skillCount",
  ]) {
    const value = attachment[key];
    if (value === undefined) {
      continue;
    }
    parts.push(`${key}: ${typeof value === "string" ? truncate(value, 240) : JSON.stringify(value)}`);
  }
  if (parts.length === 0) {
    return JSON.stringify(attachment, null, 2);
  }
  return parts.join("\n");
}

function summarizeSystemEvent(raw: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof raw.subtype === "string") {
    parts.push(`subtype: ${raw.subtype}`);
  }
  if (typeof raw.durationMs === "number") {
    parts.push(`durationMs: ${raw.durationMs}`);
  }
  if (typeof raw.messageCount === "number") {
    parts.push(`messageCount: ${raw.messageCount}`);
  }
  if (typeof raw.content === "string") {
    parts.push(`content: ${truncate(raw.content, 400)}`);
  }
  if (parts.length === 0) {
    return JSON.stringify(raw, null, 2);
  }
  return parts.join("\n");
}

function summarizeQueueOperation(raw: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof raw.operation === "string") {
    parts.push(`operation: ${raw.operation}`);
  }
  if (typeof raw.content === "string") {
    parts.push(raw.content);
  }
  if (parts.length === 0) {
    return JSON.stringify(raw, null, 2);
  }
  return parts.join("\n");
}

function summarizeFileHistorySnapshot(raw: Record<string, unknown>): string {
  const snapshot = raw.snapshot as Record<string, unknown> | undefined;
  if (!snapshot) {
    return "Snapshot payload missing.";
  }

  const parts: string[] = [];
  if (typeof snapshot.messageId === "string") {
    parts.push(`messageId: ${snapshot.messageId}`);
  }
  if (typeof snapshot.timestamp === "string") {
    parts.push(`timestamp: ${snapshot.timestamp}`);
  }
  if (typeof raw.isSnapshotUpdate === "boolean") {
    parts.push(`isSnapshotUpdate: ${raw.isSnapshotUpdate}`);
  }

  const tracked = snapshot.trackedFileBackups;
  if (tracked && typeof tracked === "object") {
    const entries = Object.entries(tracked as Record<string, unknown>);
    if (entries.length === 0) {
      parts.push("trackedFileBackups: none");
    } else {
      parts.push("trackedFileBackups:");
      for (const [filePath, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
        if (value && typeof value === "object") {
          const backup = value as Record<string, unknown>;
          parts.push(
            `- ${filePath}: backupFileName=${String(backup.backupFileName ?? "null")}, version=${String(backup.version ?? "unknown")}, backupTime=${String(backup.backupTime ?? "unknown")}`,
          );
        } else {
          parts.push(`- ${filePath}: ${JSON.stringify(value)}`);
        }
      }
    }
  }

  return parts.join("\n");
}

function summarizeToolUseBlock(block: Record<string, unknown>): string {
  const id = typeof block.id === "string" ? block.id : "unknown";
  const input = block.input !== undefined ? JSON.stringify(block.input, null, 2) : "{}";
  return `id: ${id}\ninput:\n${input}`;
}

function describeThinkingBlock(block: Record<string, unknown>): string {
  const thinking = typeof block.thinking === "string" ? block.thinking : "";
  if (thinking.length === 0) {
    return "Empty thinking block recorded in transcript.";
  }
  return `Thinking text length: ${thinking.length} characters`;
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function formatList(values: string[]): string {
  if (values.length === 0) {
    return "none";
  }
  return values.map((value) => `\`${value}\``).join(", ");
}

function formatSize(sizeBytes?: number): string {
  if (sizeBytes === undefined) {
    return "unknown";
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KiB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatArtifactNotes(artifact: ArtifactRecord): string {
  const parts = [artifact.relation, ...artifact.notes];
  if (artifact.redactionCategories.length > 0) {
    parts.push(`redacted: ${artifact.redactionCategories.join(", ")}`);
  }
  return parts.join(" | ");
}

function escapePipes(value: string): string {
  return value.replaceAll("|", "\\|");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function printHelp(): void {
  process.stdout.write(`session-dump

Usage:
  bun run session-dump --provider claude --session <session-id> [options]

Options:
  --provider claude
  --session <id>
  --root <path>
  --output <file>
  --json-index <file>
  --include-raw
  --include-subagents
  --include-tool-results
  --include-debug
  --include-history
  --include-tasks
  --include-teams
  --include-plans
  --redact
  --no-redact
  --strict
  --max-inline-bytes <n>
  --format markdown
  -h, --help
`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
