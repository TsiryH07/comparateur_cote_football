import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readConfig } from "../src/config.js";
import { OddsDatabase } from "../src/database/sqlite.js";
import { AppError } from "../src/errors.js";
import { collectCycle } from "../src/services/collectCycle.js";
import type { Collector } from "../src/types.js";
import { createDashboardServer, type DashboardServerOptions } from "../src/web/server.js";
import type { DashboardState } from "../src/web/types.js";

// Prépare les éléments nécessaires au test.
const clock = () => new Date("2026-10-17T12:00:00Z");

// Prépare un exemple de collecte.
function sampleCollectors(): Collector[] {
  const base = {
    sourceMatchId: "paris-marseille", homeTeam: "Paris Saint-Germain", awayTeam: "Marseille",
    competition: "Ligue 1", startsAt: "2026-10-18T18:00:00Z",
  };
  return [
    { name: "source-a", collect: async () => [{ ...base, odds: { "1": 1.8, X: 3.6, "2": 4.5 } }] },
    { name: "source-b", collect: async () => [{ ...base, homeTeam: "PSG", odds: { "1": 2.05, X: 3.55, "2": 5.1 } }] },
  ];
}

// Prépare les éléments nécessaires au test.
function realSourceStubs(): Collector[] {
  const base = {
    sourceMatchId: "test-arsenal-chelsea", homeTeam: "Arsenal", awayTeam: "Chelsea",
    competition: "Premier League", startsAt: "2026-10-18T18:00:00Z",
  };
  return [
    { name: "1xbet", collect: async () => [{ ...base, odds: { "1": 1.8, X: 3.6, "2": 4.5 } }] },
    { name: "bet261", collect: async () => [{ ...base, odds: { "1": 2.05, X: 3.55, "2": 5.1 } }] },
    { name: "pinnacle", collect: async () => [{ ...base, odds: { "1": 2.2, X: 3.6, "2": 5.4 } }] },
  ];
}

// Prépare les éléments nécessaires au test.
async function start(context: TestContext, overrides: Partial<DashboardServerOptions> = {}) {
  const database = new OddsDatabase(":memory:");
  const config = readConfig({ DATABASE_PATH: ":memory:" });
  const dashboard = createDashboardServer({ config, database, collectors: sampleCollectors(), clock, ...overrides });
  await new Promise<void>((resolveListen, reject) => {
    dashboard.server.once("error", reject);
    dashboard.server.listen(0, "127.0.0.1", resolveListen);
  });
  context.after(async () => {
    await dashboard.close();
    database.close();
  });
  const address = dashboard.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const getState = async () => (await (await fetch(`${base}/api/state`)).json()) as DashboardState;
  const settings = (value: unknown) => fetch(`${base}/api/settings`, {
    method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(value),
  });
  return { dashboard, database, base, getState, settings };
}

test("HTTP state, collection, history and threshold changes share real SQLite data", async (context) => {
  const app = await start(context);
  const initial = await app.getState();
  assert.equal(initial.latestCycle, null);
  assert.equal(initial.collecting, false);
  assert.equal(initial.nextRunAt, null);
  assert.deepEqual(initial.sources, ["source-a", "source-b"]);

  const response = await fetch(`${app.base}/api/collect`, { method: "POST", headers: { origin: app.base } });
  assert.equal(response.status, 200);
  const collected = await response.json() as DashboardState;
  assert.equal(collected.collecting, false);
  assert.equal(collected.latestCycle?.collectedCount, 2);
  assert.equal(collected.latestCycle?.alerts.length, 2);
  assert.equal(collected.nextRunAt, "2026-10-17T12:10:00.000Z");
  assert.equal(app.database.getHistory().length, 2);

  const historyResponse = await fetch(`${app.base}/api/history?limit=1`);
  assert.equal(historyResponse.status, 200);
  assert.equal((await historyResponse.json() as { history: unknown[] }).history.length, 1);
  const alertResponse = await fetch(`${app.base}/api/alerts?limit=10`);
  assert.equal((await alertResponse.json() as { alerts: unknown[] }).alerts.length, 2);

  const updated = await app.settings({ threshold: { mode: "percentage", value: 100 }, automatic: false });
  assert.equal(updated.status, 200);
  const state = await updated.json() as DashboardState;
  assert.equal(state.latestCycle?.alerts.length, 0);
  assert.equal(state.settings.automatic, false);
  assert.equal(state.nextRunAt, null);
  assert.equal(app.database.getAlerts().length, 2);
  assert.equal(app.database.getHistory().length, 2);
});

