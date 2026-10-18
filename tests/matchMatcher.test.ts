import test from "node:test";
import assert from "node:assert/strict";
import { matchMatches } from "../src/services/matchMatcher.js";
import { normalizeMatch } from "../src/services/normalize.js";
import type { NormalizedMatch, RawMatch } from "../src/types.js";

// Prépare un exemple de match pour les tests.
function match(source: string, minute = 0, overrides: Partial<RawMatch> = {}, collectedAt = "2026-10-17T10:00:00Z"): NormalizedMatch {
  return normalizeMatch({
    sourceMatchId: `${source}-${minute}`, homeTeam: "PSG", awayTeam: "Marseille",
    competition: "Ligue 1", startsAt: new Date(Date.parse("2026-10-18T19:00:00Z") + minute * 60_000).toISOString(),
    odds: { "1": 2, X: 3, "2": 4 }, ...overrides,
  }, source, new Date(collectedAt));
}

test("same oriented teams, competition and nearby kickoff merge across sources", () => {
  const a = match("a");
  const b = match("b", 10, { homeTeam: "Paris Saint-Germain", awayTeam: "Olympique de Marseille", competition: "LIGUE-1" });
  const unmatched = match("c", 0, { homeTeam: "Chelsea", awayTeam: "Man United" });
  const events = matchMatches([b, unmatched, a]);
  assert.equal(events.length, 2);
  const event = events.find((item) => item.quotes.length === 2)!;
  assert.deepEqual(event.quotes.map((quote) => quote.source), ["a", "b"]);
  assert.equal(event.startsAt, "2026-10-18T19:00:00.000Z");
  assert.equal(events.reduce((sum, item) => sum + item.quotes.length, 0), 3);
});

test("tolerance is inclusive, uses real instants, and never rounds kickoffs", () => {
  assert.equal(matchMatches([match("a"), match("b", 15)]).length, 1);
  assert.equal(matchMatches([match("a"), match("b", 15 + 1 / 60_000)]).length, 2);
  assert.equal(matchMatches([match("a"), match("b", 0, { startsAt: "2026-10-18T22:00:00+03:00" })], 0).length, 1);
  assert.equal(matchMatches([match("a"), match("b", 0.5)], 0).length, 2);
  for (const tolerance of [-1, NaN, Infinity]) {
    assert.throws(() => matchMatches([], tolerance), /tolerance/);
  }
});

test("reversed teams, different competitions and squad markers remain separate", () => {
  const base = match("a");
  for (const overrides of [
    { homeTeam: "Marseille", awayTeam: "PSG" }, { competition: "Coupe de France" },
    { homeTeam: "PSG Women" }, { homeTeam: "PSG U21" }, { homeTeam: "PSG II" },
    { awayTeam: "Marseille reserves" },
  ]) assert.equal(matchMatches([base, match("b", 0, overrides)]).length, 2);
});

test("an exact source/id duplicate keeps the newest quote independently of input order", () => {
  const old = match("a", 0, { sourceMatchId: "same", odds: { "1": 1.8, X: 3, "2": 4 } });
  const newer = match("a", 0, { sourceMatchId: "same", odds: { "1": 2.2, X: 3, "2": 4 } }, "2026-10-17T10:10:00Z");
  const b = match("b");
  const events = matchMatches([old, newer, b]);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.quotes.length, 2);
  assert.equal(events[0]!.quotes.find((quote) => quote.source === "a")!.odds["1"], 2.2);
  assert.deepEqual(events, matchMatches([b, newer, old]));
});

test("same-source distinct IDs never merge and exact-time collision IDs stay distinct", () => {
  const candidates = [match("a", 0, { sourceMatchId: "one" }), match("a", 0, { sourceMatchId: "two" })];
  const events = matchMatches(candidates);
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map((event) => event.id)).size, 2);
  assert.deepEqual(events, matchMatches([...candidates].reverse()));
});

test("an ambiguous choice between same-source listings preserves every unmatched quote", () => {
  const candidates = [match("a", 0), match("a", 10), match("b", 5)];
  const events = matchMatches(candidates);
  assert.equal(events.length, 3);
  assert.ok(events.every((event) => event.quotes.length === 1));
  assert.deepEqual(events, matchMatches([...candidates].reverse()));
});

test("three sources merge only when the full kickoff span is within tolerance", () => {
  assert.equal(matchMatches([match("a", 0), match("b", 10), match("c", 14)]).length, 1);
  const chained = matchMatches([match("a", 0), match("b", 10), match("c", 20)]);
  assert.equal(chained.length, 3);
  assert.ok(chained.every((event) => event.quotes.length === 1));
});

test("IDs are deterministic under input order, display labels, collection time and odds changes", () => {
  const first = [match("a"), match("b", 5)];
  const second = [match("b", 5), match("a", 0, {
    homeTeam: "Paris SG", odds: { "1": 2.5, X: 3.1, "2": 4.1 },
  }, "2026-10-17T10:10:00Z")];
  assert.equal(matchMatches(first)[0]!.id, matchMatches(second)[0]!.id);
  assert.deepEqual(matchMatches(first), matchMatches([...first].reverse()));
  assert.notEqual(matchMatches(first)[0]!.id, matchMatches([match("a", 1), match("b", 5)])[0]!.id);
});

test("matching does not mutate the input array or its quote records", () => {
  const input = [match("b", 5), match("a")];
  const before = structuredClone(input);
  matchMatches(input);
  assert.deepEqual(input, before);
  assert.deepEqual(matchMatches([]), []);
});
