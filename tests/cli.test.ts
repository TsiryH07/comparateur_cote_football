import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { OddsDatabase } from "../src/database/sqlite.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// No CLI test may contact an API, even if source selection regresses.
const networkBlocker = `data:text/javascript,${encodeURIComponent(`
  globalThis.fetch = async () => { throw new Error("Network disabled in CLI tests"); };
`)}`;
const runtimeArguments = ["--import", "tsx", "--import", networkBlocker, "src/index.ts"];
// Lance le programme pour le tester.
function command(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [...runtimeArguments, ...args], {
    cwd: root,
    env: {
      ...process.env, DATA_SOURCE: "mock", ODDS_API_KEY: "", ODDS_API_SPORTS: "soccer_epl",
      MOCK_DATA_DIR: join(root, "data/examples"), ODDS_THRESHOLD_MODE: "percentage",
      ODDS_THRESHOLD: "10", MATCH_TOLERANCE_MINUTES: "15", COLLECTOR_TIMEOUT_MS: "15000",
      INTERVAL_MINUTES: "10", ...env,
    },
    encoding: "utf8", timeout: 10_000,
  });
}

test("CLI : collecte, réouverture SQLite, historique et alertes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "odds-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { DATABASE_PATH: join(directory, "odds.sqlite") };
  const demo = command(["--once"], env);
  assert.equal(demo.status, 0, demo.stderr);
  assert.match(demo.stdout, /7 observations enregistrées, 4 matchs, 3 rapprochés, 2 alertes/);
  assert.match(demo.stderr, /exemple-a.*Ligne 6/);
  const history = command(["--history", "--limit", "2"], env);
  assert.equal(history.status, 0, history.stderr);
  assert.match(history.stdout, /Date de collecte/);
  const alerts = command(["--alerts"], env);
  assert.equal(alerts.status, 0, alerts.stderr);
  assert.match(alerts.stdout, /Paris Saint-Germain/);
  assert.match(alerts.stdout, /exemple-b/);
  const db = new OddsDatabase(env.DATABASE_PATH);
  try {
    assert.equal(db.getHistory().length, 7);
    assert.equal(db.getAlerts().length, 2);
  } finally {
    db.close();
  }
});

test("CLI : aide, erreurs de saisie et échec total d'une source", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "odds-cli-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { DATABASE_PATH: ":memory:" };
  assert.equal(command(["--help"], env).status, 0);
  assert.equal(command(["--once", "--watch"], env).status, 1);
  assert.equal(command(["--mock", "--once", "--watch"], env).status, 1);
  assert.equal(command(["--history", "--limit", "0"], env).status, 1);
  assert.equal(command(["--unknown"], env).status, 1);
  assert.equal(command(["--once"], { ...env, ODDS_THRESHOLD: "-5" }).status, 1);
  await writeFile(join(directory, "broken.json"), "{invalid");
  const failed = command(["--once"], { ...env, MOCK_DATA_DIR: directory });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /0 observations enregistrées/);
  assert.match(failed.stderr, /broken/);
});

test("CLI : la boucle déclenche plusieurs cycles et les écrit en SQLite", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "odds-cli-watch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "watch.sqlite");
  const child = spawn(process.execPath, [...runtimeArguments, "--watch", "--mock"], {
    cwd: root,
    env: {
      ...process.env, DATA_SOURCE: "mock", ODDS_API_KEY: "", ODDS_API_SPORTS: "soccer_epl",
      DATABASE_PATH: databasePath, MOCK_DATA_DIR: join(root, "data/examples"),
      INTERVAL_MINUTES: "0.001", ODDS_THRESHOLD_MODE: "percentage", ODDS_THRESHOLD: "10",
      MATCH_TOLERANCE_MINUTES: "15", COLLECTOR_TIMEOUT_MS: "15000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => child.kill(), 5000);
  t.after(() => clearTimeout(timer));
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  await new Promise<void>((accept, reject) => {
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if ((stdout.match(/observations enregistrées/g) ?? []).length >= 2) child.kill("SIGTERM");
    });
    child.once("close", () => accept());
  });
  assert.ok((stdout.match(/observations enregistrées/g) ?? []).length >= 2, stdout + stderr);
  const database = new OddsDatabase(databasePath);
  try {
    assert.ok(database.getHistory(100).length >= 14);
  } finally {
    database.close();
  }
});