test("restores the latest persisted cycle when creating another dashboard", async (context) => {
  const app = await start(context);
  await app.dashboard.collect();
  const another = createDashboardServer({ config: readConfig({ DATABASE_PATH: ":memory:" }), database: app.database, clock });
  context.after(() => another.close());
  await new Promise<void>((resolveListen) => another.server.listen(0, "127.0.0.1", resolveListen));
  const address = another.server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/state`);
  const state = await response.json() as DashboardState;
  assert.equal(state.latestCycle?.collectedCount, 2);
  assert.equal(state.latestCycle?.events.length, 1);
  assert.equal(state.nextRunAt, null);
});

test("state notices collections saved externally after the dashboard was opened", async (context) => {
  const app = await start(context);
  await app.dashboard.collect();
  await collectCycle({
    collectors: [sampleCollectors()[0]!], database: app.database,
    threshold: { mode: "percentage", value: 10 },
    clock: () => new Date("2026-10-17T13:00:00Z"),
  });
  const state = await app.getState();
  assert.equal(state.latestCycle?.startedAt, "2026-10-17T13:00:00.000Z");
  assert.equal(state.latestCycle?.collectedCount, 1);
  assert.equal(state.settings.threshold.value, 10);
});

test("rejects overlapping manual collections and exposes the collecting state", { timeout: 3_000 }, async (context) => {
  let started!: () => void;
  const isStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
  let release!: (rows: unknown[]) => void;
  const rows = new Promise<unknown[]>((resolveRows) => { release = resolveRows; });
  const app = await start(context, { collectors: [{ name: "slow", collect: async () => { started(); return rows; } }] });
  await app.settings({ threshold: { mode: "percentage", value: 10 }, automatic: false });
  const first = fetch(`${app.base}/api/collect`, { method: "POST" });
  await isStarted;
  assert.equal((await app.getState()).collecting, true);
  const second = await fetch(`${app.base}/api/collect`, { method: "POST" });
  assert.equal(second.status, 409);
  assert.equal(typeof (await second.json() as { error: unknown }).error, "string");
  release([]);
  assert.equal((await (await first).json() as DashboardState).collecting, false);
});

test("automatic collection and manual collection cannot overlap", { timeout: 3_000 }, async (context) => {
  let cycles = 0;
  let autoStarted!: () => void;
  const automatic = new Promise<void>((resolveStarted) => { autoStarted = resolveStarted; });
  let release!: () => void;
  const waiting = new Promise<void>((resolveWaiting) => { release = resolveWaiting; });
  const app = await start(context, {
    config: { ...readConfig({ DATABASE_PATH: ":memory:" }), intervalMs: 20 },
    collectors: [{ name: "automatic", collect: async () => {
      cycles += 1;
      if (cycles === 2) { autoStarted(); await waiting; }
      return [];
    } }],
  });
  await app.dashboard.collect();
  await automatic;
  assert.equal((await app.getState()).collecting, true);
  assert.equal((await fetch(`${app.base}/api/collect`, { method: "POST" })).status, 409);
  const settings = await app.settings({ threshold: { mode: "absolute", value: 0.2 }, automatic: false });
  assert.equal((await settings.json() as DashboardState).nextRunAt, null);
  release();
  await app.dashboard.close();
  assert.equal(cycles, 2);
});

test("strictly validates settings, methods, limits, origins, JSON and body size", async (context) => {
  const app = await start(context);
  for (const invalid of [
    null, [], {}, { threshold: { mode: "percentage", value: 10 }, automatic: "false" },
    { threshold: { mode: "percentage", value: "10" }, automatic: true },
    { threshold: { mode: "percentage", value: -1 }, automatic: true },
    { threshold: { mode: "unknown", value: 10 }, automatic: true },
    { threshold: { mode: "percentage", value: null }, automatic: true },
    { threshold: { mode: "percentage", value: 10, extra: true }, automatic: true },
    { threshold: { mode: "percentage", value: 10 }, automatic: true, extra: true },
  ]) assert.equal((await app.settings(invalid)).status, 400);

  for (const limit of ["0", "-1", "1.5", "10001", "abc", "1&limit=2"]) {
    assert.equal((await fetch(`${app.base}/api/history?limit=${limit}`)).status, 400);
  }
  assert.equal((await fetch(`${app.base}/api/collect`)).status, 405);
  assert.equal((await fetch(`${app.base}/api/state`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${app.base}/api/collect`, { method: "POST", headers: { origin: "https://example.com" } })).status, 403);
  assert.equal((await fetch(`${app.base}/api/settings`, { method: "POST", body: "{}" })).status, 415);
  assert.equal((await fetch(`${app.base}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status, 400);
  assert.equal((await fetch(`${app.base}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(16_385) })).status, 413);
  assert.equal((await fetch(`${app.base}/api/collect`, { method: "POST", body: "{}" })).status, 400);
  assert.equal((await app.getState()).settings.threshold.value, 10);
});

