const CUES = [
  [
    "correction",
    /\b(no,?\s|don't|do not|stop|never|wrong|incorrect|that's not|please don't)\b/i,
  ],
  [
    "confirmation",
    /\b(yes,?\s+exactly|perfect|that's right|keep doing|nice|good call|that worked|love it)\b/i,
  ],
  [
    "preference",
    /\b(i (?:prefer|like|always|usually|never)|from now on|going forward|in this (?:repo|project)|our (?:team|convention))\b/i,
  ],
  [
    "external-reference",
    /\b(linear|jira|grafana|datadog|slack channel|notion|confluence|runbook|dashboard at)\b/i,
  ],
] as const;

export const SIGNAL_NUDGE_MARKER = "[self-learning]";

export function detectCues(prompt: string) {
  return CUES.filter(([, pattern]) => pattern.test(prompt)).map(
    ([name]) => name,
  );
}

/** Returns the nudge to append, or undefined when the prompt carries no signal. */
export function buildSignalNudge(prompt: string) {
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.includes(SIGNAL_NUDGE_MARKER)) return undefined;

  const cues = detectCues(trimmed);
  if (cues.length === 0) return undefined;

  return (
    `${SIGNAL_NUDGE_MARKER} Signal detected (${cues.join(", ")}). If this turn carries ` +
    "durable, cross-session guidance, capture it with the `auto-memory` skill " +
    "before ending the turn. If it is one-off task detail, ignore this."
  );
}
