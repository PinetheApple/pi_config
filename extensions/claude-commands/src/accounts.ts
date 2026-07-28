/**
 * Account identity from neighbouring coding agents.
 *
 * pi itself has no account concept (`auth.json` stores API keys only), so
 * `/status` borrows identity from opencode and Claude Code. Only non-secret
 * fields are ever read: the opencode query selects `email` and never touches
 * the `access_token`/`refresh_token` columns in the same table, and the Claude
 * account comes from `~/.claude.json`, not from the credential file.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");

export const OPENCODE_DB_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "opencode.db",
);

export interface ClaudeAccount {
  email?: string;
  displayName?: string;
  organizationName?: string;
  billingType?: string;
  seatTier?: string;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseClaudeAccount(config: unknown): ClaudeAccount | undefined {
  if (!config || typeof config !== "object") return undefined;
  const account = (config as Record<string, unknown>).oauthAccount;
  if (!account || typeof account !== "object") return undefined;

  const record = account as Record<string, unknown>;
  const parsed: ClaudeAccount = {
    email: optionalString(record.emailAddress),
    displayName: optionalString(record.displayName),
    organizationName: optionalString(record.organizationName),
    billingType: optionalString(record.billingType),
    seatTier: optionalString(record.seatTier),
  };
  return Object.values(parsed).some((value) => value !== undefined)
    ? parsed
    : undefined;
}

export async function readClaudeAccount(configPath = CLAUDE_CONFIG_PATH) {
  try {
    return parseClaudeAccount(JSON.parse(await readFile(configPath, "utf8")));
  } catch {
    return undefined;
  }
}

export async function readOpencodeAccountEmail(dbPath: string) {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return undefined;
  }

  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare("select email from account where email is not null limit 1")
      .get();
    return optionalString((row as Record<string, unknown> | undefined)?.email);
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // A failed open leaves nothing to close.
    }
  }
}