test("serves only whitelisted public assets, including HEAD", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "odds-web-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(directory, "index.html"), "<!doctype html><title>Test</title>"),
    writeFile(join(directory, "styles.css"), "body { color: black; }"),
    writeFile(join(directory, "app.js"), "console.log('test');"),
    writeFile(join(directory, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    writeFile(join(directory, "secret.txt"), "secret"),
  ]);
  const app = await start(context, { publicDir: directory });
  const html = await fetch(app.base);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await html.text(), /<title>Test<\/title>/);
  for (const path of ["/index.html", "/styles.css", "/app.js", "/favicon.svg"]) assert.equal((await fetch(`${app.base}${path}`)).status, 200);
  const head = await fetch(`${app.base}/styles.css`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  for (const path of ["/secret.txt", "/src/config.ts", "/%2e%2e/package.json", "/toString"]) {
    assert.equal((await fetch(`${app.base}${path}`)).status, 404);
  }
});

test("rejects nonlocal Host headers and oversized chunked bodies", async (context) => {
  const app = await start(context);
  const nonlocal = await new Promise<number>((resolveResponse, reject) => {
    const request = httpRequest(`${app.base}/api/state`, { headers: { host: "example.com" } }, (response) => {
      response.resume();
      response.once("end", () => resolveResponse(response.statusCode!));
    });
    request.once("error", reject);
    request.end();
  });
  assert.equal(nonlocal, 403);
  const oversized = await new Promise<number>((resolveResponse, reject) => {
    const request = httpRequest(`${app.base}/api/settings`, {
      method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
    }, (response) => {
      response.resume();
      response.once("end", () => resolveResponse(response.statusCode!));
    });
    request.once("error", reject);
    request.write("x".repeat(8_000));
    request.end("x".repeat(9_000));
  });
  assert.equal(oversized, 413);
  assert.equal((await app.getState()).settings.threshold.value, 10);
});

test("reports collector failures without hiding successful data", async (context) => {
  const app = await start(context, { collectors: [
    ...sampleCollectors(), { name: "broken", collect: async () => { throw new Error("source indisponible"); } },
  ] });
  const response = await fetch(`${app.base}/api/collect`, { method: "POST" });
  assert.equal(response.status, 200);
  const state = await response.json() as DashboardState;
  assert.equal(state.latestCycle?.collectedCount, 2);
  assert.deepEqual(state.latestCycle?.errors, [{ source: "broken", message: "source indisponible" }]);
});

