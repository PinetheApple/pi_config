import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";

const MAX_OUTPUT_BYTES = 8 * 1_024 * 1_024;
/** Spawn and timeout failures must never look like a linter's "violations found" exit 1. */
const SPAWN_FAILURE_CODE = -1;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  stdin?: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: RunOptions,
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code =
          typeof error.code === "number" ? error.code : SPAWN_FAILURE_CODE;
        resolve({ code, stdout, stderr });
      },
    );
    // A child that exits without reading stdin (`gh auth status`) EPIPEs this
    // write, and an unhandled stdin error would take the whole agent down.
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin ?? "");
  });

export async function readOptionalFile(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function fileExists(path: string) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function hasExecutable(name: string) {
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const directory of directories) {
    try {
      await access(join(directory, name), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}
