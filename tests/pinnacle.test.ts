import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { OneXBetCollector } from "../src/collectors/oneXBet.js";
import { PinnacleCollector } from "../src/collectors/pinnacle.js";
import type { CollectionContext, RawMatch } from "../src/types.js";

const apiKey = "fake-pinnacle-test-key";
const now = new Date("2026-10-17T10:00:00.321Z");
// Prépare les éléments nécessaires au test.
const context = (): CollectionContext => ({ now: new Date(now), signal: new AbortController().signal });

// Prépare les éléments nécessaires au test.
function outcomes(home = 1.62, draw = 4.4, away = 5.9): unknown[] {
  return [{ name: "Fulham", price: away }, { name: "Chelsea", price: home }, { name: "Draw", price: draw }];
}

// Prépare les éléments nécessaires au test.
function bookmaker(key = "pinnacle", values = outcomes(), marketKey = "h2h"): Record<string, unknown> {
  return { key, markets: [{ key: marketKey, outcomes: values }] };
}

// Prépare un exemple de match pour les tests.
function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "event-1", sport_key: "soccer_epl", sport_title: "EPL", commence_time: "2026-10-18T18:00:00Z",
    home_team: "Chelsea", away_team: "Fulham", bookmakers: [bookmaker()], ...overrides,
  };
}

// Simule la réponse d’un site.
function fakeFetch(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(
    new URL(input instanceof Request ? input.url : input.toString()), init,
  )) as typeof globalThis.fetch;
}

// Prépare les éléments nécessaires au test.
function returning(payload: unknown): typeof globalThis.fetch {
  return fakeFetch(() => Response.json(payload));
}

test("Pinnacle requests its own bookmaker with the existing key and maps h2h outcomes by name", async () => {
  const options = context();
  let calls = 0;
  const collector = new PinnacleCollector({ apiKey: ` ${apiKey} `, sports: ["soccer_epl", "soccer_epl"], fetch: fakeFetch((url, init) => {
    calls++;
    assert.equal(url.origin, "https://api.the-odds-api.com");
    assert.equal(url.pathname, "/v4/sports/soccer_epl/odds");
    assert.equal(url.searchParams.get("apiKey"), apiKey);
    assert.equal(url.searchParams.get("bookmakers"), "pinnacle");
    assert.equal(url.searchParams.get("markets"), "h2h");
    assert.equal(url.searchParams.get("oddsFormat"), "decimal");
    assert.equal(url.searchParams.get("dateFormat"), "iso");
    assert.equal(url.searchParams.get("commenceTimeFrom"), "2026-10-17T10:00:00Z");
    assert.equal(url.searchParams.has("regions"), false);
    assert.equal(init?.signal, options.signal);
    assert.equal(init?.redirect, "error");
    return Response.json([event()]);
  }) });
  assert.equal(collector.name, "pinnacle");
  assert.deepEqual(await collector.collect(options), [{
    sourceMatchId: "event-1", homeTeam: "Chelsea", awayTeam: "Fulham", competition: "EPL",
    startsAt: "2026-10-18T18:00:00.000Z", odds: { "1": 1.62, X: 4.4, "2": 5.9 },
  }]);
  assert.equal(calls, 1);
  assert.deepEqual(collector.getWarnings(), []);
  assert.equal(inspect(collector).includes(apiKey), false);
});

test("1xBet and Pinnacle never substitute or mix each other's prices and warnings", async () => {
  const calls: string[] = [];
  const fetch = fakeFetch((url) => {
    calls.push(url.searchParams.get("bookmakers")!);
    return Response.json([
      event({ bookmakers: [bookmaker("onexbet", outcomes(1.54, 4.62, 6.23)), bookmaker()] }),
      event({ id: "only-onexbet", bookmakers: [bookmaker("onexbet", outcomes(1.54, 4.62, 6.23))] }),
    ]);
  });
  const oneXBet = new OneXBetCollector({ apiKey, sports: ["soccer_epl"], fetch });
  const pinnacle = new PinnacleCollector({ apiKey, sports: ["soccer_epl"], fetch });
  const [oneXBetMatches, pinnacleMatches] = await Promise.all([
    oneXBet.collect(context()) as Promise<RawMatch[]>, pinnacle.collect(context()) as Promise<RawMatch[]>,
  ]);
  assert.deepEqual(calls, ["onexbet", "pinnacle"]);
  assert.equal(oneXBetMatches.length, 2);
  assert.equal(pinnacleMatches.length, 1);
  assert.deepEqual(oneXBetMatches[0]!.odds, { "1": 1.54, X: 4.62, "2": 6.23 });
  assert.deepEqual(pinnacleMatches[0]!.odds, { "1": 1.62, X: 4.4, "2": 5.9 });
  assert.deepEqual(oneXBet.getWarnings(), []);
  assert.deepEqual(pinnacle.getWarnings(), [{
    source: "pinnacle", message: "soccer_epl : 1 rencontre(s) sans marché 1X2 complet chez Pinnacle.",
  }]);
});

