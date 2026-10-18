import { OUTCOMES, type MatchedEvent, type OddsAlert, type Threshold } from "../types.js";

type Decimal = { units: bigint; exponent: number };

// Prépare un nombre pour un calcul précis.
function decimal(value: number): Decimal {
  const [mantissa, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  return { units: BigInt(whole! + fraction), exponent: Number(exponent) - fraction.length };
}

// Vérifie quel nombre est le plus grand.
function greaterThan(left: Decimal, right: Decimal): boolean {
  const exponent = Math.min(left.exponent, right.exponent);
  return left.units * 10n ** BigInt(left.exponent - exponent) >
    right.units * 10n ** BigInt(right.exponent - exponent);
}

// Vérifie si l’écart dépasse le seuil choisi.
function exceeds(min: number, max: number, threshold: Threshold): boolean {
  const low = decimal(min);
  const high = decimal(max);
  const limit = decimal(threshold.value);
  const exponent = Math.min(low.exponent, high.exponent);
  const difference = {
    units: high.units * 10n ** BigInt(high.exponent - exponent) -
      low.units * 10n ** BigInt(low.exponent - exponent),
    exponent,
  };
  return threshold.mode === "absolute" ? greaterThan(difference, limit) :
    greaterThan({ units: difference.units * 100n, exponent }, {
      units: low.units * limit.units, exponent: low.exponent + limit.exponent,
    });
}

// Repère les écarts de cotes trop importants.
export function compareOdds(events: MatchedEvent[], threshold: Threshold): OddsAlert[] {
  if (!threshold || (threshold.mode !== "absolute" && threshold.mode !== "percentage") ||
      !Number.isFinite(threshold.value) || threshold.value < 0) {
    throw new TypeError("threshold must have a valid mode and a finite, nonnegative value");
  }
  const alerts: OddsAlert[] = [];
  for (const event of events) {
    // Garde une seule cote par site.
    const sources = new Map<string, (typeof event.quotes)[number]>();
    for (const quote of event.quotes) {
      const previous = sources.get(quote.source);
      if (!previous || Date.parse(quote.collectedAt) > Date.parse(previous.collectedAt) ||
          (quote.collectedAt === previous.collectedAt && quote.sourceMatchId < previous.sourceMatchId)) {
        sources.set(quote.source, quote);
      }
    }
    if (sources.size < 2) continue;
    const quotes = [...sources.values()].sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
    for (const outcome of OUTCOMES) {
      for (const quote of quotes) {
        const odd = quote.odds[outcome];
        if (!Number.isFinite(odd) || odd <= 1) throw new TypeError(`Invalid odds for ${quote.source}, ${outcome}`);
      }
      const minimum = quotes.reduce((a, b) => b.odds[outcome] < a.odds[outcome] ? b : a);
      const maximum = quotes.reduce((a, b) => b.odds[outcome] > a.odds[outcome] ? b : a);
      const minOdd = minimum.odds[outcome];
      const maxOdd = maximum.odds[outcome];
      const absoluteDifference = maxOdd - minOdd;
      const percentageDifference = absoluteDifference / minOdd * 100;
      if (exceeds(minOdd, maxOdd, threshold)) {
        alerts.push({
          eventId: event.id, homeTeam: event.homeTeam, awayTeam: event.awayTeam,
          competition: event.competition, startsAt: event.startsAt, outcome,
          minOdd, maxOdd, minSource: minimum.source, maxSource: maximum.source,
          absoluteDifference, percentageDifference,
        });
      }
    }
  }
  return alerts;
}
