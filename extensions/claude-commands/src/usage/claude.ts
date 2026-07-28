/**
 * Claude Code plan quota via the undocumented OAuth usage endpoint.
 *
 * Credential handling rules for this module:
 *   - the OAuth token is read at call time, kept in a local, and used only as
 *     the Authorization header value;
 *   - it is never returned, logged, persisted, or embedded in any rendered
 *     string or error message.
 * The endpoint itself is unofficial and unstable, so every field is optional
 * and parsed defensively.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_CREDENTIALS_PATH = join(
  homedir(),
  ".claude",
  ".credentials.json",
);

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const REQUEST_TIMEOUT_MS = 5000;

export const QUOTA_KEYS = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "extra_usage",
] as const;

export type QuotaKey = (typeof QUOTA_KEYS)[number];

export const QUOTA_LABELS: Record<QuotaKey, string> = {
  five_hour: "Current session (5h)",
  seven_day: "Weekly (all models)",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)",
  extra_usage: "Extra usage",
};

export interface QuotaWindow {
  key: QuotaKey;
  /** Fraction of the limit consumed, or undefined when the field is absent. */
  utilization: number | undefined;
  resetsAt: Date | undefined;
}

export type ClaudeQuota =
  { ok: true; windows: QuotaWindow[] } | { ok: false; reason: string };

function readUtilization(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  // The endpoint reports 0-100 percentages; normalise to a fraction.
  return value / 100;
}

function readResetsAt(value: unknown) {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Pure parser over the endpoint's JSON body. Exported for tests. */
export function parseQuotaResponse(body: unknown): QuotaWindow[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;

  const windows: QuotaWindow[] = [];
  for (const key of QUOTA_KEYS) {
    const raw = record[key];
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const utilization = readUtilization(entry.utilization);
    const resetsAt = readResetsAt(entry.resets_at);
    if (utilization === undefined && resetsAt === undefined) continue;
    windows.push({ key, utilization, resetsAt });
  }
  return windows;
}

function extractToken(parsed: unknown) {
  if (!parsed || typeof parsed !== "object") return undefined;
  const root = parsed as Record<string, unknown>;
  const oauth = root.claudeAiOauth;
  const container =
    oauth && typeof oauth === "object"
      ? (oauth as Record<string, unknown>)
      : root;
  for (const field of ["accessToken", "access_token"]) {
    const value = container[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

async function loadToken(credentialsPath: string) {
  let raw: string;
  try {
    raw = await readFile(credentialsPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    return extractToken(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export interface FetchQuotaOptions {
  credentialsPath?: string;
  url?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function fetchClaudeQuota(
  options: FetchQuotaOptions = {},
): Promise<ClaudeQuota> {
  const credentialsPath = options.credentialsPath ?? CLAUDE_CREDENTIALS_PATH;
  const token = await loadToken(credentialsPath);
  if (!token) {
    return {
      ok: false,
      reason: "no Claude Code OAuth credentials found; run `claude` to sign in",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await (options.fetchImpl ?? fetch)(
      options.url ?? CLAUDE_USAGE_URL,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
        },
        signal: controller.signal,
      },
    );

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason:
          "Claude Code quota unavailable — token expired or missing; run `claude` to refresh",
      };
    }
    if (!response.ok) {
      return { ok: false, reason: `endpoint returned HTTP ${response.status}` };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: "endpoint returned a non-JSON response" };
    }

    const windows = parseQuotaResponse(body);
    if (windows.length === 0) {
      return {
        ok: false,
        reason: "endpoint returned no recognisable quota fields",
      };
    }
    return { ok: true, windows };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      reason: aborted
        ? "request timed out"
        : "network error contacting the endpoint",
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