test("returns a JSON 500 without exposing internal errors", async (context) => {
  const database = new OddsDatabase(":memory:");
  context.after(() => database.close());
  const app = await start(context, { database: {
    getLatestCycle: () => database.getLatestCycle(), getHistory: () => database.getHistory(),
    getAlerts: () => database.getAlerts(), saveCycle: () => { throw new Error("internal secret path C:/private/key.txt apiKey=test-secret"); },
  }, onError: () => {} });
  const response = await fetch(`${app.base}/api/collect`, { method: "POST" });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Une erreur interne est survenue.", code: "INTERNAL_ERROR" });
  assert.equal((await app.getState()).collecting, false);
  assert.deepEqual((await app.getState()).lastError, { code: "INTERNAL_ERROR", message: "Une erreur interne est survenue." });
});

test("serves the recovery interface during a storage outage and reads fresh data after recovery", async (context) => {
  let unavailable = true;
  const database = new OddsDatabase(":memory:");
  context.after(() => database.close());
  const check = () => { if (unavailable) throw new AppError("DATABASE_BUSY", "La base est occupée. Réessayez dans un instant."); };
  const app = await start(context, { database: {
    getLatestCycle: () => { check(); return database.getLatestCycle(); },
    getHistory: (limit, sources) => { check(); return database.getHistory(limit, sources); },
    getAlerts: (limit, sources) => { check(); return database.getAlerts(limit, sources); },
    saveCycle: (cycle) => { check(); return database.saveCycle(cycle); },
  }, onError: () => {} });
  assert.equal((await fetch(app.base)).status, 200);
  for (const path of ["/api/state", "/api/history", "/api/alerts"]) {
    const response = await fetch(`${app.base}${path}`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: "DATABASE_BUSY", error: "La base est occupée. Réessayez dans un instant." });
  }
  const rejectedSettings = await app.settings({ threshold: { mode: "absolute", value: 99 }, automatic: false });
  assert.equal(rejectedSettings.status, 503);
  unavailable = false;
  assert.equal((await app.getState()).settings.threshold.value, 10);
  const collected = await fetch(`${app.base}/api/collect`, { method: "POST" });
  assert.equal(collected.status, 200);
  assert.equal((await collected.json() as DashboardState).latestCycle?.collectedCount, 2);
  assert.equal((await app.getState()).lastError, null);
});

test("a failed save is visible until a new cycle is durably saved", async (context) => {
  let unavailable = false;
  const database = new OddsDatabase(":memory:");
  context.after(() => database.close());
  const app = await start(context, { database: {
    getLatestCycle: () => database.getLatestCycle(), getHistory: () => database.getHistory(),
    getAlerts: () => database.getAlerts(), saveCycle: (cycle) => {
      if (unavailable) throw new AppError("DATABASE_FULL", "Le disque est plein. Libérez de l’espace puis réessayez.");
      return database.saveCycle(cycle);
    },
  }, onError: () => {} });
  await app.dashboard.collect();
  const original = database.getLatestCycle();
  unavailable = true;
  const failed = await fetch(`${app.base}/api/collect`, { method: "POST" });
  assert.equal(failed.status, 503);
  assert.equal((await failed.json() as { code: string }).code, "DATABASE_FULL");
  const state = await app.getState();
  assert.equal(state.lastError?.code, "DATABASE_FULL");
  assert.equal(state.collecting, false);
  assert.equal(state.latestCycle?.startedAt, original?.startedAt);
  assert.equal(database.getHistory().length, 2);
  unavailable = false;
  await app.dashboard.collect();
  assert.equal((await app.getState()).lastError, null);
  assert.equal(database.getHistory().length, 4);
});

