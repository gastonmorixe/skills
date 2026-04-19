import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  extractPersistedOutputPathsFromEntry,
  resolveClaudeTranscriptPath,
} from "../src/providers/claude.ts";

describe("Claude provider helpers", () => {
  test("extracts persisted output paths from tool-result content", () => {
    const entry = {
      line: 1,
      raw: {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content:
                "<persisted-output>\nFull output saved to: /tmp/tool-results/example.txt\n</persisted-output>",
            },
          ],
        },
      },
    };

    expect(extractPersistedOutputPathsFromEntry(entry)).toEqual([
      "/tmp/tool-results/example.txt",
    ]);
  });

  test("finds the canonical transcript under projects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "session-dump-"));
    const projectDir = path.join(root, "projects", "-home-user-project");
    await mkdir(projectDir, { recursive: true });
    const transcriptPath = path.join(projectDir, "session-123.jsonl");
    await writeFile(transcriptPath, '{"type":"user"}\n', "utf8");

    const resolved = await resolveClaudeTranscriptPath(root, "session-123");
    expect(resolved).toEqual({
      transcriptPath,
      projectSlug: "-home-user-project",
    });
  });
});
