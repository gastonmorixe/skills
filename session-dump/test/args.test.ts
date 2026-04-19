import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/index.ts";

describe("parseArgs", () => {
  test("parses the required Claude session arguments", () => {
    const parsed = parseArgs([
      "--provider",
      "claude",
      "--session",
      "abc-123",
    ]);

    expect("help" in parsed).toBe(false);
    if ("help" in parsed) {
      throw new Error("unexpected help result");
    }
    expect(parsed.provider).toBe("claude");
    expect(parsed.sessionId).toBe("abc-123");
    expect(parsed.redact).toBe(true);
  });

  test("include-raw enables the related artifact flags", () => {
    const parsed = parseArgs([
      "--provider",
      "claude",
      "--session",
      "abc-123",
      "--include-raw",
    ]);

    expect("help" in parsed).toBe(false);
    if ("help" in parsed) {
      throw new Error("unexpected help result");
    }
    expect(parsed.includeRaw).toBe(true);
    expect(parsed.includeDebug).toBe(true);
    expect(parsed.includeHistory).toBe(true);
    expect(parsed.includePlans).toBe(true);
  });
});
