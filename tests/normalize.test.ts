import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMatch, normalizeName } from "../src/services/normalize.js";
import type { RawMatch } from "../src/types.js";

const now = new Date("2026-10-17T10:00:00Z");
// Prépare un exemple de match pour les tests.
function raw(overrides: Partial<RawMatch> = {}): RawMatch {
  return {
    sourceMatchId: "match-1", homeTeam: " Paris Saint-Germain ", awayTeam: "Olympique de Marseille",
    competition: " Ligue 1 ", startsAt: "2026-10-18T22:30:00+03:00",
    odds: { "1": 1.8, X: 3.5, "2": 4.25 }, ...overrides,
  };
}

test("normalization validates the contract, preserves labels and converts dates to UTC", () => {
  const input = raw();
  const result = normalizeMatch(input, " oneXBet ", now);
  assert.equal(result.homeTeam, "Paris Saint-Germain");
  assert.equal(result.source, "oneXBet");
  assert.equal(result.normalizedHomeTeam, "paris saint germain");
  assert.equal(result.normalizedAwayTeam, "marseille");
  assert.equal(result.normalizedCompetition, "ligue 1");
  assert.equal(result.startsAt, "2026-10-18T19:30:00.000Z");
  assert.equal(result.collectedAt, "2026-10-17T10:00:00.000Z");
  assert.deepEqual(result.odds, input.odds);
  assert.notEqual(result.odds, input.odds);
  assert.equal(input.homeTeam, " Paris Saint-Germain ");
});

test("case, accents, punctuation and explicit aliases normalize consistently", () => {
  assert.equal(normalizeName("  Étoile—  du   SUD! "), "etoile du sud");
  for (const name of ["PSG", "Paris SG", "PARIS SAINT-GERMAIN"]) {
    assert.equal(normalizeName(name), "paris saint germain");
  }
  for (const name of ["Man United", "Man Utd", "Manchester United"]) {
    assert.equal(normalizeName(name), "manchester united");
  }
  assert.equal(normalizeName("Man City"), "manchester city");
  assert.equal(normalizeName("constructor"), "constructor");
});

test("normalization retains women, reserve and youth markers", () => {
  assert.notEqual(normalizeName("Chelsea Women"), normalizeName("Chelsea"));
  assert.notEqual(normalizeName("Chelsea U21"), normalizeName("Chelsea"));
  assert.notEqual(normalizeName("Chelsea II"), normalizeName("Chelsea"));
  assert.notEqual(normalizeName("Chelsea reserves"), normalizeName("Chelsea"));
});

test("observed Bet261 EPL club names have exact aliases matching 1xBet labels", () => {
  const aliases: ReadonlyArray<readonly [string, string]> = [
    ["Arsenal FC", "Arsenal"], ["Brentford FC", "Brentford"], ["Chelsea FC", "Chelsea"],
    ["Crystal Palace FC", "Crystal Palace"], ["Everton FC", "Everton"], ["Fulham FC", "Fulham"],
    ["Liverpool FC", "Liverpool"], ["Manchester City FC", "Manchester City"],
    ["Manchester United FC", "Manchester United"], ["Newcastle United FC", "Newcastle United"],
    ["Tottenham Hotspur FC", "Tottenham Hotspur"],
    ["Brighton & Hove Albion FC", "Brighton and Hove Albion"],
    ["AFC Bournemouth", "Bournemouth"], ["Sunderland AFC", "Sunderland"],
  ];
  for (const [bet261, oneXBet] of aliases) {
    assert.equal(normalizeName(bet261), normalizeName(oneXBet), `${bet261} / ${oneXBet}`);
    assert.equal(normalizeName(`  ${bet261.toUpperCase()}  `), normalizeName(oneXBet));
  }
  const match = normalizeMatch(raw({ homeTeam: "Everton FC", awayTeam: "Chelsea FC", competition: "EPL" }), "bet261", now);
  assert.equal(match.homeTeam, "Everton FC");
  assert.equal(match.awayTeam, "Chelsea FC");
  assert.equal(match.normalizedHomeTeam, "everton");
  assert.equal(match.normalizedAwayTeam, "chelsea");
  assert.equal(match.normalizedCompetition, "epl");
});