test("settings use one storage snapshot so a subsequent read failure cannot reject applied settings", async (context) => {
  let reads = 0;
  const database = new OddsDatabase(":memory:");
  context.after(() => database.close());
  const app = await start(context, { database: {
    getLatestCycle: () => {
      reads += 1;
      if (reads === 2) throw new AppError("DATABASE_BUSY", "La base est occupée.");
      return database.getLatestCycle();
    },
    getHistory: () => database.getHistory(), getAlerts: () => database.getAlerts(),
    saveCycle: (cycle) => database.saveCycle(cycle),
  }, onError: () => {} });
  const updated = await app.settings({ threshold: { mode: "percentage", value: 99 }, automatic: false });
  assert.equal(updated.status, 200);
  const confirmed = await updated.json() as DashboardState;
  assert.equal(confirmed.settings.threshold.value, 99);
  assert.equal(confirmed.settings.automatic, false);
  assert.equal(reads, 1);
  // The next independent read can fail, while the accepted settings remain explicit.
  assert.equal((await fetch(`${app.base}/api/state`)).status, 503);
  assert.equal((await app.getState()).settings.threshold.value, 99);
});

test("a committed collection is confirmed without an additional potentially failing storage read", async (context) => {
  let unavailable = true;
  let reads = 0;
  const database = new OddsDatabase(":memory:");
  context.after(() => database.close());
  const app = await start(context, { database: {
    getLatestCycle: () => {
      reads += 1;
      if (unavailable) throw new AppError("DATABASE_READ_FAILED", "La lecture est indisponible.");
      return database.getLatestCycle();
    },
    getHistory: () => database.getHistory(), getAlerts: () => database.getAlerts(),
    saveCycle: (cycle) => database.saveCycle(cycle),
  }, onError: () => {} });
  const response = await fetch(`${app.base}/api/collect`, { method: "POST" });
  assert.equal(response.status, 200);
  const confirmed = await response.json() as DashboardState;
  assert.equal(confirmed.latestCycle?.collectedCount, 2);
  assert.equal(confirmed.lastError, null);
  assert.equal(reads, 0);
  assert.equal(database.getHistory().length, 2);
  assert.equal((await fetch(`${app.base}/api/state`)).status, 503);
  unavailable = false;
  assert.equal((await app.getState()).latestCycle?.collectedCount, 2);
});

test("stable error codes cover rejected requests and a failing logger cannot break HTTP", async (context) => {
  const database = new OddsDatabase(":memory:");
  context.after(() => database.close());
  const app = await start(context, { database: {
    getLatestCycle: () => { throw new AppError("DATABASE_READ_FAILED", "Lecture indisponible."); },
    getHistory: () => [], getAlerts: () => [], saveCycle: () => 0,
  }, onError: () => { throw new Error("logging failed"); } });
  const invalid = await fetch(`${app.base}/api/history?limit=abc`);
  assert.equal((await invalid.json() as { code: string }).code, "HTTP_400");
  const failure = await fetch(`${app.base}/api/state`);
  assert.equal(failure.status, 503);
  assert.equal((await failure.json() as { code: string }).code, "DATABASE_READ_FAILED");
  assert.equal((await fetch(app.base)).status, 200);
});

test("an automatic failed save and a rejecting logger do not stop recovery", { timeout: 3_000 }, async (context) => {
  let unavailable = false;
  let reported!: () => void;
  const automaticFailure = new Promise<void>((resolveReported) => { reported = resolveReported; });
  const database = new OddsDatabase(":memory:");
  context.after(() => database.close());
  const app = await start(context, {
    config: { ...readConfig({ DATABASE_PATH: ":memory:" }), intervalMs: 20 },
    database: {
      getLatestCycle: () => database.getLatestCycle(), getHistory: () => database.getHistory(),
      getAlerts: () => database.getAlerts(), saveCycle: (cycle) => {
        if (unavailable) throw new AppError("DATABASE_WRITE_FAILED", "L’enregistrement est indisponible.");
        return database.saveCycle(cycle);
      },
    },
    onError: async () => { reported(); throw new Error("logging rejected"); },
  });
  await app.dashboard.collect();
  unavailable = true;
  await automaticFailure;
  const response = await app.settings({ threshold: { mode: "percentage", value: 10 }, automatic: false });
  const failed = await response.json() as DashboardState;
  assert.equal(failed.collecting, false);
  assert.equal(failed.nextRunAt, null);
  assert.equal(failed.lastError?.code, "DATABASE_WRITE_FAILED");
  unavailable = false;
  await app.dashboard.collect();
  assert.equal((await app.getState()).lastError, null);
});

