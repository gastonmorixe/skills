import { describe, expect, test } from "bun:test";
import { redactText } from "../src/redact.ts";

describe("redactText", () => {
  test("redacts bearer tokens and password assignments", () => {
    const input = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "password=super-secret-value",
    ].join("\n");

    const output = redactText(input, true);
    expect(output.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(output.text).not.toContain("super-secret-value");
    expect(output.categories).toContain("bearer_token");
    expect(output.categories).toContain("secret_assignment");
  });

  test("does nothing when redaction is disabled", () => {
    const input = "password=super-secret-value";
    const output = redactText(input, false);
    expect(output.text).toBe(input);
    expect(output.categories).toHaveLength(0);
  });
});
