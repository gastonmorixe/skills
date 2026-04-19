export type ProviderName = "claude";

export interface CliOptions {
  provider: ProviderName;
  sessionId: string;
  rootDir: string;
  outputPath?: string;
  includeRaw: boolean;
  includeSubagents: boolean;
  includeToolResults: boolean;
  includeDebug: boolean;
  includeHistory: boolean;
  includeTasks: boolean;
  includeTeams: boolean;
  includePlans: boolean;
  redact: boolean;
  format: "markdown";
  maxInlineBytes: number;
  strict: boolean;
  jsonIndexPath?: string;
}

export interface ArtifactRecord {
  kind:
    | "transcript"
    | "subagent_transcript"
    | "subagent_meta"
    | "tool_result_spill"
    | "queue_output"
    | "debug_log"
    | "history_file"
    | "task_file"
    | "team_config"
    | "team_inbox"
    | "plan_file"
    | "session_env";
  path: string;
  relation: string;
  exists: boolean;
  sizeBytes?: number;
  included: boolean;
  notes: string[];
  redactionCategories: string[];
}

export interface TranscriptEntry {
  line: number;
  raw: Record<string, unknown>;
}

export interface HistoryMatch {
  timestamp?: number;
  display?: string;
  project?: string;
  sessionId?: string;
}

export interface RenderedEvent {
  timestamp?: string;
  heading: string;
  body?: string;
  kind: string;
}

export interface ParsedSubagent {
  agentId: string;
  transcriptPath: string;
  metaPath?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  firstUserPrompt?: string;
  eventCount: number;
  entries: TranscriptEntry[];
}

export interface LoadedSession {
  provider: ProviderName;
  sessionId: string;
  transcriptPath: string;
  projectSlug: string;
  entries: TranscriptEntry[];
  artifacts: ArtifactRecord[];
  warnings: string[];
  parseWarnings: string[];
  historyMatches: HistoryMatch[];
  subagents: ParsedSubagent[];
  debugPath?: string;
  sessionEnvPaths: string[];
  firstTimestamp?: string;
  lastTimestamp?: string;
  cwds: string[];
  entrypoints: string[];
  versions: string[];
  models: string[];
  gitBranches: string[];
  slugs: string[];
  hasSidechains: boolean;
  attachmentCounts: Record<string, number>;
  eventCounts: Record<string, number>;
  planPaths: string[];
  teamNames: string[];
  taskListIds: string[];
}

export interface RedactionResult {
  text: string;
  categories: string[];
  count: number;
}