test("malformed HTTP receives a controlled response and leaves the service usable", { timeout: 3_000 }, async (context) => {
  const app = await start(context);
  const address = app.dashboard.server.address() as AddressInfo;
  const raw = await new Promise<string>((resolveResponse, reject) => {
    const socket = createConnection(address.port, "127.0.0.1");
    let response = "";
    socket.once("connect", () => socket.write("INVALID HTTP\r\n\r\n"));
    socket.on("data", (chunk) => { response += chunk.toString(); });
    socket.once("error", reject);
    socket.once("end", () => resolveResponse(response));
  });
  assert.match(raw, /HTTP\/1\.1 400/);
  assert.match(raw, /"code":"HTTP_400"/);
  assert.equal((await fetch(`${app.base}/api/state`)).status, 200);
});

test("a client disconnecting during collection does not cancel a complete persisted cycle", { timeout: 3_000 }, async (context) => {
  let started!: () => void;
  const collectionStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
  let release!: (rows: unknown[]) => void;
  const rows = new Promise<unknown[]>((resolveRows) => { release = resolveRows; });
  let saved!: () => void;
  const collectionSaved = new Promise<void>((resolveSaved) => { saved = resolveSaved; });
  const database = new OddsDatabase(":memory:");
  context.after(() => database.close());
  const app = await start(context, { collectors: [{ name: "slow", collect: async () => { started(); return rows; } }], database: {
    getLatestCycle: () => database.getLatestCycle(), getHistory: () => database.getHistory(), getAlerts: () => database.getAlerts(),
    saveCycle: (cycle) => { const id = database.saveCycle(cycle); saved(); return id; },
  } });
  const request = httpRequest(`${app.base}/api/collect`, { method: "POST" });
  request.on("error", () => {});
  request.end();
  await collectionStarted;
  request.destroy();
  release([]);
  await collectionSaved;
  const state = await app.getState();
  assert.equal(state.collecting, false);
  assert.equal(state.latestCycle?.collectedCount, 0);
  assert.equal(state.lastError, null);
});

test("API mode exposes its mode and real odds without exposing server credentials", async (context) => {
  const fakeKey = "test-secret-must-stay-server-side";
  const source = sampleCollectors()[0]!;
  const app = await start(context, {
    config: readConfig({ DATA_SOURCE: "odds-api", ODDS_API_KEY: fakeKey, DATABASE_PATH: ":memory:" }),
    collectors: [{ ...source, name: "1xbet" }],
  });
  const response = await fetch(`${app.base}/api/collect`, { method: "POST" });
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.equal(raw.includes(fakeKey), false);
  assert.equal(raw.includes("oddsApiKey"), false);
  assert.equal(raw.includes("apiKey="), false);
  const state = JSON.parse(raw) as DashboardState;
  assert.equal(state.dataSource, "odds-api");
  assert.deepEqual(state.sources, ["1xbet"]);
  assert.equal(state.latestCycle?.collectedCount, 1);
  assert.equal(state.latestCycle?.alerts.length, 0);
  const history = await (await fetch(`${app.base}/api/history`)).json() as { history: { source: string }[] };
  assert.deepEqual(history.history.map((row) => row.source), ["1xbet"]);
});

test("API mode advertises the three configured sources before its first collection", async (context) => {
  const app = await start(context, {
    config: readConfig({ DATA_SOURCE: "odds-api", ODDS_API_KEY: "unused-test-key", DATABASE_PATH: ":memory:" }),
    collectors: undefined,
  });
  const state = await app.getState();
  assert.deepEqual(state.sources, ["1xbet", "bet261", "pinnacle"]);
  assert.equal(state.latestCycle, null);
  assert.equal(state.collecting, false);
});

