import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverCollectors } from "../src/collectors/mock.js";
import { OddsDatabase } from "../src/database/sqlite.js";
import { AppError } from "../src/errors.js";
import { collectCycle } from "../src/services/collectCycle.js";
import type { Collector, CycleResult, RawMatch, Threshold } from "../src/types.js";

const now = "2026-10-17T10:00:00.000Z";
const threshold: Threshold = { mode: "percentage", value: 10 };
// Prépare les éléments nécessaires au test.
const clock = () => new Date(now);

// Prépare un historique pour les tests.
function row(overrides: Partial<RawMatch> = {}): RawMatch {
  return {
    sourceMatchId: "one", homeTeam: "PSG", awayTeam: "Marseille", competition: "Ligue 1",
    startsAt: "2026-10-18T18:00:00Z", odds: { "1": 2, X: 3, "2": 4 }, ...overrides,
  };
}

// Prépare les éléments nécessaires au test.
function source(name: string, rows: unknown[] = [row()]): Collector {
  return { name, async collect() { return structuredClone(rows); } };
}

// Prépare les éléments nécessaires au test.
function tracked(database: OddsDatabase) {
  const saved: { runId: number; result: CycleResult }[] = [];
  return {
    saved,
    saveCycle(result: CycleResult): number {
      const runId = database.saveCycle(result);
      saved.push({ runId, result });
      return runId;
    },
  };
}

test("JSON fixtures flow through normalization, matching, comparison and repeated SQLite snapshots", async () => {
  const database = new OddsDatabase(":memory:");
  try {
    const collectors = await discoverCollectors(fileURLToPath(new URL("../data/examples", import.meta.url)));
    const first = await collectCycle({ collectors, database, threshold, clock });
    assert.equal(first.collectedCount, 7);
    assert.equal(first.events.length, 4);
    assert.equal(first.events.filter((event) => event.quotes.length === 2).length, 3);
    assert.equal(first.alerts.length, 2);
    assert.equal(first.rejectedCount, 1);
    assert.equal(first.skippedCount, 1);
    assert.equal(first.errors.length, 1);
    assert.equal(first.errors[0]!.source, "exemple-a");
    assert.match(first.errors[0]!.message, /odds\.1/);
    const paris = first.events.find((event) => event.quotes.some((quote) => quote.sourceMatchId === "a-psg-marseille"))!;
    assert.equal(paris.quotes.length, 2);
    assert.deepEqual(paris.quotes.map((quote) => quote.normalizedHomeTeam), ["paris saint germain", "paris saint germain"]);
    assert.equal(paris.startsAt, "2026-10-18T18:00:00.000Z");
    assert.deepEqual(first.alerts.map((alert) => [alert.eventId, alert.outcome]), [[paris.id, "1"], [paris.id, "2"]]);
    assert.ok(first.alerts.every((alert) => alert.minSource === "exemple-a" && alert.maxSource === "exemple-b"));
    const firstHistory = database.getHistory();
    assert.equal(firstHistory.length, 7);
    assert.equal(database.getAlerts().length, 2);
    assert.ok(firstHistory.every((entry) => entry.collectedAt === now));
    assert.equal(firstHistory.find((entry) => entry.sourceMatchId === "b-paris-om")!.homeTeam, "PSG");
    assert.deepEqual(firstHistory.find((entry) => entry.sourceMatchId === "b-paris-om")!.odds, { "1": 2.05, X: 3.55, "2": 5.1 });
    assert.ok(firstHistory.every((entry) => !["a-past-example", "a-invalid-example"].includes(entry.sourceMatchId)));

    const nextTime = "2026-10-17T10:10:00.000Z";
    const second = await collectCycle({ collectors, database, threshold, clock: () => new Date(nextTime) });
    assert.deepEqual(second.events.map((event) => event.id), first.events.map((event) => event.id));
    const history = database.getHistory();
    assert.equal(history.length, 14);
    assert.equal(database.getAlerts().length, 4);
    assert.equal(history.filter((entry) => entry.collectedAt === now).length, 7);
    assert.equal(history.filter((entry) => entry.collectedAt === nextTime).length, 7);
    assert.equal(new Set(history.map((entry) => entry.runId)).size, 2);
    assert.equal(new Set(history.map((entry) => entry.eventId)).size, 4);
  } finally {
    database.close();
  }
});

