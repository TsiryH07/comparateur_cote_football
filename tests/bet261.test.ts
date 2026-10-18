import assert from "node:assert/strict";
import test from "node:test";
import { Bet261Collector } from "../src/collectors/bet261.js";
import { OneXBetCollector } from "../src/collectors/oneXBet.js";
import { PinnacleCollector } from "../src/collectors/pinnacle.js";
import { collectCycle } from "../src/services/collectCycle.js";
import type { CollectionContext, RawMatch } from "../src/types.js";

const SITE = "https://www.bet261.mg";
const BASE = "https://hg-event-api-prod.sporty-tech.net/api/";
const now = new Date("2026-10-17T10:00:00Z");
// Prépare les éléments nécessaires au test.
const context = (): CollectionContext => ({ now: new Date(now), signal: new AbortController().signal });
const settings = { apiEventsBaseUrl: BASE };

// Prépare les éléments nécessaires au test.
function country(id = 24883, countryName = "Angleterre", leagueId = 24884, leagueName = "Premier League") {
  return { id, parentEventCategoryId: 101, name: countryName, subCategories: [
    { id: leagueId, parentEventCategoryId: id, name: leagueName, subCategories: [] },
  ] };
}

// Prépare les éléments nécessaires au test.
function items(): Record<string, unknown>[] {
  return [
    { betTypeItemId: 1003, shortName: "2", odds: 2.28, active: true, bettingAllowed: true },
    { betTypeItemId: 1001, shortName: "1", odds: 2.72, active: true, bettingAllowed: true },
    { betTypeItemId: 1002, shortName: "X", odds: 3.41, active: true, bettingAllowed: true },
  ];
}

// Prépare les éléments nécessaires au test.
function market(overrides: Record<string, unknown> = {}) {
  return { betTypeId: 10001, active: true, bettingAllowed: true, isAsian: false, eventBetTypeItems: items(), ...overrides };
}

// Prépare un exemple de match pour les tests.
function event(id = 79312560, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, homeTeamName: "Everton FC", awayTeamName: "Chelsea FC", expectedStart: "2026-10-18T11:30:00Z",
    categoryId: 24884, entryPointId: 101, categories: ["Premier League", "Angleterre"],
    eventType: "Match", state: "Undisputed", stateDetails: "NotStarted", preEventOrLive: "PreEvent", isVirtual: false,
    eventBetTypes: [market()], ...overrides,
  };
}

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
// Simule la réponse d’un site.
function fakeFetch(handler: Handler): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(
    new URL(input instanceof Request ? input.url : input.toString()), init,
  )) as typeof globalThis.fetch;
}

// Prépare les éléments nécessaires au test.
function routes(events: Handler = () => Response.json([event()]), categories: unknown = [country()], config: unknown = settings): typeof globalThis.fetch {
  return fakeFetch((url, init) => {
    if (url.pathname === "/configurations/config.json") return Response.json(config);
    if (url.pathname === "/api/eventcategories/101") return Response.json(categories);
    if (url.pathname === "/api/events") return events(url, init);
    throw new Error("Unexpected URL in fake transport");
  });
}

test("scrapes public config and categories, then targeted EPL JSON with safe public headers", async () => {
  const options = context();
  const requests: URL[] = [];
  const fetch = fakeFetch((url, init) => {
    requests.push(url);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.signal, options.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("origin"), SITE);
    assert.equal(headers.get("referer"), `${SITE}/sports`);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);
    if (url.pathname === "/configurations/config.json") return Response.json(settings);
    if (url.pathname === "/api/eventcategories/101") {
      assert.equal(url.searchParams.get("lang"), "fr");
      return Response.json([country()]);
    }
    assert.equal(url.href.startsWith(BASE), true);
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      eventCategoryIds: "24884", offset: "0", length: "51", fetchEventBetTypesMode: "0", betTypeId: "10001", l: "fr",
    });
    return Response.json([event()]);
  });
  const collector = new Bet261Collector({ sports: ["soccer_epl"], fetch });
  assert.equal(collector.name, "bet261");
  assert.deepEqual(await collector.collect(options), [{
    sourceMatchId: "79312560", homeTeam: "Everton FC", awayTeam: "Chelsea FC", competition: "EPL",
    startsAt: "2026-10-18T11:30:00.000Z", odds: { "1": 2.72, X: 3.41, "2": 2.28 },
  }]);
  assert.equal(requests.length, 3);
  assert.deepEqual(collector.getWarnings(), []);
});