test("FC aliases do not remove squad markers or globally strip club and nation names", () => {
  for (const [squad, senior] of [
    ["Chelsea FC Women", "Chelsea"], ["Manchester United FC U21", "Manchester United"],
    ["Liverpool FC II", "Liverpool"], ["Everton FC reserves", "Everton"],
    ["AFC Bournemouth U18", "Bournemouth"], ["Sunderland AFC Women", "Sunderland"],
    ["France FC", "France"], ["Unknown FC", "Unknown"], ["AFC Unknown", "Unknown"],
    ["Unknown & United FC", "Unknown and United"],
  ]) assert.notEqual(normalizeName(squad!), normalizeName(senior!), `${squad} / ${senior}`);
  assert.equal(normalizeName("Chelsea FC Women"), "chelsea fc women");
  assert.equal(normalizeName("Manchester United FC U21"), "manchester united fc u21");
  assert.equal(normalizeName("Liverpool FC II"), "liverpool fc ii");
  assert.equal(normalizeName("Everton FC reserves"), "everton fc reserves");
});

test("all three decimal odds must be finite numbers strictly greater than 1", () => {
  for (const value of [undefined, null, "2.1", NaN, Infinity, -Infinity, 1, 0, -2]) {
    for (const outcome of ["1", "X", "2"]) {
      const input = raw();
      (input.odds as unknown as Record<string, unknown>)[outcome] = value;
      assert.throws(() => normalizeMatch(input, "source", now), /odds/);
    }
  }
});

test("malformed records and empty identifying fields are rejected", () => {
  for (const input of [null, undefined, [], true, "match", {}]) {
    assert.throws(() => normalizeMatch(input, "source", now), TypeError);
  }
  for (const field of ["sourceMatchId", "homeTeam", "awayTeam", "competition"]) {
    assert.throws(() => normalizeMatch({ ...raw(), [field]: " " }, "source", now), TypeError);
    assert.throws(() => normalizeMatch({ ...raw(), [field]: 123 }, "source", now), TypeError);
  }
  assert.throws(() => normalizeMatch(raw({ competition: "!!!" }), "source", now), TypeError);
  assert.throws(() => normalizeMatch(raw(), " ", now), /source/);
  assert.throws(() => normalizeMatch(raw(), "source", new Date(NaN)), /collectedAt/);
  assert.throws(() => normalizeMatch({ ...raw(), odds: [] }, "source", now), /odds/);
  assert.throws(() => normalizeMatch(raw({ awayTeam: "PSG" }), "source", now), /distinct/);
});

test("kickoffs require an explicit timezone and a real calendar date", () => {
  const invalid = [
    "2026-10-18T19:30:00", "2026-10-18", "tomorrow", "2026-02-29T10:00:00Z",
    "2026-02-30T10:00:00Z", "2026-04-31T10:00:00Z", "2026-13-01T10:00:00Z",
    "2026-00-01T10:00:00Z", "2026-10-00T10:00:00Z", "2026-10-18T24:00:00Z",
    "2026-10-18T19:60:00Z", "2026-10-18T19:30:60Z", "2026-10-18T19:30:00+24:00",
    "2026-10-18T19:30:00+03:60",
  ];
  for (const startsAt of invalid) {
    assert.throws(() => normalizeMatch(raw({ startsAt }), "source", now), /startsAt/);
  }
  assert.equal(normalizeMatch(raw({ startsAt: "2028-02-29T00:30:00+03:00" }), "source", now).startsAt,
    "2028-02-28T21:30:00.000Z");
  assert.equal(normalizeMatch(raw({ startsAt: "2026-10-18T19:30Z" }), "source", now).startsAt,
    "2026-10-18T19:30:00.000Z");
});