test("a collector failure is isolated while healthy observations persist", async () => {
  const database = new OddsDatabase(":memory:");
  try {
    const failing: Collector = { name: "broken", async collect() { throw new Error("upstream unavailable"); } };
    const result = await collectCycle({ collectors: [failing, source("healthy")], database, threshold, clock });
    assert.deepEqual(result.errors, [{ source: "broken", message: "upstream unavailable" }]);
    assert.equal(result.collectedCount, 1);
    assert.equal(result.events.length, 1);
    assert.equal(result.alerts.length, 0);
    assert.deepEqual(database.getHistory().map((entry) => entry.source), ["healthy"]);
  } finally {
    database.close();
  }
});

test("a collector that never settles is bounded by its timeout and receives cancellation", { timeout: 1000 }, async () => {
  const database = new OddsDatabase(":memory:");
  let collectorSignal: AbortSignal | undefined;
  try {
    const blocked: Collector = {
      name: "blocked",
      collect({ signal }) {
        collectorSignal = signal;
        return new Promise<unknown[]>(() => {});
      },
    };
    const result = await collectCycle({
      collectors: [blocked, source("healthy")], database, threshold, clock, collectorTimeoutMs: 10,
    });
    assert.equal(collectorSignal?.aborted, true);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.source, "blocked");
    assert.match(result.errors[0]!.message, /10 ms/);
    assert.equal(result.collectedCount, 1);
    assert.equal(database.getHistory().length, 1);
  } finally {
    database.close();
  }
});

test("duplicate source names are rejected before collection or persistence", async () => {
  const database = new OddsDatabase(":memory:");
  let calls = 0;
  const collect = async () => { calls++; return [row()]; };
  const persistence = tracked(database);
  try {
    for (const name of ["same", " same "]) {
      await assert.rejects(collectCycle({
        collectors: [{ name: "same", collect }, { name, collect }],
        database: persistence, threshold, clock,
      }), /uniques/);
    }
    assert.equal(calls, 0);
    assert.equal(persistence.saved.length, 0);
    assert.deepEqual(database.getHistory(), []);
  } finally {
    database.close();
  }
});

test("a single source records every upcoming match without producing alerts", async () => {
  const database = new OddsDatabase(":memory:");
  try {
    const result = await collectCycle({
      collectors: [source("only", [row(), row({ sourceMatchId: "two", homeTeam: "Chelsea", awayTeam: "Man United" })])],
      database, threshold: { mode: "absolute", value: 0 }, clock,
    });
    assert.equal(result.events.length, 2);
    assert.equal(result.collectedCount, 2);
    assert.deepEqual(result.alerts, []);
    assert.deepEqual(result.errors, []);
    assert.equal(database.getHistory().length, 2);
    assert.deepEqual(database.getAlerts(), []);
  } finally {
    database.close();
  }
});

test("a failing diagnostics method never discards valid observations", async () => {
  const database = new OddsDatabase(":memory:");
  try {
    const collector: Collector = { ...source("warnings-broken"), getWarnings() { throw new Error("diagnostics unavailable apiKey=fake-secret"); } };
    const result = await collectCycle({ collectors: [collector, source("healthy")], database, threshold, clock });
    assert.equal(result.collectedCount, 2);
    assert.equal(result.events[0]!.quotes.length, 2);
    assert.equal(database.getHistory().length, 2);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.source, "warnings-broken");
    assert.equal(JSON.stringify(database.getLatestCycle()).includes("fake-secret"), false);
  } finally { database.close(); }
});

test("malformed warning lists and non-array results remain isolated to their source", async () => {
  const database = new OddsDatabase(":memory:");
  try {
    const malformedWarnings: Collector = { ...source("bad-warnings"), getWarnings: () => null as never };
    const malformedResult: Collector = { name: "bad-result", collect: async () => ({ rows: [] }) as never };
    const result = await collectCycle({ collectors: [malformedWarnings, malformedResult, source("healthy")], database, threshold, clock });
    assert.equal(result.collectedCount, 2);
    assert.ok(result.errors.some((error) => error.source === "bad-result"));
    assert.ok(result.errors.some((error) => error.source === "bad-warnings"));
    assert.equal(database.getHistory().length, 2);
  } finally { database.close(); }
});

