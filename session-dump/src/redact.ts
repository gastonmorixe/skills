import type { RedactionResult } from "./types.ts";

type Rule = {
  category: string;
  pattern: RegExp;
  replace: (...args: string[]) => string;
};

const rules: Rule[] = [
  {
    category: "private_key_block",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => "[REDACTED:private_key_block]",
  },
  {
    category: "pem_block",
    pattern:
      /-----BEGIN [A-Z0-9 ]*CERTIFICATE-----[\s\S]*?-----END [A-Z0-9 ]*CERTIFICATE-----/g,
    replace: () => "[REDACTED:pem_block]",
  },
  {
    category: "url_credentials",
    pattern: /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi,
    replace: (full, prefix, _secret, suffix) =>
      `${prefix}[REDACTED:url_credentials]${suffix}`,
  },
  {
    category: "bearer_token",
    pattern: /(Authorization:\s*Bearer\s+)([A-Za-z0-9._-]{12,})/gi,
    replace: (full, prefix) => `${prefix}[REDACTED:bearer_token]`,
  },
  {
    category: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{8,}\.[A-Za-z0-9._-]{8,}\b/g,
    replace: () => "[REDACTED:jwt]",
  },
  {
    category: "secret_assignment",
    pattern:
      /\b((?:api[_-]?token|auth[_-]?token|access[_-]?token|refresh[_-]?token|license[_-]?key|secret(?:[_-]?key)?|password|passwd|token|account[_-]?id))\b(\s*[:=]\s*["']?)([^\s"'`]{4,})(["']?)/gi,
    replace: (full, key, sep, _value, quote) =>
      `${key}${sep}[REDACTED:${String(key).toLowerCase().replaceAll(/[^a-z0-9]+/g, "_")}]${quote}`,
  },
  {
    category: "cloudflare_token",
    pattern: /\b(CF_API_TOKEN|CLOUDFLARE_API_TOKEN)\b(\s*[:=]\s*["']?)([^\s"'`]{6,})(["']?)/gi,
    replace: (full, key, sep, _value, quote) =>
      `${key}${sep}[REDACTED:cloudflare_token]${quote}`,
  },
  {
    category: "license_key_label",
    pattern: /(License key\s*\n)([^\n]{6,})/gi,
    replace: (full, prefix) => `${prefix}[REDACTED:license_key]`,
  },
];

export function redactText(input: string, enabled: boolean): RedactionResult {
  if (!enabled || input.length === 0) {
    return { text: input, categories: [], count: 0 };
  }

  let text = input;
  const categories = new Set<string>();
  let count = 0;

  for (const rule of rules) {
    text = text.replace(rule.pattern, (...args) => {
      categories.add(rule.category);
      count += 1;
      return rule.replace(...(args.slice(0, -2) as string[]));
    });
  }

  return { text, categories: [...categories].sort(), count };
}
