/**
 * opencode Go publishes dollar-denominated usage limits, so consumption of a
 * real limit is computable without any quota endpoint: pi already records the
 * dollar cost of every turn it ran.
 *
 * Limits are quoted from https://opencode.ai/docs/go/ ("Usage limits") and are
 * documented as subject to change, so they are constants that need review, not
 * anything fetched. The credit-billed `opencode` provider has no such limit and
 * is deliberately excluded.
 */

import { formatCost } from "../format.ts";
import type { ModelBucket } from "./pi.ts";
import type { GaugeRow } from "../panel/rows.ts";
import type { UsageWindow } from "./window.ts";

export const GO_PROVIDER = "opencode-go";
export const GO_LIMITS_DOC = "https://opencode.ai/docs/go/";

export interface GoLimit {
  window: UsageWindow;
  label: string;
  dollars: number;
}

/** Labels say "rolling" because opencode publishes no anchor to reset against. */
export const GO_LIMITS: readonly GoLimit[] = [
  { window: "5h", label: "Go 5-hour limit (rolling)", dollars: 12 },
  { window: "7d", label: "Go weekly limit (rolling 7d)", dollars: 30 },
  { window: "30d", label: "Go monthly limit (rolling 30d)", dollars: 60 },
];

/**
 * pi only sees the turns it ran itself, so Go spend from another agent on the
 * same subscription is invisible here. The note says so rather than implying
 * the bar is authoritative.
 */
const BASIS_NOTE = "pi turns only";

export function goLimitGauges(models: readonly ModelBucket[]): GaugeRow[] {
  const go = models.filter((bucket) => bucket.provider === GO_PROVIDER);
  if (go.length === 0) return [];

  return GO_LIMITS.map(({ window, label, dollars }) => {
    const spent = go.reduce(
      (total, bucket) => total + bucket.windows[window].cost,
      0,
    );
    return {
      kind: "gauge",
      label,
      fraction: spent / dollars,
      note: `${formatCost(spent)} of ${formatCost(dollars)} · ${BASIS_NOTE}`,
    };
  });
}
