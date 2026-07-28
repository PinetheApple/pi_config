import assert from "node:assert/strict";
import test from "node:test";
import { parseLeadingFlags, readArgToken } from "./flag-args.ts";

const KNOWN = ["--name", "--dir"] as const;

function flagsOf(result: ReturnType<typeof parseLeadingFlags>) {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return { flags: Object.fromEntries(result.flags), rest: result.rest };
}

test("readArgToken honors quotes, escapes, and reports the end offset", () => {
  const raw = `  'a b'  "c \\"d\\"" e\\ f`;
  const first = readArgToken(raw, 0);
  assert.deepEqual(first, { value: "a b", end: 7, quoted: true });

  const second = readArgToken(raw, first!.end);
  assert.equal(second?.value, 'c "d"');
  assert.equal(second?.quoted, true);

  const third = readArgToken(raw, second!.end);
  assert.deepEqual(third, { value: "e f", end: raw.length, quoted: false });

  assert.equal(readArgToken(raw, raw.length), undefined);
  assert.equal(readArgToken("   ", 0), undefined);
});

test("leading flags are parsed and the body is kept verbatim", () => {
  assert.deepEqual(
    flagsOf(parseLeadingFlags("--name dev npm run dev", KNOWN)),
    {
      flags: { "--name": "dev" },
      rest: "npm run dev",
    },
  );

  assert.deepEqual(
    flagsOf(
      parseLeadingFlags(`--name "web server"  --dir ./api  ls -la`, KNOWN),
    ),
    { flags: { "--name": "web server", "--dir": "./api" }, rest: "ls -la" },
  );

  // Quoting inside the body must survive untouched: it still goes to a shell.
  assert.deepEqual(flagsOf(parseLeadingFlags(`sh -c 'echo "a  b"'`, KNOWN)), {
    flags: {},
    rest: `sh -c 'echo "a  b"'`,
  });

  // Flag-looking text after the body starts is body, not a flag.
  assert.deepEqual(
    flagsOf(parseLeadingFlags("npm run dev -- --port 3", KNOWN)),
    {
      flags: {},
      rest: "npm run dev -- --port 3",
    },
  );

  assert.deepEqual(flagsOf(parseLeadingFlags("--name=dev  npm start", KNOWN)), {
    flags: { "--name": "dev" },
    rest: "npm start",
  });

  assert.deepEqual(flagsOf(parseLeadingFlags("   ", KNOWN)), {
    flags: {},
    rest: "",
  });
});

test("a quoted leading token is body text, not a flag", () => {
  assert.deepEqual(flagsOf(parseLeadingFlags(`"--name" is literal`, KNOWN)), {
    flags: {},
    rest: `"--name" is literal`,
  });
});

test("unknown flags and missing values are errors", () => {
  const unknown = parseLeadingFlags("--nope x echo hi", KNOWN);
  assert.equal(unknown.ok, false);
  if (unknown.ok) throw new Error("unreachable");
  assert.match(unknown.error, /Unknown flag "--nope"/);
  assert.match(unknown.error, /--name, --dir/);

  const missing = parseLeadingFlags("--name", KNOWN);
  assert.equal(missing.ok, false);
  if (missing.ok) throw new Error("unreachable");
  assert.match(missing.error, /Flag "--name" needs a value/);

  const missingBeforeFlag = parseLeadingFlags("--name --dir /tmp echo", KNOWN);
  assert.equal(missingBeforeFlag.ok, false);
});