test("discovers five main leagues by exact country and league aliases with canonical competitions", async () => {
  const definitions = [
    ["soccer_epl", "England", "English Premier League", "EPL"],
    ["soccer_france_ligue_one", "FRANCE", "Ligue 1", "Ligue 1 - France"],
    ["soccer_germany_bundesliga", "Germany", "1. Bundesliga", "Bundesliga - Germany"],
    ["soccer_italy_serie_a", "Italy", "SERIE A", "Serie A - Italy"],
    ["soccer_spain_la_liga", "Spain", "La Liga", "La Liga - Spain"],
  ];
  const categories = definitions.map((definition, index) => country(index + 100, definition[1], index + 1000, definition[2]));
  const collector = new Bet261Collector({
    sports: definitions.map((definition) => definition[0]!),
    fetch: routes((url) => {
      const categoryId = Number(url.searchParams.get("eventCategoryIds"));
      return Response.json([event(categoryId, { categoryId })]);
    }, categories),
  });
  const rows = await collector.collect(context()) as RawMatch[];
  assert.deepEqual(rows.map((match) => match.competition), definitions.map((definition) => definition[3]));
  assert.deepEqual(collector.getWarnings(), []);
});

test("exact discovery avoids similarly named women, youth and second-division categories", async () => {
  for (const leagueName of ["Premier League Women", "Premier League U21", "Premier League 2"]) {
    const collector = new Bet261Collector({ sports: ["soccer_epl"], fetch: routes(undefined, [country(24883, "Angleterre", 24884, leagueName)]) });
    await assert.rejects(collector.collect(context()), /introuvable/);
  }
  const ambiguous = new Bet261Collector({ sports: ["soccer_epl"], fetch: routes(undefined, [country(), country(123, "England", 456, "Premier League")]) });
  await assert.rejects(ambiguous.collect(context()), /Plusieurs catégories/);
});

test("unknown sports are diagnosed while supported leagues continue, and none supported fails before fetching", async () => {
  const mixed = new Bet261Collector({ sports: ["soccer_unknown", "soccer_epl", "soccer_epl"], fetch: routes() });
  assert.equal((await mixed.collect(context())).length, 1);
  assert.match(mixed.getWarnings()[0]!.message, /soccer_unknown.*non prise en charge/);
  let calls = 0;
  const none = new Bet261Collector({ sports: ["soccer_unknown"], fetch: fakeFetch(() => { calls++; return Response.json([]); }) });
  await assert.rejects(none.collect(context()), /Aucune ligue/);
  assert.equal(calls, 0);
});

test("only future real football pre-events in the selected category are retained", async () => {
  const invalid = [
    { entryPointId: 102 }, { isVirtual: true }, { eventType: "VirtualRace" }, { preEventOrLive: "Live" },
    { state: "Cancelled" }, { stateDetails: "Started" }, { categoryId: 42 },
    { expectedStart: now.toISOString() }, { expectedStart: "2026-10-16T11:00:00Z" },
    { expectedStart: "2026-10-18T11:00:00" }, { expectedStart: "2026-02-30T11:00:00Z" },
    { homeTeamName: "" }, { awayTeamName: "Everton FC" }, { id: "123" }, { id: Number.MAX_SAFE_INTEGER + 1 },
  ];
  const rows = invalid.map((overrides, index) => event(index + 1, overrides));
  rows.push(event(999));
  const collector = new Bet261Collector({ sports: ["soccer_epl"], fetch: routes(() => Response.json(rows)) });
  assert.deepEqual((await collector.collect(context()) as RawMatch[]).map((match) => match.sourceMatchId), ["999"]);
});

