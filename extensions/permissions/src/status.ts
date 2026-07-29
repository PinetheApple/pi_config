/**
 * How the current mode reads in the footer.
 *
 * The footer is the only place the mode is announced. Cycling used to notify as
 * well, which printed the same words twice a keystroke apart; the footer is
 * persistent, so the notify was pure noise. That puts the whole burden of
 * "which mode am I in" on this one line, hence the icon and the colour: at a
 * glance, without reading, `bypassPermissions` must not look like `plan`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  PERMISSION_MODE_LABELS,
  type PermissionMode,
} from "../../shared/permission-modes.ts";

type ThemeColor = Parameters<ExtensionContext["ui"]["theme"]["fg"]>[0];

/** The slice of the theme this needs, so a test can pass a stub. */
export interface StatusTheme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

/**
 * Geometric glyphs, not Nerd Font icons: this repo's editing tools strip
 * private-use codepoints, and these occupy one cell in every terminal.
 *
 * The fill escalates with the blast radius — hollow while nothing can be
 * written, solid once edits land unasked, a hazard triangle once nothing is
 * asked at all.
 */
const MODE_ICONS: Readonly<Record<PermissionMode, string>> = {
  plan: "◇",
  default: "○",
  acceptEdits: "◆",
  bypassPermissions: "▲",
};

const MODE_COLORS: Readonly<Record<PermissionMode, ThemeColor>> = {
  plan: "accent",
  default: "muted",
  acceptEdits: "warning",
  bypassPermissions: "error",
};

export function formatPermissionStatus(
  theme: StatusTheme,
  mode: PermissionMode,
) {
  const text = `${MODE_ICONS[mode]} ${PERMISSION_MODE_LABELS[mode]}`;
  // Bold on top of the colour, not under it: `fg` resets only the foreground,
  // so the weight survives its trailing escape.
  return theme.fg(
    MODE_COLORS[mode],
    mode === "bypassPermissions" ? theme.bold(text) : text,
  );
}
