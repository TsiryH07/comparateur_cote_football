import assert from "node:assert/strict";
import test from "node:test";
import { matchMatches } from "../src/services/matchMatcher.js";
import { normalizeMatch } from "../src/services/normalize.js";
import type { NormalizedMatch } from "../src/types.js";

// Club labels and orientations from the local 1xBet/Bet261 EPL captures.
// Dates are moved to 2030; the fixtures need no API, secret, artifact, or database.
const fixtures: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ["2030-10-17T11:30:00Z", "Everton", "Chelsea", "Everton FC", "Chelsea FC"],
  ["2030-10-17T14:00:00Z", "Brentford", "Liverpool", "Brentford FC", "Liverpool FC"],
  ["2030-10-17T14:00:00Z", "Fulham", "Hull City", "Fulham FC", "Hull City"],
  ["2030-10-17T14:00:00Z", "Manchester City", "Ipswich Town", "Manchester City FC", "Ipswich Town"],
  ["2030-10-17T16:30:00Z", "Newcastle United", "Aston Villa", "Newcastle United FC", "Aston Villa"],
  ["2030-10-18T13:00:00Z", "Bournemouth", "Sunderland", "AFC Bournemouth", "Sunderland AFC"],
  ["2030-10-18T13:00:00Z", "Brighton and Hove Albion", "Crystal Palace", "Brighton & Hove Albion FC", "Crystal Palace FC"],
  ["2030-10-18T13:00:00Z", "Leeds United", "Manchester United", "Leeds United", "Manchester United FC"],
  ["2030-10-18T15:30:00Z", "Nottingham Forest", "Arsenal", "Nottingham Forest", "Arsenal FC"],
  ["2030-10-19T19:00:00Z", "Tottenham Hotspur", "Coventry City", "Tottenham Hotspur FC", "Coventry City"],
  ["2030-10-23T19:00:00Z", "Ipswich Town", "Nottingham Forest", "Ipswich Town", "Nottingham Forest"],
  ["2030-10-24T11:30:00Z", "Aston Villa", "Manchester City", "Aston Villa", "Manchester City FC"],
  ["2030-10-24T14:00:00Z", "Arsenal", "Everton", "Arsenal FC", "Everton FC"],
  ["2030-10-24T14:00:00Z", "Coventry City", "Fulham", "Coventry City", "Fulham FC"],
  ["2030-10-24T16:30:00Z", "Chelsea", "Tottenham Hotspur", "Chelsea FC", "Tottenham Hotspur FC"],
  ["2030-10-25T14:00:00Z", "Hull City", "Brentford", "Hull City", "Brentford FC"],
  ["2030-10-25T14:00:00Z", "Liverpool", "Brighton and Hove Albion", "Liverpool FC", "Brighton & Hove Albion FC"],
  ["2030-10-25T14:00:00Z", "Crystal Palace", "Newcastle United", "Crystal Palace FC", "Newcastle United FC"],
  ["2030-10-25T14:00:00Z", "Manchester United", "Bournemouth", "Manchester United FC", "AFC Bournemouth"],
  ["2030-10-25T16:30:00Z", "Sunderland", "Leeds United", "Sunderland AFC", "Leeds United"],
];

// Prépare un exemple de match pour les tests.
function quote(source: string, id: string, homeTeam: string, awayTeam: string, startsAt: string): NormalizedMatch {
  return normalizeMatch({
    sourceMatchId: id, homeTeam, awayTeam, competition: "EPL", startsAt,
    odds: { "1": 2.1, X: 3.4, "2": 3.6 },
  }, source, new Date("2030-10-16T12:00:00Z"));
}

test("the 20 observed EPL listings pair across 1xBet and Bet261 with exact aliases", () => {
  const observations = fixtures.flatMap(([startsAt, home, away, betHome, betAway], index) => [
    quote("1xbet", `one-${index}`, home, away, startsAt),
    quote("bet261", `bet-${index}`, betHome, betAway, startsAt),
  ]);
  const events = matchMatches(observations, 0);
  assert.equal(events.length, 20);
  assert.equal(events.flatMap((event) => event.quotes).length, 40);
  assert.equal(new Set(events.map((event) => event.id)).size, 20);
  assert.ok(events.every((event) => event.quotes.length === 2));
  for (const event of events) {
    assert.deepEqual(event.quotes.map((item) => item.source), ["1xbet", "bet261"]);
    const [one, bet] = event.quotes;
    assert.equal(one!.normalizedHomeTeam, bet!.normalizedHomeTeam);
    assert.equal(one!.normalizedAwayTeam, bet!.normalizedAwayTeam);
    assert.equal(one!.startsAt, bet!.startsAt);
    assert.equal(one!.competition, "EPL");
    assert.equal(bet!.competition, "EPL");
  }
  assert.deepEqual(matchMatches([...observations].reverse(), 0), events);
  assert.equal(events.find((event) => event.quotes.some((item) => item.sourceMatchId === "bet-0"))!
    .quotes.find((item) => item.source === "bet261")!.homeTeam, "Everton FC");
});

test("EPL aliases still keep different squads, unknown FC clubs and reversed fixtures separate", () => {
  const startsAt = "2030-10-17T14:00:00Z";
  for (const [home, otherHome] of [
    ["Chelsea", "Chelsea FC Women"],
    ["Manchester United", "Manchester United FC U21"],
    ["Liverpool", "Liverpool FC II"],
    ["Everton", "Everton FC reserves"],
    ["Unknown", "Unknown FC"],
    ["France", "France FC"],
  ]) {
    const events = matchMatches([
      quote("1xbet", "senior", home!, "Aston Villa", startsAt),
      quote("bet261", "other", otherHome!, "Aston Villa", startsAt),
    ], 0);
    assert.equal(events.length, 2, `${home} / ${otherHome}`);
    assert.ok(events.every((event) => event.quotes.length === 1));
  }
  assert.equal(matchMatches([
    quote("1xbet", "home", "Everton", "Chelsea", startsAt),
    quote("bet261", "away", "Chelsea FC", "Everton FC", startsAt),
  ], 0).length, 2);
});