test("market selection rejects live/half-time markets, suspensions, wrong labels and invalid numeric prices", async () => {
  const markets = [
    market({ betTypeId: 20001 }), market({ betTypeId: 10007 }), market({ active: false }), market({ bettingAllowed: false }),
    market({ eventBetTypeItems: items().slice(0, 2) }), market({ eventBetTypeItems: [items()[0], items()[0], items()[1]] }),
    market({ isAsian: true }),
  ];
  for (const overrides of [{ active: false }, { bettingAllowed: false }, { shortName: "1" }, { odds: "2.28" }, { odds: 1 }, { odds: NaN }, { odds: Infinity }]) {
    const values = items();
    values[0] = { ...values[0], ...overrides };
    markets.push(market({ eventBetTypeItems: values }));
  }
  const rows = markets.map((value, index) => event(index + 1, { eventBetTypes: [value] }));
  rows.push(event(999, { eventBetTypes: [market(), market()] }));
  const collector = new Bet261Collector({ sports: ["soccer_epl"], fetch: routes(() => Response.json(rows)) });
  assert.deepEqual(await collector.collect(context()), []);
  assert.ok(collector.getWarnings().some((warning) => /suspendu/.test(warning.message)));
});

test("lookahead pagination neither skips nor duplicates the first row of the following page", async () => {
  const offsets: string[] = [];
  const collector = new Bet261Collector({ sports: ["soccer_epl"], pageSize: 2, maxPages: 5, fetch: routes((url) => {
    const offset = url.searchParams.get("offset")!;
    offsets.push(offset);
    assert.equal(url.searchParams.get("length"), "3");
    return Response.json(offset === "0" ? [event(1), event(2), event(3)] : [event(3), event(4)]);
  }) });
  assert.deepEqual((await collector.collect(context()) as RawMatch[]).map((match) => match.sourceMatchId), ["1", "2", "3", "4"]);
  assert.deepEqual(offsets, ["0", "2"]);
  assert.deepEqual(collector.getWarnings(), []);
});

test("the page bound is reported and repeated pages cannot cause an endless scan", async () => {
  const bounded = new Bet261Collector({ sports: ["soccer_epl"], pageSize: 2, maxPages: 1,
    fetch: routes(() => Response.json([event(1), event(2), event(3)])) });
  assert.equal((await bounded.collect(context())).length, 2);
  assert.ok(bounded.getWarnings().some((warning) => /tronqués/.test(warning.message)));
  let pages = 0;
  const repeated = new Bet261Collector({ sports: ["soccer_epl"], pageSize: 2, maxPages: 5, fetch: routes(() => {
    pages++; return Response.json([event(1), event(2), event(3)]);
  }) });
  assert.equal((await repeated.collect(context())).length, 2);
  assert.equal(pages, 2);
  assert.ok(repeated.getWarnings().some((warning) => /page répétée/.test(warning.message)));
  assert.ok(repeated.getWarnings().some((warning) => /en double/.test(warning.message)));
});

test("one failed league does not discard another league's observations", async () => {
  const collector = new Bet261Collector({ sports: ["soccer_epl", "soccer_france_ligue_one"],
    fetch: routes((url) => url.searchParams.get("eventCategoryIds") === "24884" ? Response.json([event()]) :
      new Response("ignored upstream details", { status: 503 }), [country(), country(24953, "France", 25427, "Ligue 1")]),
  });
  assert.equal((await collector.collect(context())).length, 1);
  assert.deepEqual(collector.getWarnings(), [{ source: "bet261", message: "soccer_france_ligue_one : Le service public Bet261 est temporairement indisponible." }]);
});

