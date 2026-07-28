import type { SubagentOrigin } from "./domain.ts";
import { deriveTitleFromPrompt } from "./title.ts";

export const BTW_TITLE_MAX_LENGTH = 60;

/** Build a compact dashboard title from the first non-empty prompt line. */
export function deriveBtwTitle(prompt: string) {
  return deriveTitleFromPrompt(prompt, {
    fallback: "by the way",
    maxLength: BTW_TITLE_MAX_LENGTH,
  });
}

/** User asides remain visible in the dashboard but hidden from model tools. */
export function isModelVisible(snap: { readonly origin: SubagentOrigin }) {
  return snap.origin === "model";
}