test("CLI : --mock force les exemples malgré une configuration API avec une fausse clé", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "odds-cli-force-mock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fakeKey = "fake-api-key-for-cli-tests";
  const env = {
    DATABASE_PATH: join(directory, "forced-mock.sqlite"),
    DATA_SOURCE: "odds-api",
    ODDS_API_KEY: fakeKey,
  };
  const demo = command(["--once", "--mock"], env);
  assert.equal(demo.status, 0, demo.stderr);
  assert.match(demo.stdout, /Mode exemple/);
  assert.match(demo.stdout, /7 observations enregistrées, 4 matchs, 3 rapprochés, 2 alertes/);
  assert.doesNotMatch(demo.stdout + demo.stderr, /Network disabled/);
  assert.ok(!(demo.stdout + demo.stderr).includes(fakeKey));

  const history = command(["--mock", "--history", "--limit", "1"], env);
  assert.equal(history.status, 0, history.stderr);
  assert.match(history.stdout, /Date de collecte/);
  const alerts = command(["--alerts", "--mock", "--limit", "1"], env);
  assert.equal(alerts.status, 0, alerts.stderr);
  assert.match(alerts.stdout, /Paris Saint-Germain/);
  const database = new OddsDatabase(env.DATABASE_PATH);
  try {
    assert.equal(database.getHistory().length, 7);
    assert.equal(database.getAlerts().length, 2);
  } finally {
    database.close();
  }
});

test("CLI : le mode API sans clé échoue avant toute collecte", () => {
  const result = command(["--once"], { DATABASE_PATH: ":memory:", DATA_SOURCE: "odds-api", ODDS_API_KEY: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ODDS_API_KEY/);
  assert.doesNotMatch(result.stdout + result.stderr, /Network disabled/);
});

test("CLI : la boucle reprend lorsque le dossier d'exemples manquant est réparé", { timeout: 10_000 }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "odds-cli-recovery-"));
  const examples = join(directory, "examples");
  const databasePath = join(directory, "recovery.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, [...runtimeArguments, "--watch", "--mock"], {
    cwd: root, env: { ...process.env, DATA_SOURCE: "mock", ODDS_API_KEY: "", ODDS_API_SPORTS: "soccer_epl",
      DATABASE_PATH: databasePath, MOCK_DATA_DIR: examples, INTERVAL_MINUTES: "0.001",
      ODDS_THRESHOLD_MODE: "percentage", ODDS_THRESHOLD: "10", MATCH_TOLERANCE_MINUTES: "15", COLLECTOR_TIMEOUT_MS: "15000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill(); });
  const timeout = setTimeout(() => child.kill(), 5000);
  context.after(() => clearTimeout(timeout));
  let repaired = false;
  let stdout = "";
  let stderr = "";
  const repair = async () => {
    await mkdir(examples);
    await writeFile(join(examples, "repaired.json"), JSON.stringify([{
      sourceMatchId: "repaired-match", homeTeam: "PSG", awayTeam: "Marseille", competition: "Ligue 1",
      schedule: { dayOffset: 1, time: "18:00:00Z" }, odds: { "1": 2, X: 3, "2": 4 },
    }]));
  };
  await new Promise<void>((accept, reject) => {
    child.once("error", reject);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (!repaired && stderr.includes("MOCK_DIRECTORY_MISSING")) {
        repaired = true;
        void repair().catch(reject);
      }
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("1 observations enregistrées")) child.kill("SIGTERM");
    });
    child.once("close", () => accept());
  });
  assert.ok(repaired, stderr);
  assert.ok(stdout.includes("1 observations enregistrées"), stdout + stderr);
  const database = new OddsDatabase(databasePath);
  try { assert.equal(database.getHistory()[0]!.source, "repaired"); }
  finally { database.close(); }
});