test("real 1xbet, bet261 and pinnacle quotes are matched, stored and exposed by every API route", async (context) => {
  const app = await start(context, {
    config: readConfig({ DATA_SOURCE: "odds-api", ODDS_API_KEY: "unused-test-secret", DATABASE_PATH: ":memory:" }),
    collectors: realSourceStubs(),
  });
  const response = await fetch(`${app.base}/api/collect`, { method: "POST" });
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.equal(raw.includes("unused-test-secret"), false);
  const state = JSON.parse(raw) as DashboardState;
  assert.deepEqual(state.sources, ["1xbet", "bet261", "pinnacle"]);
  assert.equal(state.latestCycle?.collectedCount, 3);
  assert.equal(state.latestCycle?.events.length, 1);
  assert.deepEqual(state.latestCycle?.events[0]?.quotes.map((quote) => quote.source).sort(), ["1xbet", "bet261", "pinnacle"]);
  assert.equal(state.latestCycle?.alerts.length, 2);
  const history = await (await fetch(`${app.base}/api/history`)).json() as { history: { source: string }[] };
  assert.deepEqual(history.history.map((row) => row.source).sort(), ["1xbet", "bet261", "pinnacle"]);
  const alerts = await (await fetch(`${app.base}/api/alerts`)).json() as {
    alerts: { minSource: string; maxSource: string }[];
  };
  assert.equal(alerts.alerts.length, 2);
  assert.ok(alerts.alerts.every((alert) => alert.minSource === "1xbet" && alert.maxSource === "pinnacle"));
});

test("a failed bet261 collection keeps comparing 1xbet with pinnacle and identifies the unavailable source", async (context) => {
  const app = await start(context, {
    config: readConfig({ DATA_SOURCE: "odds-api", ODDS_API_KEY: "unused-test-key", DATABASE_PATH: ":memory:" }),
    collectors: [realSourceStubs()[0]!, {
      name: "bet261", collect: async () => { throw new Error("Le site Bet261 est indisponible."); },
    }, realSourceStubs()[2]!],
  });
  const response = await fetch(`${app.base}/api/collect`, { method: "POST" });
  assert.equal(response.status, 200);
  const state = await response.json() as DashboardState;
  assert.deepEqual(state.sources, ["1xbet", "bet261", "pinnacle"]);
  assert.equal(state.latestCycle?.collectedCount, 2);
  assert.equal(state.latestCycle?.alerts.length, 2);
  assert.deepEqual(state.latestCycle?.errors, [{ source: "bet261", message: "Le site Bet261 est indisponible." }]);
  assert.deepEqual(app.database.getHistory().map((row) => row.source).sort(), ["1xbet", "pinnacle"]);
});

test("disabling bet261 preserves its real history and alerts while still excluding mock data", async (context) => {
  const app = await start(context, {
    config: readConfig({
      DATA_SOURCE: "odds-api", ODDS_API_KEY: "unused-test-key", DATABASE_PATH: ":memory:", BET261_ENABLED: "false",
    }),
    collectors: undefined,
  });
  const initial = await app.getState();
  assert.deepEqual(initial.sources, ["1xbet", "pinnacle"]);
  // Simulate data written by a previous CLI session before Bet261 was disabled.
  await collectCycle({
    collectors: [...realSourceStubs(), ...sampleCollectors()], database: app.database,
    threshold: { mode: "percentage", value: 10 }, clock,
  });
  assert.equal(app.database.getHistory().length, 5);
  const state = await app.getState();
  assert.deepEqual(state.sources, ["1xbet", "pinnacle"]);
  assert.equal(state.latestCycle?.collectedCount, 3);
  assert.equal(state.latestCycle?.events.length, 1);
  assert.equal(state.latestCycle?.alerts.length, 2);
  const history = await (await fetch(`${app.base}/api/history`)).json() as { history: { source: string }[] };
  assert.deepEqual(history.history.map((row) => row.source).sort(), ["1xbet", "bet261", "pinnacle"]);
  const alerts = await (await fetch(`${app.base}/api/alerts`)).json() as {
    alerts: { minSource: string; maxSource: string }[];
  };
  assert.equal(alerts.alerts.length, 2);
  assert.ok(alerts.alerts.every((alert) => alert.minSource === "1xbet" && alert.maxSource === "pinnacle"));
});

