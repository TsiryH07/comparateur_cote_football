import { createHash } from "node:crypto";
import type { MatchedEvent, NormalizedMatch } from "../types.js";

// Compare deux textes pour les classer.
function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Résume les informations qui distinguent une cote.
function fingerprint(match: NormalizedMatch): string {
  return JSON.stringify([
    match.source, match.sourceMatchId, match.startsAt, match.normalizedHomeTeam,
    match.normalizedAwayTeam, match.normalizedCompetition, match.homeTeam,
    match.awayTeam, match.competition, match.odds["1"], match.odds.X, match.odds["2"],
  ]);
}

// Crée un identifiant à partir des informations.
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Classe les matchs par date puis par contenu.
function ordered(left: NormalizedMatch, right: NormalizedMatch): number {
  return Date.parse(left.startsAt) - Date.parse(right.startsAt) || lexical(fingerprint(left), fingerprint(right));
}

// Regroupe les cotes qui concernent le même match.
export function matchMatches(matches: NormalizedMatch[], toleranceMinutes = 15): MatchedEvent[] {
  if (!Number.isFinite(toleranceMinutes) || toleranceMinutes < 0) {
    throw new TypeError("toleranceMinutes must be finite and nonnegative");
  }
  const latest = new Map<string, NormalizedMatch>();
  for (const match of matches) {
    const key = JSON.stringify([match.source, match.sourceMatchId]);
    const previous = latest.get(key);
    const freshness = previous ? Date.parse(match.collectedAt) - Date.parse(previous.collectedAt) : 1;
    if (!previous || freshness > 0 || (freshness === 0 && lexical(fingerprint(match), fingerprint(previous)) < 0)) {
      latest.set(key, match);
    }
  }
  const groups = new Map<string, NormalizedMatch[]>();
  for (const match of latest.values()) {
    const key = JSON.stringify([match.normalizedHomeTeam, match.normalizedAwayTeam, match.normalizedCompetition]);
    const group = groups.get(key) ?? [];
    group.push(match);
    groups.set(key, group);
  }
  const events: MatchedEvent[] = [];
  const tolerance = toleranceMinutes * 60_000;
  const append = (quotes: NormalizedMatch[]) => {
    const sorted = [...quotes].sort(ordered);
    const canonical = sorted[0]!;
    const startsAt = new Date(canonical.startsAt).toISOString();
    events.push({
      id: `match_${hash([canonical.normalizedHomeTeam, canonical.normalizedAwayTeam,
        canonical.normalizedCompetition, startsAt])}`,
      homeTeam: canonical.homeTeam, awayTeam: canonical.awayTeam,
      competition: canonical.competition, startsAt,
      quotes: sorted.sort((a, b) => lexical(a.source, b.source) || lexical(a.sourceMatchId, b.sourceMatchId)),
    });
  };
  for (const candidates of groups.values()) {
    candidates.sort(ordered);
    const visited = new Set<number>();
    for (let index = 0; index < candidates.length; index++) {
      if (visited.has(index)) continue;
      visited.add(index);
      const queue = [index];
      const component: NormalizedMatch[] = [];
      for (let next = 0; next < queue.length; next++) {
        const current = candidates[queue[next]!]!;
        component.push(current);
        for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
          if (visited.has(candidateIndex)) continue;
          const candidate = candidates[candidateIndex]!;
          if (current.source !== candidate.source &&
              Math.abs(Date.parse(current.startsAt) - Date.parse(candidate.startsAt)) <= tolerance) {
            visited.add(candidateIndex);
            queue.push(candidateIndex);
          }
        }
      }
      component.sort(ordered);
      const uniqueSources = new Set(component.map((match) => match.source)).size === component.length;
      const span = Date.parse(component.at(-1)!.startsAt) - Date.parse(component[0]!.startsAt);
      if (uniqueSources && span <= tolerance) append(component);
      else for (const match of component) append([match]);
    }
  }
  // Distingue les rencontres qui ont les mêmes équipes et horaires.
  const idCounts = new Map<string, number>();
  for (const event of events) idCounts.set(event.id, (idCounts.get(event.id) ?? 0) + 1);
  for (const event of events) {
    if (idCounts.get(event.id)! > 1) {
      event.id += `_${hash(event.quotes.map((quote) => [quote.source, quote.sourceMatchId]))}`;
    }
  }
  return events.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || lexical(a.id, b.id));
}
