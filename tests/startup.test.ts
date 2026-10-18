import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "../src/environment.js";
import { AppError } from "../src/errors.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const loader = import.meta.resolve("tsx");
const blocker = `data:text/javascript,${encodeURIComponent("globalThis.fetch = async () => { throw new Error('External network disabled in startup tests'); };")}`;
const baseEnv = {
  ...process.env, DATA_SOURCE: "mock", ODDS_API_KEY: "", DATABASE_PATH: ":memory:",
  ODDS_API_SPORTS: "soccer_epl", MOCK_DATA_DIR: resolve(root, "data/examples"),
  ODDS_THRESHOLD_MODE: "percentage", ODDS_THRESHOLD: "10", INTERVAL_MINUTES: "10",
  COLLECTOR_TIMEOUT_MS: "15000", MATCH_TOLERANCE_MINUTES: "15", BET261_ENABLED: "true",
};

// Lance le programme pour le tester.
function run(file: string, env: NodeJS.ProcessEnv = {}, cwd = root) {
  return spawnSync(process.execPath, ["--import", loader, "--import", blocker, resolve(root, file)], {
    cwd, env: { ...baseEnv, ...env }, encoding: "utf8", timeout: 10_000,
  });
}

test("an absent optional env file is allowed but an unreadable env path is diagnosed", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "odds-environment-errors-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.doesNotThrow(() => loadEnvironment(join(directory, "missing.env")));
  assert.throws(() => loadEnvironment(directory), (error: AppError) => {
    assert.equal(error.code, "ENV_FILE_UNREADABLE");
    assert.ok(error.message.includes("configuration .env"));
    assert.equal(error.message.includes(directory), false);
    return true;
  });
});

test("web startup explains a port conflict and exits without leaving a running service", async (context) => {
  const occupied = createServer();
  await new Promise<void>((accept) => occupied.listen(0, "127.0.0.1", accept));
  context.after(() => new Promise<void>((accept, reject) => occupied.close((error) => error ? reject(error) : accept())));
  const port = (occupied.address() as AddressInfo).port;
  const result = run("src/web/main.ts", { WEB_PORT: String(port) });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes("WEB_PORT_IN_USE"));
  assert.ok(result.stderr.includes(String(port)));
  assert.ok(result.stderr.includes("WEB_PORT"));
  assert.equal(result.stderr.includes("External network"), false);
  assert.equal(result.stderr.includes(" at "), false);
});

test("web startup rejects an invalid port and a bad database with controlled diagnostics", (context) => {
  const badPort = run("src/web/main.ts", { WEB_PORT: "not-a-number" });
  assert.equal(badPort.status, 1);
  assert.ok(badPort.stderr.includes("CONFIG_INVALID"));
  const directory = mkdtempSync(join(tmpdir(), "odds-startup-bad-db-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "invalid.sqlite");
  writeFileSync(path, "This is not a SQLite database.");
  const badDatabase = run("src/web/main.ts", { WEB_PORT: "0", DATABASE_PATH: path });
  assert.equal(badDatabase.status, 1);
  assert.ok(badDatabase.stderr.includes("DATABASE_CORRUPT"));
  assert.equal(badDatabase.stderr.includes("CREATE TABLE"), false);
  assert.equal(readFileSync(path, "utf8"), "This is not a SQLite database.");
});

test("CLI and web distinguish an unreadable env file from an absent one", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "odds-startup-env-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, ".env"));
  for (const file of ["src/index.ts", "src/web/main.ts"]) {
    const result = run(file, { WEB_PORT: "0" }, directory);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes("ENV_FILE_UNREADABLE"));
    assert.equal(result.stderr.includes(directory), false);
  }
});

test("fatal exceptions and rejected promises perform cleanup and exit without leaking secrets", () => {
  const runtime = new URL("../src/runtime.ts", import.meta.url).href;
  for (const trigger of [
    "setTimeout(() => { throw new Error('apiKey=fake-startup-private-key'); }, 0);",
    "void Promise.reject(new Error('apiKey=fake-startup-private-key'));",
  ]) {
    const source = `import { installFatalHandlers } from ${JSON.stringify(runtime)}; installFatalHandlers(async () => { console.log('cleanup-complete'); }); ${trigger}`;
    const result = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "--eval", source], {
      cwd: root, env: baseEnv, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes("cleanup-complete"));
    assert.equal((result.stderr + result.stdout).includes("fake-startup-private-key"), false);
    assert.equal(result.stderr.includes(" at "), false);
  }
});
