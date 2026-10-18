import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { OneXBetCollector } from "../src/collectors/oneXBet.js";
import type { CollectionContext, RawMatch } from "../src/types.js";

const apiKey = "fake-test-key-never-real";
const now = new Date("2026-10-17T10:00:00.321Z");
// Prépare les éléments nécessaires au test.
const context = (): CollectionContext => ({ now: new Date(now), signal: new AbortController().signal });

// Prépare un exemple de match pour les tests.
function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "event-1", sport_key: "soccer_epl", sport_title: "EPL", commence_time: "2026-10-18T18:00:00Z",
    home_team: "Chelsea", away_team: "Fulham", bookmakers: [{
      key: "onexbet", markets: [{ key: "h2h", outcomes: [
        { name: "Fulham", price: 6.23 }, { name: "Draw", price: 4.62 }, { name: "Chelsea", price: 1.54 },
      ] }],
    }], ...overrides,
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

// Prépare les éléments nécessaires au test.
function market(outcomes: unknown[], key = "h2h"): unknown[] {
  return [{ key: "onexbet", markets: [{ key, outcomes }] }];
}

test("requests only onexbet soccer h2h with safe fetch options and name-based outcome mapping", async () => {
  const options = context();
  let calls = 0;
  const collector = new OneXBetCollector({ apiKey, sports: ["soccer_epl"], fetch: fakeFetch((url, init) => {
    calls++;
    assert.equal(url.origin, "https://api.the-odds-api.com");
    assert.equal(url.pathname, "/v4/sports/soccer_epl/odds");
    assert.equal(url.searchParams.get("apiKey"), apiKey);
    assert.equal(url.searchParams.get("bookmakers"), "onexbet");
    assert.equal(url.searchParams.get("markets"), "h2h");
    assert.equal(url.searchParams.get("oddsFormat"), "decimal");
    assert.equal(url.searchParams.get("dateFormat"), "iso");
    assert.equal(url.searchParams.get("commenceTimeFrom"), "2026-10-17T10:00:00Z");
    assert.equal(url.searchParams.has("regions"), false);
    assert.equal(init?.signal, options.signal);
    assert.equal(init?.redirect, "error");
    return Response.json([event()]);
  }) });
  assert.equal(collector.name, "1xbet");
  assert.deepEqual(await collector.collect(options), [{
    sourceMatchId: "event-1", homeTeam: "Chelsea", awayTeam: "Fulham", competition: "EPL",
    startsAt: "2026-10-18T18:00:00.000Z", odds: { "1": 1.54, X: 4.62, "2": 6.23 },
  }]);
  assert.equal(calls, 1);
  assert.deepEqual(collector.getWarnings(), []);
  assert.equal(inspect(collector).includes(apiKey), false);
});

test("Draw can occupy any position and home-away prices always follow event labels", async () => {
  const outcomes = [
    { name: "Chelsea", price: 1.54 }, { name: "Fulham", price: 6.23 }, { name: "Draw", price: 4.62 },
  ];
  for (const order of [[2, 1, 0], [1, 2, 0], [0, 1, 2]]) {
    const collector = new OneXBetCollector({ apiKey, sports: ["soccer_epl"], fetch: returning([
      event({ bookmakers: market(order.map((index) => outcomes[index])) }),
    ]) });
    const matches = await collector.collect(context()) as RawMatch[];
    assert.deepEqual(matches[0]!.odds, { "1": 1.54, X: 4.62, "2": 6.23 });
  }
});

test("does not substitute another bookmaker or accept incomplete, duplicated or different markets", async () => {
  const valid = [{ name: "Chelsea", price: 1.54 }, { name: "Fulham", price: 6.23 }, { name: "Draw", price: 4.62 }];
  const rows = [
    event({ bookmakers: [{ key: "otherbook", markets: [{ key: "h2h", outcomes: valid }] }] }),
    event({ bookmakers: market(valid.slice(0, 2)) }),
    event({ bookmakers: market(valid, "h2h_lay") }),
    event({ bookmakers: market(valid, "h2h_3_way") }),
    event({ bookmakers: market([valid[0], valid[0], valid[2]]) }),
    event({ bookmakers: market([...valid, { name: "Other", price: 8 }]) }),
    event({ bookmakers: market([valid[0], valid[1], { name: "Other", price: 4 }]) }),
    event({ bookmakers: [...market(valid), ...market(valid)] }),
  ];
  const collector = new OneXBetCollector({ apiKey, sports: ["soccer_epl"], fetch: returning(rows) });
  assert.deepEqual(await collector.collect(context()), []);
  assert.ok(collector.getWarnings().some((warning) => /8 rencontre/.test(warning.message)));
});

