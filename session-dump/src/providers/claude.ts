import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactRecord,
  CliOptions,
  HistoryMatch,
  LoadedSession,
  ParsedSubagent,
  TranscriptEntry,
} from "../types.ts";

const persistedOutputPattern = /Full output saved to:\s*(.+)$/m;
const queueOutputPattern = /<output-file>([^<]+)<\/output-file>/g;

export async function resolveClaudeTranscriptPath(
  rootDir: string,
  sessionId: string,
): Promise<{ transcriptPath: string; projectSlug: string } | null> {
  const projectsDir = path.join(rootDir, "projects");
  let projectEntries;
  try {
    projectEntries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) {
      continue;
    }
    const transcriptPath = path.join(
      projectsDir,
      projectEntry.name,
      `${sessionId}.jsonl`,
    );
    try {
      const transcriptStat = await stat(transcriptPath);
      if (transcriptStat.isFile()) {
        return { transcriptPath, projectSlug: projectEntry.name };
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function extractPersistedOutputPathsFromEntry(
  entry: TranscriptEntry,
): string[] {
  const paths = new Set<string>();
  const raw = entry.raw as Record<string, unknown>;
  const toolUseResult = raw.toolUseResult as
    | Record<string, unknown>
    | string
    | undefined;

  if (
    toolUseResult &&
    typeof toolUseResult === "object" &&
    typeof toolUseResult.persistedOutputPath === "string"
  ) {
    paths.add(toolUseResult.persistedOutputPath);
  }

  const contentBlocks = resolveMessageContent(entry);
  for (const block of contentBlocks) {
    if (block.type !== "tool_result" || typeof block.content !== "string") {
      continue;
    }
    const match = block.content.match(persistedOutputPattern);
    if (match?.[1]) {
      paths.add(match[1].trim());
    }
  }

  return [...paths];
}

export function resolveMessageContent(
  entry: TranscriptEntry,
): Array<Record<string, unknown>> {
  const raw = entry.raw as Record<string, unknown>;
  const message = raw.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    return content.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    );
  }
  return [];
}

export async function loadClaudeSession(options: CliOptions): Promise<LoadedSession> {
  const resolved = await resolveClaudeTranscriptPath(options.rootDir, options.sessionId);
  if (!resolved) {
    throw new Error(
      `Could not find Claude transcript for session ${options.sessionId} under ${options.rootDir}/projects`,
    );
  }

  const transcriptText = await Bun.file(resolved.transcriptPath).text();
  const entries: TranscriptEntry[] = [];
  const parseWarnings: string[] = [];
  const lines = transcriptText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    try {
      entries.push({ line: index + 1, raw: JSON.parse(line) as Record<string, unknown> });
    } catch (error) {
      parseWarnings.push(
        `Failed to parse JSONL line ${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const artifacts = new Map<string, ArtifactRecord>();
  const warnings: string[] = [];

  await upsertArtifact(artifacts, {
    kind: "transcript",
    path: resolved.transcriptPath,
    relation: "canonical transcript",
    exists: true,
    included: true,
    notes: [],
    redactionCategories: [],
  });

  const cwds = new Set<string>();
  const entrypoints = new Set<string>();
  const versions = new Set<string>();
  const models = new Set<string>();
  const gitBranches = new Set<string>();
  const slugs = new Set<string>();
  const attachmentCounts: Record<string, number> = {};
  const eventCounts: Record<string, number> = {};
  const planPaths = new Set<string>();
  const teamNames = new Set<string>();
  const taskListIds = new Set<string>();
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let hasSidechains = false;

  for (const entry of entries) {
    const raw = entry.raw as Record<string, unknown>;
    if (typeof raw.timestamp === "string") {
      firstTimestamp ??= raw.timestamp;
      lastTimestamp = raw.timestamp;
    }
    if (typeof raw.cwd === "string") {
      cwds.add(raw.cwd);
    }
    if (typeof raw.entrypoint === "string") {
      entrypoints.add(raw.entrypoint);
    }
    if (typeof raw.version === "string") {
      versions.add(raw.version);
    }
    if (typeof raw.gitBranch === "string") {
      gitBranches.add(raw.gitBranch);
    }
    if (typeof raw.slug === "string") {
      slugs.add(raw.slug);
    }
    if (raw.isSidechain === true) {
      hasSidechains = true;
    }

    const type = typeof raw.type === "string" ? raw.type : "unknown";
    eventCounts[type] = (eventCounts[type] ?? 0) + 1;

    if (type === "assistant") {
      const message = raw.message as Record<string, unknown> | undefined;
      if (typeof message?.model === "string") {
        models.add(message.model);
      }
    }

    if (type === "attachment") {
      const attachment = raw.attachment as Record<string, unknown> | undefined;
      const attachmentType =
        typeof attachment?.type === "string" ? attachment.type : "unknown";
      attachmentCounts[attachmentType] = (attachmentCounts[attachmentType] ?? 0) + 1;

      if (
        attachmentType === "plan_file_reference" &&
        typeof attachment?.planFilePath === "string"
      ) {
        planPaths.add(attachment.planFilePath);
      }
    }

    for (const persistedPath of extractPersistedOutputPathsFromEntry(entry)) {
      await upsertArtifact(artifacts, {
        kind: "tool_result_spill",
        path: persistedPath,
        relation: "persisted tool output referenced by transcript",
        exists: await fileExists(persistedPath),
        included: options.includeRaw || options.includeToolResults,
        notes: [],
        redactionCategories: [],
      });
    }

    for (const queueOutputPath of extractQueueOutputPathsFromEntry(entry)) {
      await upsertArtifact(artifacts, {
        kind: "queue_output",
        path: queueOutputPath,
        relation: "queued task output referenced by queue-operation event",
        exists: await fileExists(queueOutputPath),
        included: options.includeRaw || options.includeTasks,
        notes: [],
        redactionCategories: [],
      });
    }
  }

  const siblingDir = path.join(path.dirname(resolved.transcriptPath), options.sessionId);
  const subagents = await loadSubagents(
    siblingDir,
    options,
    artifacts,
    warnings,
  );

  const debugPath = path.join(options.rootDir, "debug", `${options.sessionId}.txt`);
  if (await fileExists(debugPath)) {
    await upsertArtifact(artifacts, {
      kind: "debug_log",
      path: debugPath,
      relation: "session-specific debug log",
      exists: true,
      included: options.includeRaw || options.includeDebug,
      notes: [],
      redactionCategories: [],
    });
  }

  const historyMatches = await loadHistoryMatches(options.rootDir, options.sessionId, artifacts);

  const sessionTaskDir = path.join(options.rootDir, "tasks", options.sessionId);
  const sessionTaskCount = await addTaskDirectoryArtifacts(
    sessionTaskDir,
    options,
    artifacts,
  );
  if (sessionTaskCount > 0) {
    taskListIds.add(options.sessionId);
  }

  const linkedTeams = await discoverLinkedTeams(options.rootDir, options.sessionId);
  for (const teamName of linkedTeams) {
    teamNames.add(teamName);
    const teamConfigPath = path.join(options.rootDir, "teams", teamName, "config.json");
    await upsertArtifact(artifacts, {
      kind: "team_config",
      path: teamConfigPath,
      relation: "team config linked by leadSessionId",
      exists: await fileExists(teamConfigPath),
      included: options.includeRaw || options.includeTeams,
      notes: [],
      redactionCategories: [],
    });

    const inboxDir = path.join(options.rootDir, "teams", teamName, "inboxes");
    const inboxArtifacts = await listFiles(inboxDir);
    for (const inboxPath of inboxArtifacts) {
      await upsertArtifact(artifacts, {
        kind: "team_inbox",
        path: inboxPath,
        relation: `team inbox for ${teamName}`,
        exists: true,
        included: options.includeRaw || options.includeTeams,
        notes: [],
        redactionCategories: [],
      });
    }

    const teamTaskDir = path.join(options.rootDir, "tasks", teamName);
    const teamTaskCount = await addTaskDirectoryArtifacts(teamTaskDir, options, artifacts);
    if (teamTaskCount > 0) {
      taskListIds.add(teamName);
    }
  }

  for (const planPath of planPaths) {
    await upsertArtifact(artifacts, {
      kind: "plan_file",
      path: planPath,
      relation: "explicit plan file reference from transcript",
      exists: await fileExists(planPath),
      included: options.includeRaw || options.includePlans,
      notes: [],
      redactionCategories: [],
    });
  }

  for (const slug of slugs) {
    const candidatePlanPath = path.join(options.rootDir, "plans", `${slug}.md`);
    if (await fileExists(candidatePlanPath)) {
      planPaths.add(candidatePlanPath);
      await upsertArtifact(artifacts, {
        kind: "plan_file",
        path: candidatePlanPath,
        relation: "plan candidate matched by session slug",
        exists: true,
        included: options.includeRaw || options.includePlans,
        notes: ["Matched by slug; verify relevance to the session."],
        redactionCategories: [],
      });
    }
  }

  const sessionEnvPaths = await discoverSessionEnvPaths(options.rootDir, options.sessionId);
  for (const sessionEnvPath of sessionEnvPaths) {
    await upsertArtifact(artifacts, {
      kind: "session_env",
      path: sessionEnvPath,
      relation: "session-env artifact matched by filename or content",
      exists: true,
      included: options.includeRaw,
      notes: [],
      redactionCategories: [],
    });
  }

  if (sessionEnvPaths.length === 0) {
    warnings.push("No session-env files were found for this session.");
  }
  if (subagents.length === 0) {
    warnings.push("No subagent transcripts were discovered for this session.");
  }
  if (planPaths.size === 0) {
    warnings.push("No plan file references were discovered for this session.");
  }

  return {
    provider: "claude",
    sessionId: options.sessionId,
    transcriptPath: resolved.transcriptPath,
    projectSlug: resolved.projectSlug,
    entries,
    artifacts: sortArtifacts([...artifacts.values()]),
    warnings,
    parseWarnings,
    historyMatches,
    subagents,
    debugPath: (await fileExists(debugPath)) ? debugPath : undefined,
    sessionEnvPaths,
    firstTimestamp,
    lastTimestamp,
    cwds: [...cwds].sort(),
    entrypoints: [...entrypoints].sort(),
    versions: [...versions].sort(),
    models: [...models].sort(),
    gitBranches: [...gitBranches].sort(),
    slugs: [...slugs].sort(),
    hasSidechains,
    attachmentCounts,
    eventCounts,
    planPaths: [...planPaths].sort(),
    teamNames: [...teamNames].sort(),
    taskListIds: [...taskListIds].sort(),
  };
}

function extractQueueOutputPathsFromEntry(entry: TranscriptEntry): string[] {
  const raw = entry.raw as Record<string, unknown>;
  if (raw.type !== "queue-operation" || typeof raw.content !== "string") {
    return [];
  }

  const matches = new Set<string>();
  for (const match of raw.content.matchAll(queueOutputPattern)) {
    const candidate = match[1]?.trim();
    if (candidate) {
      matches.add(candidate);
    }
  }
  return [...matches];
}

async function loadSubagents(
  siblingDir: string,
  options: CliOptions,
  artifacts: Map<string, ArtifactRecord>,
  warnings: string[],
): Promise<ParsedSubagent[]> {
  const subagentsDir = path.join(siblingDir, "subagents");
  const files = await listFiles(subagentsDir);
  const transcriptPaths = files.filter((filePath) => filePath.endsWith(".jsonl"));
  const subagents: ParsedSubagent[] = [];

  for (const transcriptPath of transcriptPaths) {
    const basename = path.basename(transcriptPath, ".jsonl");
    const metaPath = path.join(subagentsDir, `${basename}.meta.json`);
    await upsertArtifact(artifacts, {
      kind: "subagent_transcript",
      path: transcriptPath,
      relation: "subagent transcript",
      exists: true,
      included: options.includeRaw || options.includeSubagents,
      notes: [],
      redactionCategories: [],
    });
    if (await fileExists(metaPath)) {
      await upsertArtifact(artifacts, {
        kind: "subagent_meta",
        path: metaPath,
        relation: "subagent metadata",
        exists: true,
        included: options.includeRaw || options.includeSubagents,
        notes: [],
        redactionCategories: [],
      });
    }

    const subagentText = await Bun.file(transcriptPath).text();
    const entries: TranscriptEntry[] = [];
    for (const [index, line] of subagentText.split(/\r?\n/).entries()) {
      if (!line.trim()) {
        continue;
      }
      try {
        entries.push({ line: index + 1, raw: JSON.parse(line) as Record<string, unknown> });
      } catch (error) {
        warnings.push(
          `Failed to parse subagent transcript ${transcriptPath} line ${index + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    let firstTimestamp: string | undefined;
    let lastTimestamp: string | undefined;
    let firstUserPrompt: string | undefined;
    let agentId = basename;

    for (const entry of entries) {
      const raw = entry.raw as Record<string, unknown>;
      if (typeof raw.timestamp === "string") {
        firstTimestamp ??= raw.timestamp;
        lastTimestamp = raw.timestamp;
      }
      if (!firstUserPrompt && typeof raw.type === "string" && raw.type === "user") {
        const message = raw.message as Record<string, unknown> | undefined;
        if (typeof message?.content === "string") {
          firstUserPrompt = message.content;
        }
      }
      if (typeof raw.agentId === "string") {
        agentId = raw.agentId;
      }
    }

    subagents.push({
      agentId,
      transcriptPath,
      metaPath: (await fileExists(metaPath)) ? metaPath : undefined,
      firstTimestamp,
      lastTimestamp,
      firstUserPrompt,
      eventCount: entries.length,
      entries,
    });
  }

  return subagents.sort((left, right) => left.transcriptPath.localeCompare(right.transcriptPath));
}

async function loadHistoryMatches(
  rootDir: string,
  sessionId: string,
  artifacts: Map<string, ArtifactRecord>,
): Promise<HistoryMatch[]> {
  const historyPath = path.join(rootDir, "history.jsonl");
  if (!(await fileExists(historyPath))) {
    return [];
  }

  await upsertArtifact(artifacts, {
    kind: "history_file",
    path: historyPath,
    relation: "global prompt history index",
    exists: true,
    included: false,
    notes: [],
    redactionCategories: [],
  });

  const text = await Bun.file(historyPath).text();
  const matches: HistoryMatch[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(sessionId)) {
      continue;
    }
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as HistoryMatch;
      if (parsed.sessionId === sessionId) {
        matches.push(parsed);
      }
    } catch {
      continue;
    }
  }

  const artifact = artifacts.get(historyPath);
  if (artifact) {
    artifact.notes.push(`Matched ${matches.length} history.jsonl entries for this session.`);
  }

  return matches;
}

async function discoverLinkedTeams(rootDir: string, sessionId: string): Promise<string[]> {
  const teamsDir = path.join(rootDir, "teams");
  let entries;
  try {
    entries = await readdir(teamsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const teamNames: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const configPath = path.join(teamsDir, entry.name, "config.json");
    if (!(await fileExists(configPath))) {
      continue;
    }
    try {
      const config = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
      if (config.leadSessionId === sessionId) {
        teamNames.push(entry.name);
      }
    } catch {
      continue;
    }
  }

  return teamNames.sort();
}

async function discoverSessionEnvPaths(rootDir: string, sessionId: string): Promise<string[]> {
  const sessionEnvDir = path.join(rootDir, "session-env");
  const matches: string[] = [];
  const levelOne = await listFiles(sessionEnvDir);
  for (const filePath of levelOne) {
    const base = path.basename(filePath);
    if (base.includes(sessionId)) {
      matches.push(filePath);
      continue;
    }
    try {
      const text = await Bun.file(filePath).text();
      if (text.includes(sessionId)) {
        matches.push(filePath);
      }
    } catch {
      continue;
    }
  }
  return matches.sort();
}

async function addTaskDirectoryArtifacts(
  taskDir: string,
  options: CliOptions,
  artifacts: Map<string, ArtifactRecord>,
): Promise<number> {
  const files = (await listFiles(taskDir)).filter((filePath) => filePath.endsWith(".json"));
  for (const filePath of files) {
    await upsertArtifact(artifacts, {
      kind: "task_file",
      path: filePath,
      relation: `task file from ${taskDir}`,
      exists: true,
      included: options.includeRaw || options.includeTasks,
      notes: [],
      redactionCategories: [],
    });
  }
  return files.length;
}

async function upsertArtifact(
  artifacts: Map<string, ArtifactRecord>,
  artifact: ArtifactRecord,
): Promise<void> {
  const existing = artifacts.get(artifact.path);
  const sizeBytes = artifact.exists ? await safeStatSize(artifact.path) : undefined;

  if (existing) {
    existing.included ||= artifact.included;
    existing.exists ||= artifact.exists;
    existing.sizeBytes ??= sizeBytes;
    for (const note of artifact.notes) {
      if (!existing.notes.includes(note)) {
        existing.notes.push(note);
      }
    }
    return;
  }

  artifacts.set(artifact.path, { ...artifact, sizeBytes });
}

async function safeStatSize(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return undefined;
  }
}

async function listFiles(rootPath: string): Promise<string[]> {
  const output: string[] = [];
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      output.push(entryPath);
    }
  }
  return output.sort();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function sortArtifacts(artifacts: ArtifactRecord[]): ArtifactRecord[] {
  return artifacts.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind.localeCompare(right.kind);
    }
    return left.path.localeCompare(right.path);
  });
}