test("API mode never presents old mock quotes as real odds even with a reused database", async (context) => {
  const database = new OddsDatabase(":memory:");
  const mockApp = createDashboardServer({ config: readConfig({}), database, collectors: sampleCollectors(), clock });
  let oldCycle: DashboardState["latestCycle"];
  try {
    oldCycle = (await mockApp.collect()).latestCycle;
  } finally {
    await mockApp.close();
    database.close();
  }
  const app = await start(context, {
    config: readConfig({ DATA_SOURCE: "odds-api", ODDS_API_KEY: "test-key-not-real", DATABASE_PATH: ":memory:" }),
    collectors: [],
  });
  assert.ok(oldCycle);
  app.database.saveCycle(oldCycle);
  assert.equal((await app.getState()).latestCycle?.events.length, 0);
  assert.deepEqual(await (await fetch(`${app.base}/api/history`)).json(), { history: [] });
  assert.deepEqual(await (await fetch(`${app.base}/api/alerts`)).json(), { alerts: [] });
});

test("real history and alerts are filtered before applying the requested limit", async (context) => {
  const app = await start(context, {
    config: readConfig({ DATA_SOURCE: "odds-api", ODDS_API_KEY: "unused-test-key", DATABASE_PATH: ":memory:" }),
    collectors: realSourceStubs(),
  });
  await app.dashboard.collect();
  await collectCycle({
    collectors: sampleCollectors(), database: app.database, threshold: { mode: "percentage", value: 10 },
    clock: () => new Date("2026-10-17T12:01:00Z"),
  });
  const history = await (await fetch(`${app.base}/api/history?limit=1`)).json() as { history: { source: string }[] };
  assert.equal(history.history.length, 1);
  assert.equal(history.history[0]!.source, "pinnacle");
  const alerts = await (await fetch(`${app.base}/api/alerts?limit=1`)).json() as { alerts: { minSource: string; maxSource: string }[] };
  assert.equal(alerts.alerts.length, 1);
  assert.equal(alerts.alerts[0]!.minSource, "1xbet");
  assert.equal(alerts.alerts[0]!.maxSource, "pinnacle");
  assert.deepEqual(app.database.getHistory(1, []), []);
  assert.deepEqual(app.database.getAlerts(1, []), []);
});

test("closing aborts an active collection and does not write an unfinished cycle", async (context) => {
  let started!: () => void;
  const isStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
  const app = await start(context, { collectors: [{ name: "blocked", collect: async () => {
    started();
    return new Promise(() => {});
  } }] });
  const collecting = app.dashboard.collect();
  const rejected = assert.rejects(collecting, { name: "AbortError" });
  await isStarted;
  await app.dashboard.close();
  await rejected;
  assert.equal(app.database.getHistory().length, 0);
  await assert.rejects(app.dashboard.collect(), /arrêt/);
});

test("shutdown bounds an incomplete request body and cannot apply its unfinished settings", { timeout: 3_000 }, async (context) => {
  const app = await start(context);
  const address = app.dashboard.server.address() as AddressInfo;
  const socket = createConnection(address.port, "127.0.0.1");
  context.after(() => socket.destroy());
  socket.on("error", () => {});
  const requestReceived = new Promise<void>((resolveRequest) => {
    app.dashboard.server.once("request", () => resolveRequest());
  });
  await new Promise<void>((resolveConnect) => socket.once("connect", resolveConnect));
  socket.write(`POST /api/settings HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await requestReceived;
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let closed = false;
  const closing = app.dashboard.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  context.mock.timers.tick(1_999);
  assert.equal(closed, false);
  context.mock.timers.tick(1);
  await closing;
  context.mock.timers.reset();
  assert.equal(closed, true);
  assert.equal(app.dashboard.server.listening, false);
  assert.equal(app.database.getLatestCycle(), null);
  await assert.rejects(app.dashboard.collect(), /arrêt/);
});
