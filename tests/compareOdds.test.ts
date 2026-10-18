import test from "node:test";
import assert from "node:assert/strict";
import { compareOdds } from "../src/services/compareOdds.js";
import { matchMatches } from "../src/services/matchMatcher.js";
import { normalizeMatch } from "../src/services/normalize.js";
import type { MatchedEvent, Odds, Threshold } from "../src/types.js";

// Prépare un exemple de match pour les tests.
function event(entries: [string, Odds][]): MatchedEvent {
  return matchMatches(entries.map(([source, odds]) => normalizeMatch({
    sourceMatchId: source, homeTeam: "PSG", awayTeam: "Marseille", competition: "Ligue 1",
    startsAt: "2026-10-18T19:00:00Z", odds,
  }, source, new Date("2026-10-17T10:00:00Z"))))[0]!;
}

test("each outcome compares minimum and maximum across every available source", () => {
  const input = event([
    ["a", { "1": 2, X: 4, "2": 5 }], ["b", { "1": 2.5, X: 3, "2": 5 }],
    ["c", { "1": 2.3, X: 3.5, "2": 6 }],
  ]);
  const alerts = compareOdds([input], { mode: "absolute", value: 0.25 });
  assert.deepEqual(alerts.map((alert) => alert.outcome), ["1", "X", "2"]);
  assert.equal(alerts[0]!.minOdd, 2);
  assert.equal(alerts[0]!.maxOdd, 2.5);
  assert.equal(alerts[0]!.minSource, "a");
  assert.equal(alerts[0]!.maxSource, "b");
  assert.equal(alerts[0]!.absoluteDifference, 0.5);
  assert.equal(alerts[0]!.percentageDifference, 25);
  assert.equal(alerts[0]!.eventId, input.id);
  assert.equal(alerts[1]!.minSource, "b");
  assert.equal(alerts[1]!.maxSource, "a");
  assert.equal(alerts[2]!.maxSource, "c");
});

test("absolute and percentage thresholds are strictly greater, including exact decimal boundaries", () => {
  const exact = event([["a", { "1": 2, X: 3, "2": 4 }], ["b", { "1": 2.5, X: 3, "2": 4 }]]);
  assert.equal(compareOdds([exact], { mode: "absolute", value: 0.5 }).length, 0);
  assert.equal(compareOdds([exact], { mode: "percentage", value: 25 }).length, 0);
  assert.equal(compareOdds([exact], { mode: "percentage", value: 24.999999 }).length, 1);
  const decimal = event([["a", { "1": 2.3, X: 2, "2": 4 }], ["b", { "1": 2.6, X: 2.2, "2": 4 }]]);
  assert.equal(compareOdds([decimal], { mode: "absolute", value: 0.3 }).length, 0);
  assert.equal(compareOdds([decimal], { mode: "percentage", value: 10 }).some((alert) => alert.outcome === "X"), false);
});

test("decisions preserve differences that would disappear after display rounding", () => {
  const input = event([["a", { "1": 2, X: 3, "2": 4 }], ["b", { "1": 2.200001, X: 3, "2": 4 }]]);
  const alerts = compareOdds([input], { mode: "percentage", value: 10 });
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0]!.percentageDifference > 10);
  assert.equal(alerts[0]!.maxOdd, 2.200001);
  assert.equal(compareOdds([input], { mode: "absolute", value: 0.2000009 }).length, 1);
});

test("no comparison is produced for a singleton, identical odds or one source repeated", () => {
  assert.deepEqual(compareOdds([], { mode: "absolute", value: 0 }), []);
  const singleton = event([["a", { "1": 2, X: 3, "2": 4 }]]);
  assert.deepEqual(compareOdds([singleton], { mode: "absolute", value: 0 }), []);
  const equal = event([["a", { "1": 2, X: 3, "2": 4 }], ["b", { "1": 2, X: 3, "2": 4 }]]);
  assert.deepEqual(compareOdds([equal], { mode: "absolute", value: 0 }), []);
  singleton.quotes.push({ ...singleton.quotes[0]!, sourceMatchId: "duplicate", odds: { "1": 9, X: 9, "2": 9 } });
  assert.deepEqual(compareOdds([singleton], { mode: "absolute", value: 0 }), []);
});

test("ties choose a deterministic source and still produce only one alert per outcome", () => {
  const input = event([
    ["c", { "1": 2.5, X: 3, "2": 4 }], ["b", { "1": 2, X: 3, "2": 4 }],
    ["a", { "1": 2, X: 3, "2": 4 }],
  ]);
  const alerts = compareOdds([input], { mode: "absolute", value: 0 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.minSource, "a");
  assert.equal(alerts[0]!.maxSource, "c");
});

test("threshold configuration must be valid", () => {
  for (const threshold of [
    { mode: "other", value: 1 }, { mode: "absolute", value: -1 },
    { mode: "percentage", value: NaN }, { mode: "absolute", value: Infinity }, null,
  ]) assert.throws(() => compareOdds([], threshold as Threshold), /threshold/);
});