test("a later page failure preserves the earlier page with an explicit partial-collection warning", async () => {
  const collector = new Bet261Collector({ sports: ["soccer_epl"], pageSize: 2, fetch: routes((url) =>
    url.searchParams.get("offset") === "0" ? Response.json([event(1), event(2), event(3)]) : new Response("ignored", { status: 429 })),
  });
  assert.equal((await collector.collect(context())).length, 2);
  assert.match(collector.getWarnings()[0]!.message, /partielle.*page 2.*429/);
});

test("untrusted API configurations never trigger a request to a third-party or insecure host", async () => {
  for (const base of ["http://hg-event-api-prod.sporty-tech.net/api/", "https://evil.example/api/",
    "https://hg-event-api-prod.sporty-tech.net.evil.example/api/", "https://user:password@hg-event-api-prod.sporty-tech.net/api/",
    "https://hg-event-api-prod.sporty-tech.net/api/?apiKey=unexpected", "not a URL"]) {
    let calls = 0;
    const collector = new Bet261Collector({ sports: ["soccer_epl"], fetch: fakeFetch(() => {
      calls++; return Response.json({ apiEventsBaseUrl: base });
    }) });
    await assert.rejects(collector.collect(context()), /invalide|non autorisé/);
    assert.equal(calls, 1);
  }
});

test("malformed config, category and event payloads fail explicitly instead of reporting empty odds", async () => {
  for (const fetch of [
    routes(undefined, [country()], {}), routes(undefined, { categories: [country()] }),
    routes(() => Response.json({ events: [event()] })), routes(undefined, []),
  ]) {
    const collector = new Bet261Collector({ sports: ["soccer_epl"], fetch });
    await assert.rejects(collector.collect(context()), /configuration|tableau|introuvable/);
  }
});

test("HTML protection, HTTP failures and network details are safely reported and error bodies are cancelled", async () => {
  for (const [status, type, expected] of [[200, "text/html", /HTML.*restriction géographique/], [403, "text/html", /refusé.*403/],
    [401, "application/json", /refusé.*401/], [429, "application/json", /fréquence|Fréquence/], [503, "application/json", /indisponible/]] as const) {
    let cancelled = 0;
    const collector = new Bet261Collector({ sports: ["soccer_epl"], fetch: fakeFetch(() =>
      new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { status, headers: { "content-type": type } })) });
    await assert.rejects(collector.collect(context()), expected);
    assert.equal(cancelled, status === 503 ? 2 : 1);
  }
  const privateDetails = "raw upstream body or network details";
  for (const fetch of [fakeFetch(() => { throw new Error(privateDetails); }), fakeFetch(() => new Response(privateDetails))]) {
    const collector = new Bet261Collector({ sports: ["soccer_epl"], fetch });
    await assert.rejects(collector.collect(context()), (error: Error) => !error.message.includes(privateDetails));
  }
});

