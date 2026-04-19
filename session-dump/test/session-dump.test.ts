import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildMarkdownDump } from "../src/index.ts";
import { loadClaudeSession } from "../src/providers/claude.ts";
import type { CliOptions } from "../src/types.ts";

async function writeJsonl(filePath: string, entries: unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const text = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await writeFile(filePath, text, "utf8");
}

function createOptions(rootDir: string, sessionId: string): CliOptions {
  return {
    provider: "claude",
    sessionId,
    rootDir,
    includeRaw: false,
    includeSubagents: true,
    includeToolResults: true,
    includeDebug: true,
    includeHistory: true,
    includeTasks: true,
    includeTeams: true,
    includePlans: true,
    redact: true,
    format: "markdown",
    maxInlineBytes: 50_000,
    strict: false,
  };
}

describe("session dump integration", () => {
  test("loads Claude artifacts and renders markdown with extended event coverage", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "session-dump-fixture-"));
    const sessionId = "session-123";
    const projectSlug = "-fixture-project";
    const projectDir = path.join(rootDir, "projects", projectSlug);
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    const siblingDir = path.join(projectDir, sessionId);
    const persistedOutputPath = path.join(siblingDir, "tool-results", "spill.txt");
    const queueOutputPath = path.join(rootDir, "runtime", "queue-output.txt");
    const planPath = path.join(rootDir, "plans", "fixture-slug.md");
    const debugPath = path.join(rootDir, "debug", `${sessionId}.txt`);
    const sessionEnvPath = path.join(rootDir, "session-env", "fixture.env");
    const taskPath = path.join(rootDir, "tasks", sessionId, "001.json");
    const teamName = "alpha-team";
    const teamConfigPath = path.join(rootDir, "teams", teamName, "config.json");
    const teamInboxPath = path.join(rootDir, "teams", teamName, "inboxes", "0001.json");
    const teamTaskPath = path.join(rootDir, "tasks", teamName, "001.json");
    const subagentPath = path.join(siblingDir, "subagents", "agent-a.jsonl");
    const subagentMetaPath = path.join(siblingDir, "subagents", "agent-a.meta.json");
    const historyPath = path.join(rootDir, "history.jsonl");

    await mkdir(path.dirname(persistedOutputPath), { recursive: true });
    await mkdir(path.dirname(queueOutputPath), { recursive: true });
    await mkdir(path.dirname(planPath), { recursive: true });
    await mkdir(path.dirname(debugPath), { recursive: true });
    await mkdir(path.dirname(sessionEnvPath), { recursive: true });
    await mkdir(path.dirname(taskPath), { recursive: true });
    await mkdir(path.dirname(teamConfigPath), { recursive: true });
    await mkdir(path.dirname(teamInboxPath), { recursive: true });
    await mkdir(path.dirname(teamTaskPath), { recursive: true });
    await mkdir(path.dirname(subagentPath), { recursive: true });

    await writeFile(
      persistedOutputPath,
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "utf8",
    );
    await writeFile(queueOutputPath, "queue finished successfully", "utf8");
    await writeFile(planPath, "deploy plan\nCF_API_TOKEN=very-secret-token", "utf8");
    await writeFile(debugPath, "debug trace", "utf8");
    await writeFile(sessionEnvPath, `SESSION_ID=${sessionId}\nMODE=fixture\n`, "utf8");
    await writeFile(taskPath, '{"task":"session"}\n', "utf8");
    await writeFile(teamConfigPath, JSON.stringify({ leadSessionId: sessionId }, null, 2), "utf8");
    await writeFile(teamInboxPath, '{"message":"hi"}\n', "utf8");
    await writeFile(teamTaskPath, '{"task":"team"}\n', "utf8");
    await writeFile(subagentMetaPath, '{"kind":"meta"}\n', "utf8");
    await writeJsonl(subagentPath, [
      {
        type: "user",
        timestamp: "2026-04-18T20:00:00.000Z",
        agentId: "agent-a",
        message: { content: "Investigate queue output" },
      },
      {
        type: "assistant",
        timestamp: "2026-04-18T20:00:01.000Z",
        agentId: "agent-a",
        message: { content: [{ type: "text", text: "Subagent response" }] },
      },
    ]);
    await writeJsonl(historyPath, [
      {
        timestamp: 1,
        display: "/resume previous task",
        project: "/tmp/project",
        sessionId,
      },
    ]);

    await writeJsonl(transcriptPath, [
      {
        type: "permission-mode",
        permissionMode: "bypassPermissions",
        sessionId,
      },
      {
        type: "attachment",
        timestamp: "2026-04-18T20:00:00.000Z",
        sessionId,
        cwd: "/tmp/project",
        entrypoint: "cli",
        version: "2.1.114",
        gitBranch: "main",
        attachment: {
          type: "plan_file_reference",
          planFilePath: planPath,
        },
      },
      {
        type: "user",
        timestamp: "2026-04-18T20:00:01.000Z",
        sessionId,
        cwd: "/tmp/project",
        entrypoint: "cli",
        version: "2.1.114",
        gitBranch: "main",
        slug: "fixture-slug",
        message: {
          role: "user",
          content: "Please inspect the Claude session.",
        },
      },
      {
        type: "assistant",
        timestamp: "2026-04-18T20:00:02.000Z",
        sessionId,
        cwd: "/tmp/project",
        entrypoint: "cli",
        version: "2.1.114",
        gitBranch: "main",
        slug: "fixture-slug",
        message: {
          model: "claude-opus-4-7",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: "Read",
              input: { file_path: "/tmp/project/file.ts" },
            },
            {
              type: "text",
              text: "I will inspect the file.",
            },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-04-18T20:00:03.000Z",
        sessionId,
        cwd: "/tmp/project",
        entrypoint: "cli",
        version: "2.1.114",
        gitBranch: "main",
        slug: "fixture-slug",
        toolUseResult: {
          persistedOutputPath,
        },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: `Read completed\nFull output saved to: ${persistedOutputPath}`,
            },
          ],
        },
      },
      {
        type: "system",
        subtype: "away_summary",
        content: "Summarize the current state before resuming.",
        timestamp: "2026-04-18T20:00:04.000Z",
        sessionId,
        cwd: "/tmp/project",
        entrypoint: "cli",
        version: "2.1.114",
        gitBranch: "main",
        slug: "fixture-slug",
      },
      {
        type: "last-prompt",
        lastPrompt: "continue from the last checkpoint",
        sessionId,
      },
      {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-04-18T20:00:05.000Z",
        sessionId,
        content: `<task-notification>\n<task-id>task-1</task-id>\n<output-file>${queueOutputPath}</output-file>\n<status>completed</status>\n</task-notification>`,
      },
      {
        type: "file-history-snapshot",
        messageId: "msg-1",
        isSnapshotUpdate: true,
        snapshot: {
          messageId: "msg-1",
          timestamp: "2026-04-18T20:00:06.000Z",
          trackedFileBackups: {
            "src/index.ts": {
              backupFileName: "backup@v1",
              version: 1,
              backupTime: "2026-04-18T20:00:06.000Z",
            },
          },
        },
      },
    ]);

    const options = createOptions(rootDir, sessionId);
    const loaded = await loadClaudeSession(options);

    expect(loaded.transcriptPath).toBe(transcriptPath);
    expect(loaded.projectSlug).toBe(projectSlug);
    expect(loaded.models).toContain("claude-opus-4-7");
    expect(loaded.planPaths).toContain(planPath);
    expect(loaded.teamNames).toContain(teamName);
    expect(loaded.taskListIds).toEqual([teamName, sessionId]);
    expect(loaded.subagents).toHaveLength(1);
    expect(loaded.historyMatches).toHaveLength(1);
    expect(loaded.sessionEnvPaths).toContain(sessionEnvPath);
    expect(loaded.warnings).not.toContain("No session-env files were found for this session.");
    expect(loaded.warnings).not.toContain("No subagent transcripts were discovered for this session.");
    expect(loaded.warnings).not.toContain("No plan file references were discovered for this session.");
    expect(loaded.artifacts.some((artifact) => artifact.kind === "tool_result_spill" && artifact.path === persistedOutputPath)).toBe(true);
    expect(loaded.artifacts.some((artifact) => artifact.kind === "queue_output" && artifact.path === queueOutputPath)).toBe(true);

    const rendered = await buildMarkdownDump(loaded, options);

    expect(rendered.markdown).toContain("## Main Transcript");
    expect(rendered.markdown).toContain("### Permission mode");
    expect(rendered.markdown).toContain("### System event: away_summary");
    expect(rendered.markdown).toContain("### Last prompt marker");
    expect(rendered.markdown).toContain("### Queue operation: enqueue");
    expect(rendered.markdown).toContain("### File history snapshot");
    expect(rendered.markdown).toContain("### Queued task outputs");
    expect(rendered.markdown).toContain("### Subagents");
    expect(rendered.markdown).toContain("agent-a");
    expect(rendered.markdown).toContain(queueOutputPath);
    expect(rendered.markdown).toContain(planPath);
    expect(rendered.markdown).toContain("[REDACTED:bearer_token]");
    expect(rendered.markdown).toContain("[REDACTED:cloudflare_token]");
    expect(rendered.markdown).toContain("trackedFileBackups:");
    expect(rendered.artifacts.some((artifact) => artifact.redactionCategories.includes("bearer_token"))).toBe(true);
    expect(rendered.artifacts.some((artifact) => artifact.redactionCategories.includes("cloudflare_token"))).toBe(true);
  });
});