test("ignores live/past events, other sports, other leagues and malformed metadata", async () => {
  const rows = [
    event({ commence_time: "2026-10-17T10:00:00Z" }),
    event({ commence_time: now.toISOString() }), event({ commence_time: "2026-10-16T18:00:00Z" }),
    event({ sport_key: "americanfootball_nfl" }), event({ sport_key: "soccer_france_ligue_one" }),
    event({ commence_time: "2026-10-18T18:00:00" }), event({ commence_time: "2026-02-30T18:00:00Z" }),
    event({ id: 123 }), event({ home_team: null }), event({ away_team: "Chelsea" }), null,
  ];
  const collector = new OneXBetCollector({ apiKey, sports: ["soccer_epl"], fetch: returning(rows) });
  assert.deepEqual(await collector.collect(context()), []);
  assert.ok(collector.getWarnings().some((warning) => /malformé/.test(warning.message)));
});

test("prices remain strict numeric decimals greater than 1", async () => {
  const prices = ["1.54", null, 1, 0, -2, Infinity, NaN];
  const rows = prices.map((price) => event({ bookmakers: market([
    { name: "Chelsea", price }, { name: "Fulham", price: 6.23 }, { name: "Draw", price: 4.62 },
  ]) }));
  // A fake JSON method preserves NaN/Infinity here; JSON itself cannot encode them.
  const fetch = fakeFetch(() => ({ ok: true, json: async () => rows }) as Response);
  const collector = new OneXBetCollector({ apiKey, sports: ["soccer_epl"], fetch });
  assert.deepEqual(await collector.collect(context()), []);
});

test("competition falls back to the configured league and valid empty arrays succeed without warnings", async () => {
  const fallback = new OneXBetCollector({ apiKey, sports: ["soccer_epl"], fetch: returning([event({ sport_title: " " })]) });
  assert.equal(((await fallback.collect(context()))[0] as RawMatch).competition, "soccer_epl");
  const empty = new OneXBetCollector({ apiKey, sports: ["soccer_epl"], fetch: returning([]) });
  assert.deepEqual(await empty.collect(context()), []);
  assert.deepEqual(empty.getWarnings(), []);
  const incomplete = new OneXBetCollector({ apiKey, sports: ["soccer_epl"], fetch: returning([event({ bookmakers: [] })]) });
  assert.deepEqual(await incomplete.collect(context()), []);
  const warnings = incomplete.getWarnings();
  warnings[0]!.message = "modified outside collector";
  assert.match(incomplete.getWarnings()[0]!.message, /sans marché 1X2 complet/);
});

test("HTTP errors are actionable and neither upstream bodies nor the API key appear in exceptions", async () => {
  for (const [status, pattern] of [[401, /clé/i], [403, /abonnement/i], [429, /quota|fréquence/i], [503, /indisponible/i], [404, /refusé/i]] as const) {
    const collector = new OneXBetCollector({ apiKey, sports: ["soccer_epl"], fetch: fakeFetch(() =>
      new Response(`${apiKey} https://private.example/?apiKey=${apiKey}`, { status })) });
    await assert.rejects(collector.collect(context()), (error: Error) => {
      assert.match(error.message, pattern);
      assert.equal(inspect(error).includes(apiKey), false);
      assert.equal(error.message.includes("private.example"), false);
      return true;
    });
    assert.equal(JSON.stringify(collector.getWarnings()).includes(apiKey), false);
  }
});

test("network and malformed JSON failures do not expose raw exception details", async () => {
  for (const fetch of [
    fakeFetch(() => { throw new Error(`private https://api.the-odds-api.com/?apiKey=${apiKey}`); }),
    fakeFetch(() => new Response(`invalid JSON ${apiKey}`)),
    returning({ error: apiKey }),
  ]) {
    const collector = new OneXBetCollector({ apiKey, sports: ["soccer_epl"], fetch });
    await assert.rejects(collector.collect(context()), (error: Error) => {
      assert.equal(inspect(error).includes(apiKey), false);
      assert.equal(error.message.includes("https://"), false);
      return true;
    });
  }
});

