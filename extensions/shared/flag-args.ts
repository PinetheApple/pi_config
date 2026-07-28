/**
 * Leading-flag parser for slash-command arguments.
 *
 * Commands here take the shape `--flag value ... <free text>`: a run of
 * recognized flags followed by a body (a prompt, a shell command) that must
 * survive verbatim. So flags are only recognized until the first non-flag
 * token, and the body is returned as the untouched remainder of the raw
 * string — re-joining tokens would destroy quoting the shell still needs.
 *
 * Parsing is lenient about shape (quotes, `--flag=value`), strict about
 * content: an unrecognized flag or a flag missing its value is an error the
 * caller reports, never a silently ignored argument.
 */

export interface ArgToken {
  /** Unquoted, unescaped token text. */
  readonly value: string;
  /** Offset just past this token in the raw string. */
  readonly end: number;
  /** True when the token was written inside quotes, so `--x` is literal text. */
  readonly quoted: boolean;
}

/**
 * Read the next whitespace-delimited token starting at `start`, honoring
 * single/double quotes and backslash escapes. Returns undefined at the end of
 * the string.
 */
export function readArgToken(raw: string, start: number): ArgToken | undefined {
  let index = start;
  while (index < raw.length && /\s/.test(raw[index]!)) index++;
  if (index >= raw.length) return undefined;

  let value = "";
  let quoted = false;
  let quote: string | undefined;

  while (index < raw.length) {
    const char = raw[index]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
        index++;
        continue;
      }
      if (char === "\\" && quote === '"' && index + 1 < raw.length) {
        value += raw[index + 1];
        index += 2;
        continue;
      }
      value += char;
      index++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      index++;
      continue;
    }
    if (char === "\\" && index + 1 < raw.length) {
      value += raw[index + 1];
      index += 2;
      continue;
    }
    if (/\s/.test(char)) break;
    value += char;
    index++;
  }

  return { value, end: index, quoted };
}

export type FlagParseResult =
  | {
      readonly ok: true;
      /** Flag name (with leading `--`) to its value, last occurrence wins. */
      readonly flags: ReadonlyMap<string, string>;
      /** Everything after the flags, verbatim and trimmed. */
      readonly rest: string;
    }
  | { readonly ok: false; readonly error: string };

function isFlag(token: ArgToken) {
  return !token.quoted && token.value.startsWith("--") && token.value !== "--";
}

/**
 * Parse the leading `--flag value` / `--flag=value` run of `raw` against the
 * recognized flag names (each written with its `--` prefix).
 */
export function parseLeadingFlags(
  raw: string,
  known: readonly string[],
): FlagParseResult {
  const flags = new Map<string, string>();
  let cursor = 0;

  while (true) {
    const token = readArgToken(raw, cursor);
    if (!token) {
      cursor = raw.length;
      break;
    }
    if (!isFlag(token)) break;

    const equals = token.value.indexOf("=");
    const name = equals > 0 ? token.value.slice(0, equals) : token.value;
    if (!known.includes(name)) {
      return {
        ok: false,
        error: `Unknown flag "${name}". Known flags: ${known.join(", ")}.`,
      };
    }

    if (equals > 0) {
      flags.set(name, token.value.slice(equals + 1));
      cursor = token.end;
      continue;
    }

    const valueToken = readArgToken(raw, token.end);
    if (!valueToken || isFlag(valueToken)) {
      return { ok: false, error: `Flag "${name}" needs a value.` };
    }
    flags.set(name, valueToken.value);
    cursor = valueToken.end;
  }

  return { ok: true, flags, rest: raw.slice(cursor).trim() };
}