test("Pinnacle rejects absent, duplicate or incomplete h2h markets and non-numeric prices", async () => {
  const rows = [
    event({ bookmakers: [bookmaker("onexbet")] }),
    event({ bookmakers: [bookmaker(), bookmaker()] }),
    event({ bookmakers: [{ key: "pinnacle", markets: [...bookmaker().markets as unknown[], ...bookmaker().markets as unknown[]] }] }),
    event({ bookmakers: [bookmaker("pinnacle", outcomes().slice(0, 2))] }),
    event({ bookmakers: [bookmaker("pinnacle", outcomes(), "h2h_3_way")] }),
    event({ bookmakers: [bookmaker("pinnacle", outcomes(), "h2h_lay")] }),
    event({ bookmakers: [bookmaker("pinnacle", [{ name: "Chelsea", price: 1.62 }, { name: "Chelsea", price: 5.9 }, { name: "Draw", price: 4.4 }])] }),
    event({ bookmakers: [bookmaker("pinnacle", [{ name: "Chelsea", price: 1.62 }, { name: "Fulham", price: 5.9 }, { name: "Unknown", price: 4.4 }])] }),
    ...["1.62", null, 1, 0, -2, Infinity, NaN].map((price) => event({ bookmakers: [bookmaker("pinnacle", [
      { name: "Chelsea", price }, { name: "Fulham", price: 5.9 }, { name: "Draw", price: 4.4 },
    ])] })),
  ];
  // Preserve NaN/Infinity, which ordinary JSON serialisation would turn into null.
  const fetch = fakeFetch(() => ({ ok: true, json: async () => rows }) as Response);
  const collector = new PinnacleCollector({ apiKey, sports: ["soccer_epl"], fetch });
  assert.deepEqual(await collector.collect(context()), []);
  assert.deepEqual(collector.getWarnings(), [
    { source: "pinnacle", message: "soccer_epl : 15 rencontre(s) sans marché 1X2 complet chez Pinnacle." },
  ]);
});

test("Pinnacle accepts only future events in the requested football league with valid metadata", async () => {
  const rows = [
    event({ commence_time: now.toISOString() }), event({ commence_time: "2026-10-16T18:00:00Z" }),
    event({ sport_key: "basketball_nba" }), event({ sport_key: "soccer_france_ligue_one" }),
    event({ commence_time: "2026-10-18T18:00:00" }), event({ commence_time: "2026-02-30T18:00:00Z" }),
    event({ id: 123 }), event({ home_team: " " }), event({ away_team: "Chelsea" }), null,
    event({ id: "valid", sport_title: " " }),
  ];
  const collector = new PinnacleCollector({ apiKey, sports: ["soccer_epl"], fetch: returning(rows) });
  const matches = await collector.collect(context()) as RawMatch[];
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.sourceMatchId, "valid");
  assert.equal(matches[0]!.competition, "soccer_epl");
  assert.ok(collector.getWarnings().every((warning) => warning.source === "pinnacle"));
  assert.match(collector.getWarnings()[0]!.message, /7 événement\(s\) malformé/);
  assert.ok(collector.getWarnings().some((warning) => /1 rencontre\(s\) sans marché/.test(warning.message)));
});

test("Pinnacle preserves successful leagues when another league fails and reports its own diagnostics", async () => {
  const started: string[] = [];
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const collector = new PinnacleCollector({
    apiKey, sports: ["soccer_epl", "soccer_france_ligue_one"], fetch: fakeFetch(async (url) => {
      const sport = url.pathname.split("/").at(-2)!;
      started.push(sport);
      if (started.length === 2) release();
      await ready;
      return sport === "soccer_epl" ? Response.json([event()]) : new Response(apiKey, { status: 429 });
    }),
  });
  assert.equal((await collector.collect(context())).length, 1);
  assert.deepEqual(started, ["soccer_epl", "soccer_france_ligue_one"]);
  assert.deepEqual(collector.getWarnings(), [{
    source: "pinnacle", message: "soccer_france_ligue_one : Quota ou fréquence de requêtes The Odds API dépassé (HTTP 429).",
  }]);
  const warnings = collector.getWarnings();
  warnings[0]!.source = "mutated";
  assert.equal(collector.getWarnings()[0]!.source, "pinnacle");
});