test("HTTP error response bodies are cancelled and cleanup failures preserve the safe error", async () => {
  for (const fails of [false, true]) {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancellations++;
        if (fails) throw new Error(`unsafe cleanup details ${apiKey}`);
      },
    });
    const collector = new OneXBetCollector({
      apiKey, sports: ["soccer_epl"], fetch: fakeFetch(() => new Response(body, { status: 429 })),
    });
    await assert.rejects(collector.collect(context()), (error: Error) => {
      assert.match(error.message, /HTTP 429/);
      assert.equal(inspect(error).includes(apiKey), false);
      return true;
    });
    assert.equal(cancellations, 1);
  }
});

test("league requests run concurrently and partial successes preserve usable prices", async () => {
  const started: string[] = [];
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const collector = new OneXBetCollector({
    apiKey, sports: ["soccer_epl", "soccer_france_ligue_one", "soccer_epl"],
    fetch: fakeFetch(async (url) => {
      const sport = url.pathname.split("/").at(-2)!;
      started.push(sport);
      if (started.length === 2) release();
      await ready;
      return sport === "soccer_epl" ? Response.json([event()]) : new Response("ignored", { status: 429 });
    }),
  });
  assert.equal((await collector.collect(context())).length, 1);
  assert.deepEqual(started, ["soccer_epl", "soccer_france_ligue_one"]);
  assert.deepEqual(collector.getWarnings(), [{
    source: "1xbet", message: "soccer_france_ligue_one : Quota ou fréquence de requêtes The Odds API dépassé (HTTP 429).",
  }]);
});

test("all failed leagues produce one safe aggregate failure and warnings reset for each collection", async () => {
  let broken = true;
  const collector = new OneXBetCollector({
    apiKey, sports: ["soccer_epl", "soccer_france_ligue_one"],
    fetch: fakeFetch((url) => broken ? new Response("ignored", { status: 503 }) : Response.json([
      event({ sport_key: url.pathname.split("/").at(-2)! }),
    ])),
  });
  await assert.rejects(collector.collect(context()), /soccer_epl.*soccer_france_ligue_one/);
  assert.equal(collector.getWarnings().length, 2);
  broken = false;
  assert.equal((await collector.collect(context())).length, 2);
  assert.deepEqual(collector.getWarnings(), []);
});

test("already aborted collection never fetches and does not expose an unsafe abort reason", async () => {
  const controller = new AbortController();
  controller.abort(new Error(apiKey));
  let called = false;
  const collector = new OneXBetCollector({ apiKey, sports: ["soccer_epl"], fetch: fakeFetch(() => {
    called = true; return Response.json([]);
  }) });
  await assert.rejects(collector.collect({ now, signal: controller.signal }), (error: Error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(inspect(error).includes(apiKey), false);
    return true;
  });
  assert.equal(called, false);
});

test("external abort promptly stops collection even if an injected fetch never settles", { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let receivedSignal: AbortSignal | null | undefined;
  const collector = new OneXBetCollector({ apiKey, sports: ["soccer_epl"], fetch: fakeFetch((_url, init) => {
    receivedSignal = init?.signal;
    started();
    return new Promise<Response>(() => {});
  }) });
  const pending = collector.collect({ now, signal: controller.signal });
  await ready;
  controller.abort(new Error(apiKey));
  await assert.rejects(pending, (error: Error) => error.name === "AbortError" && !inspect(error).includes(apiKey));
  assert.equal(receivedSignal, controller.signal);
  assert.equal(receivedSignal?.aborted, true);
});

test("constructor rejects missing keys and non-football sport keys without echoing values", () => {
  assert.throws(() => new OneXBetCollector({ apiKey: " ", sports: ["soccer_epl"] }), /clé/i);
  for (const sports of [[], ["basketball_nba"], ["upcoming"], ["soccer_epl?apiKey=unsafe"], ["soccer_"], ["soccer__epl"]]) {
    assert.throws(() => new OneXBetCollector({ apiKey, sports }), /soccer_/);
  }
});

test("invalid JSON or response shape is not retried and invalid contexts fail before requesting", async () => {
  for (const response of [() => new Response("{ invalid private JSON"), () => Response.json({ events: [] })]) {
    let calls = 0;
    const collector = new OneXBetCollector({ apiKey, sports: ["soccer_epl"], fetch: fakeFetch(() => {
      calls++; return response();
    }) });
    await assert.rejects(collector.collect(context()), /JSON|tableau/);
    assert.equal(calls, 1);
    await assert.rejects(collector.collect({ ...context(), now: new Date(NaN) }), /date/i);
    assert.equal(calls, 1);
  }
  assert.throws(() => new OneXBetCollector({ apiKey, sports: ["soccer_epl"], fetch: 0 as unknown as typeof globalThis.fetch }), /transport HTTP/);
});