test("already cancelled collection makes no requests and pending fetch is promptly cancelled", { timeout: 1000 }, async () => {
  const aborted = new AbortController();
  aborted.abort(new Error("private cancellation detail"));
  let calls = 0;
  const early = new Bet261Collector({ sports: ["soccer_epl"], fetch: fakeFetch(() => { calls++; return Response.json({}); }) });
  await assert.rejects(early.collect({ now, signal: aborted.signal }), (error: Error) => error.name === "AbortError" && !error.message.includes("private"));
  assert.equal(calls, 0);
  const controller = new AbortController();
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const collector = new Bet261Collector({ sports: ["soccer_epl"], fetch: fakeFetch((_url, init) => {
    assert.equal(init?.signal, controller.signal);
    started(); return new Promise<Response>(() => {});
  }) });
  const pending = collector.collect({ now, signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
});

test("warnings are defensive snapshots, reset each collection, and pagination settings are validated", async () => {
  let suspended = true;
  const collector = new Bet261Collector({ sports: ["soccer_epl"], fetch: routes(() => Response.json([
    suspended ? event(1, { eventBetTypes: [market({ active: false })] }) : event(),
  ])) });
  assert.deepEqual(await collector.collect(context()), []);
  const warnings = collector.getWarnings();
  warnings[0]!.message = "external change";
  assert.match(collector.getWarnings()[0]!.message, /suspendu/);
  suspended = false;
  assert.equal((await collector.collect(context())).length, 1);
  assert.deepEqual(collector.getWarnings(), []);
  for (const value of [0, -1, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new Bet261Collector({ sports: ["soccer_epl"], pageSize: value }), /pagination/);
    assert.throws(() => new Bet261Collector({ sports: ["soccer_epl"], maxPages: value }), /pagination/);
  }
  assert.throws(() => new Bet261Collector({ sports: ["soccer_epl"], pageSize: Number.MAX_SAFE_INTEGER }), /pagination/);
});

test("a complete cycle with valid empty or legitimately filtered provider data is saved without false source failures", async () => {
  for (const variant of ["empty", "filtered"] as const) {
    let calls = 0;
    let saves = 0;
    const oddsFetch = fakeFetch(() => {
      calls++;
      return Response.json(variant === "empty" ? [] : [{
        id: "past", sport_key: "soccer_epl", sport_title: "EPL", commence_time: "2026-10-16T18:00:00Z",
        home_team: "Chelsea", away_team: "Fulham", bookmakers: ["onexbet", "pinnacle"].map((key) => ({
          key, markets: [{ key: "h2h", outcomes: [
            { name: "Chelsea", price: 1.8 }, { name: "Draw", price: 3.5 }, { name: "Fulham", price: 4.5 },
          ] }],
        })),
      }]);
    });
    const betFetch = routes(() => Response.json(variant === "empty" ? [] : [
      event(1, { expectedStart: "2026-10-16T18:00:00Z" }),
      event(2, { preEventOrLive: "Live", stateDetails: "Started" }),
      event(3, { state: "Cancelled" }),
    ]));
    const collectors = [
      new OneXBetCollector({ apiKey: "fake-test-key", sports: ["soccer_epl"], fetch: oddsFetch }),
      new PinnacleCollector({ apiKey: "fake-test-key", sports: ["soccer_epl"], fetch: oddsFetch }),
      new Bet261Collector({ sports: ["soccer_epl"], fetch: fakeFetch((url, init) => { calls++; return betFetch(url, init); }) }),
    ];
    const result = await collectCycle({
      collectors, database: { saveCycle(cycle) { saves++; assert.deepEqual(cycle.errors, []); return saves; } },
      threshold: { mode: "percentage", value: 10 }, clock: () => new Date(now),
    });
    assert.equal(result.collectedCount, 0);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.alerts, []);
    assert.deepEqual(result.errors, []);
    assert.ok(collectors.every((collector) => collector.getWarnings().length === 0));
    assert.equal(saves, 1);
    assert.equal(calls, 5);
  }
});

test("Bet261 validates its constructor and context, and never retries invalid JSON", async () => {
  for (const sports of [[], [" "], ["soccer__epl"], ["https://private.example/?apiKey=unsafe"]]) {
    assert.throws(() => new Bet261Collector({ sports }), (error: Error) => /ligues/.test(error.message) && !error.message.includes("unsafe"));
  }
  assert.throws(() => new Bet261Collector({ sports: ["soccer_epl"], fetch: 0 as unknown as typeof globalThis.fetch }), /transport HTTP/);
  let calls = 0;
  const collector = new Bet261Collector({ sports: ["soccer_epl"], fetch: fakeFetch(() => {
    calls++; return new Response("{ invalid private JSON");
  }) });
  await assert.rejects(collector.collect({ ...context(), now: new Date(NaN) }), /date/);
  assert.equal(calls, 0);
  await assert.rejects(collector.collect(context()), /JSON.*illisible/);
  assert.equal(calls, 1);
});