test("Pinnacle failures are actionable without exposing credentials, response bodies or transport details", async () => {
  const cases: Array<[typeof globalThis.fetch, RegExp]> = [
    [fakeFetch(() => new Response(apiKey, { status: 401 })), /clé/i],
    [fakeFetch(() => new Response(apiKey, { status: 403 })), /abonnement/i],
    [fakeFetch(() => new Response(apiKey, { status: 429 })), /quota/i],
    [fakeFetch(() => new Response(apiKey, { status: 503 })), /indisponible/i],
    [fakeFetch(() => { throw new Error(`https://private.example/?apiKey=${apiKey}`); }), /connexion/i],
    [fakeFetch(() => new Response(`invalid JSON ${apiKey}`)), /JSON/i],
    [returning({ error: apiKey }), /tableau/i],
  ];
  for (const [fetch, pattern] of cases) {
    const collector = new PinnacleCollector({ apiKey, sports: ["soccer_epl"], fetch });
    await assert.rejects(collector.collect(context()), (error: Error) => {
      assert.match(error.message, /Collecte pinnacle impossible/);
      assert.match(error.message, pattern);
      assert.equal(inspect(error).includes(apiKey), false);
      assert.equal(error.message.includes("https://"), false);
      return true;
    });
    assert.equal(JSON.stringify(collector.getWarnings()).includes(apiKey), false);
    assert.ok(collector.getWarnings().every((warning) => warning.source === "pinnacle"));
  }
});

test("Pinnacle warnings reset between cycles and empty responses remain successful", async () => {
  let broken = true;
  const collector = new PinnacleCollector({ apiKey, sports: ["soccer_epl"], fetch: fakeFetch(() =>
    broken ? new Response(apiKey, { status: 503 }) : Response.json([])) });
  await assert.rejects(collector.collect(context()), /pinnacle impossible/);
  broken = false;
  assert.deepEqual(await collector.collect(context()), []);
  assert.deepEqual(collector.getWarnings(), []);
});

test("Pinnacle cancellation never fetches when already aborted and never exposes the abort reason", async () => {
  const controller = new AbortController();
  controller.abort(new Error(apiKey));
  let calls = 0;
  const collector = new PinnacleCollector({ apiKey, sports: ["soccer_epl"], fetch: fakeFetch(() => {
    calls++;
    return Response.json([]);
  }) });
  await assert.rejects(collector.collect({ now, signal: controller.signal }), (error: Error) => {
    assert.equal(error.name, "AbortError");
    assert.match(error.message, /pinnacle/);
    assert.equal(inspect(error).includes(apiKey), false);
    return true;
  });
  assert.equal(calls, 0);
});

test("Pinnacle promptly aborts an unresponsive injected fetch", { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let receivedSignal: AbortSignal | null | undefined;
  const collector = new PinnacleCollector({ apiKey, sports: ["soccer_epl"], fetch: fakeFetch((_url, init) => {
    receivedSignal = init?.signal;
    started();
    return new Promise<Response>(() => {});
  }) });
  const pending = collector.collect({ now, signal: controller.signal });
  await ready;
  controller.abort(new Error(apiKey));
  await assert.rejects(pending, (error: Error) => error.name === "AbortError" && !inspect(error).includes(apiKey));
  assert.equal(receivedSignal, controller.signal);
});

test("Pinnacle rejects missing keys and invalid football league keys without echoing supplied values", () => {
  assert.throws(() => new PinnacleCollector({ apiKey: " ", sports: ["soccer_epl"] }), /source pinnacle/);
  for (const sports of [[], ["basketball_nba"], ["upcoming"], ["soccer_epl?apiKey=unsafe"], ["soccer_"]]) {
    assert.throws(() => new PinnacleCollector({ apiKey, sports }), (error: Error) => {
      assert.match(error.message, /pinnacle.*soccer_/);
      assert.equal(error.message.includes("unsafe"), false);
      return true;
    });
  }
});
