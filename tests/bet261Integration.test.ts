import assert from "node:assert/strict";
import test from "node:test";
import { Bet261Collector } from "../src/collectors/bet261.js";
import { OneXBetCollector } from "../src/collectors/oneXBet.js";
import { PinnacleCollector } from "../src/collectors/pinnacle.js";
import { OddsDatabase } from "../src/database/sqlite.js";
import { collectCycle } from "../src/services/collectCycle.js";

const now = new Date("2030-03-01T12:00:00Z");
const startsAt = "2030-03-01T18:00:00Z";

// Prépare les éléments nécessaires au test.
function oneXBet(): OneXBetCollector {
  return new OneXBetCollector({
    apiKey: "fake-key-no-network", sports: ["soccer_epl"],
    fetch: async () => Response.json([{
      id: "api-event", sport_key: "soccer_epl", sport_title: "EPL", commence_time: startsAt,
      home_team: "Chelsea", away_team: "Fulham",
      bookmakers: [{ key: "onexbet", markets: [{ key: "h2h", outcomes: [
        { name: "Chelsea", price: 1.8 }, { name: "Draw", price: 4.6 }, { name: "Fulham", price: 6.3 },
      ] }] }],
    }]),
  });
}

// Prépare les éléments nécessaires au test.
function pinnacle(bookmaker = "pinnacle"): PinnacleCollector {
  return new PinnacleCollector({
    apiKey: "fake-key-no-network", sports: ["soccer_epl"],
    fetch: async () => Response.json([{
      id: "api-event", sport_key: "soccer_epl", sport_title: "EPL", commence_time: startsAt,
      home_team: "Chelsea", away_team: "Fulham",
      bookmakers: [{ key: bookmaker, markets: [{ key: "h2h", outcomes: [
        { name: "Fulham", price: 6.3 }, { name: "Chelsea", price: 2.1 }, { name: "Draw", price: 4.6 },
      ] }] }],
    }]),
  });
}

// Simule la réponse d’un site.
function bet261Fetch(): typeof globalThis.fetch {
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/configurations/config.json") {
      return Response.json({ apiEventsBaseUrl: "https://hg-event-api-prod.sporty-tech.net/api/" });
    }
    if (url.pathname === "/api/eventcategories/101") {
      return Response.json([{
        id: 24883, name: "Angleterre", parentEventCategoryId: 101,
        subCategories: [{ id: 24884, name: "Premier League", parentEventCategoryId: 24883, subCategories: [] }],
      }]);
    }
    assert.equal(url.pathname, "/api/events");
    assert.equal(url.searchParams.get("eventCategoryIds"), "24884");
    return Response.json([{
      id: 991, homeTeamName: "Chelsea FC", awayTeamName: "Fulham FC", expectedStart: startsAt,
      entryPointId: 101, categoryId: 24884, categoryPath: "/101/24883/24884/",
      categories: ["Premier League", "Angleterre"], eventType: "Match", preEventOrLive: "PreEvent",
      state: "Undisputed", stateDetails: "NotStarted", isVirtual: false,
      eventBetTypes: [{ betTypeId: 10001, active: true, bettingAllowed: true, eventBetTypeItems: [
        { betTypeItemId: 1001, shortName: "1", odds: 1.54, active: true, bettingAllowed: true },
        { betTypeItemId: 1002, shortName: "X", odds: 4.62, active: true, bettingAllowed: true },
        { betTypeItemId: 1003, shortName: "2", odds: 6.23, active: true, bettingAllowed: true },
      ] }],
    }]);
  };
}

test("les trois vrais adaptateurs rapprochent un match et historisent les cotes Pinnacle", async () => {
  const database = new OddsDatabase(":memory:");
  try {
    const result = await collectCycle({
      collectors: [oneXBet(), new Bet261Collector({ sports: ["soccer_epl"], fetch: bet261Fetch() }), pinnacle()],
      database, threshold: { mode: "percentage", value: 10 }, clock: () => new Date(now),
    });
    assert.equal(result.collectedCount, 3);
    assert.equal(result.events.length, 1);
    assert.deepEqual(result.events[0]!.quotes.map((quote) => quote.source), ["1xbet", "bet261", "pinnacle"]);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.alerts.map((alert) => alert.outcome), ["1"]);
    assert.equal(result.alerts[0]!.minSource, "bet261");
    assert.equal(result.alerts[0]!.maxSource, "pinnacle");
    assert.equal(result.alerts[0]!.maxOdd, 2.1);
    assert.equal(database.getHistory().length, 3);
    assert.equal(database.getHistory().find((row) => row.source === "bet261")!.homeTeam, "Chelsea FC");
    assert.equal(database.getHistory().find((row) => row.source === "pinnacle")!.odds["1"], 2.1);
    assert.equal(database.getLatestCycle()!.events[0]!.quotes.length, 3);
    assert.deepEqual(database.getLatestCycle()!.alerts, result.alerts);
    assert.equal(database.getAlerts()[0]!.maxSource, "pinnacle");
  } finally {
    database.close();
  }
});

test("un refus public Bet261 conserve la comparaison entre 1xBet et Pinnacle", async () => {
  const database = new OddsDatabase(":memory:");
  try {
    const result = await collectCycle({
      collectors: [oneXBet(), new Bet261Collector({ sports: ["soccer_epl"], fetch: async () => new Response("Accès limité", { status: 403 }) }), pinnacle()],
      database, threshold: { mode: "percentage", value: 10 }, clock: () => new Date(now),
    });
    assert.equal(result.collectedCount, 2);
    assert.deepEqual(result.events.flatMap((event) => event.quotes.map((quote) => quote.source)), ["1xbet", "pinnacle"]);
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.minSource, "1xbet");
    assert.equal(result.alerts[0]!.maxSource, "pinnacle");
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.source, "bet261");
    assert.match(result.errors[0]!.message, /403|accès|accessible|refus/i);
    assert.deepEqual(database.getHistory().map((row) => row.source).sort(), ["1xbet", "pinnacle"]);
  } finally {
    database.close();
  }
});

test("une réponse sans Pinnacle ne remplace pas ses cotes par celles d'un autre bookmaker", async () => {
  const database = new OddsDatabase(":memory:");
  try {
    const result = await collectCycle({
      collectors: [oneXBet(), pinnacle("onexbet")],
      database, threshold: { mode: "percentage", value: 10 }, clock: () => new Date(now),
    });
    assert.equal(result.collectedCount, 1);
    assert.deepEqual(result.events[0]!.quotes.map((quote) => quote.source), ["1xbet"]);
    assert.deepEqual(result.alerts, []);
    assert.ok(result.errors.some((error) => error.source === "pinnacle"));
    assert.deepEqual(database.getHistory().map((row) => row.source), ["1xbet"]);
  } finally {
    database.close();
  }
});
