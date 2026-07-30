import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "./src/exec.ts";

test("a child that closes stdin resolves instead of crashing on EPIPE", async () => {
  const result = await runCommand(
    "sh",
    ["-c", "exec 0<&-; sleep 0.2; echo done"],
    { cwd: "/tmp", timeoutMs: 5_000, stdin: "x".repeat(2_000_000) },
  );
  assert.deepEqual(result, { code: 0, stdout: "done\n", stderr: "" });
});