test("invalid application inputs stop before collectors or persistence", async () => {
  let calls = 0;
  let saves = 0;
  const collectors: Collector[] = [{ name: "healthy", collect: async () => { calls++; return [row()]; } }];
  const base = { collectors, database: { saveCycle: () => ++saves }, threshold, clock };
  await assert.rejects(collectCycle({ ...base, threshold: { mode: "percentage", value: -1 } }), /threshold/);
  await assert.rejects(collectCycle({ ...base, matchToleranceMinutes: NaN }), /tolerance/);
  await assert.rejects(collectCycle({ ...base, collectors: [null] as never }), (error: AppError) => error.code === "COLLECTOR_CONFIG_INVALID");
  await assert.rejects(collectCycle({ ...base, clock: () => new Date("invalid") }), (error: AppError) => error.code === "CLOCK_INVALID");
  assert.equal(calls, 0);
  assert.equal(saves, 0);
});

test("an invalid final timestamp or failed persistence never reports a completed cycle", async () => {
  let saved = 0;
  let reads = 0;
  const base = { collectors: [source("healthy")], threshold, database: { saveCycle: () => ++saved } };
  await assert.rejects(collectCycle({ ...base, clock: () => ++reads === 1 ? new Date(now) : new Date("invalid") }),
    (error: AppError) => error.code === "CLOCK_INVALID");
  assert.equal(saved, 0);
  const failure = new AppError("DATABASE_FULL", "Espace insuffisant pour enregistrer les cotes.");
  await assert.rejects(collectCycle({ ...base, clock, database: { saveCycle: () => { throw failure; } } }),
    (error) => error === failure);
});

test("external cancellation stops a running collection without saving a partial cycle", { timeout: 1000 }, async () => {
  const database = new OddsDatabase(":memory:");
  const persistence = tracked(database);
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const controller = new AbortController();
  let collectorSignal: AbortSignal | undefined;
  try {
    const blocked: Collector = {
      name: "blocked",
      collect({ signal }) {
        collectorSignal = signal;
        markStarted();
        return new Promise<unknown[]>(() => {});
      },
    };
    const pending = collectCycle({
      collectors: [blocked, source("healthy")], database: persistence, threshold, clock,
      collectorTimeoutMs: 20, signal: controller.signal,
    });
    await started;
    controller.abort(new Error("external cancellation"));
    await assert.rejects(pending, /external cancellation/);
    assert.equal(collectorSignal?.aborted, true);
    assert.equal(persistence.saved.length, 0);
    assert.deepEqual(database.getHistory(), []);
    assert.deepEqual(database.getAlerts(), []);
  } finally {
    database.close();
  }
});

test("a signal cancelled before collection invokes no collector and saves no cycle", async () => {
  const database = new OddsDatabase(":memory:");
  const persistence = tracked(database);
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  let called = false;
  try {
    await assert.rejects(collectCycle({
      collectors: [{ name: "never-started", async collect() { called = true; return [row()]; } }],
      database: persistence, threshold, clock, signal: controller.signal,
    }), /already cancelled/);
    assert.equal(called, false);
    assert.equal(persistence.saved.length, 0);
  } finally {
    database.close();
  }
});

test("a non-array collector payload is recorded as a source error without losing healthy matches", async () => {
  const database = new OddsDatabase(":memory:");
  try {
    const malformed: Collector = {
      name: "malformed", async collect() { return { matches: [row()] } as unknown as unknown[]; },
    };
    const result = await collectCycle({ collectors: [malformed, source("healthy")], database, threshold, clock });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.source, "malformed");
    assert.match(result.errors[0]!.message, /tableau/);
    assert.equal(result.rejectedCount, 0);
    assert.equal(result.collectedCount, 1);
    assert.equal(database.getHistory().length, 1);
  } finally {
    database.close();
  }
});

test("even an entirely failed collection persists its run before the next successful cycle", async () => {
  const database = new OddsDatabase(":memory:");
  const persistence = tracked(database);
  try {
    const broken = (name: string): Collector => ({ name, async collect() { throw new Error(`${name} offline`); } });
    const result = await collectCycle({ collectors: [broken("a"), broken("b")], database: persistence, threshold, clock });
    assert.equal(result.errors.length, 2);
    assert.equal(result.collectedCount, 0);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.alerts, []);
    assert.equal(persistence.saved.length, 1);
    assert.equal(persistence.saved[0]!.runId, 1);
    assert.equal(persistence.saved[0]!.result, result);
    assert.deepEqual(database.getHistory(), []);
    await collectCycle({ collectors: [source("restored")], database, threshold, clock });
    assert.equal(database.getHistory()[0]!.runId, 2);
  } finally {
    database.close();
  }
});
