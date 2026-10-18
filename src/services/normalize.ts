import { OUTCOMES, type NormalizedMatch, type Odds } from "../types.js";

const TEAM_ALIASES: Readonly<Record<string, string>> = {
  psg: "paris saint germain",
  "paris sg": "paris saint germain",
  "paris saint germain": "paris saint germain",
  "man united": "manchester united",
  "man utd": "manchester united",
  "manchester utd": "manchester united",
  "manchester united": "manchester united",
  "man city": "manchester city",
  "manchester city": "manchester city",
  "olympique de marseille": "marseille",
  marseille: "marseille",
  // Ces noms connus évitent de confondre deux équipes.
  "arsenal fc": "arsenal",
  "brentford fc": "brentford",
  "chelsea fc": "chelsea",
  "crystal palace fc": "crystal palace",
  "everton fc": "everton",
  "fulham fc": "fulham",
  "liverpool fc": "liverpool",
  "manchester city fc": "manchester city",
  "manchester united fc": "manchester united",
  "newcastle united fc": "newcastle united",
  "tottenham hotspur fc": "tottenham hotspur",
  "brighton hove albion fc": "brighton and hove albion",
  "afc bournemouth": "bournemouth",
  "sunderland afc": "sunderland",
};

// Simplifie un nom pour faciliter sa comparaison.
function basicName(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

// Réunit les différentes écritures d’un même nom.
export function normalizeName(name: string): string {
  const normalized = basicName(name);
  return Object.hasOwn(TEAM_ALIASES, normalized) ? TEAM_ALIASES[normalized]! : normalized;
}

// Vérifie le format des informations.
function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

// Vérifie qu’un texte contient une valeur.
function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a nonempty string`);
  }
  return value.trim();
}

// Vérifie la date du match.
function timestamp(value: unknown): string {
  const text = nonempty(value, "startsAt");
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!parts) throw new TypeError("startsAt must be ISO 8601 with an explicit timezone");
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = parts[8]!;
  const validZone = zone === "Z" || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59);
  const time = Date.parse(text);
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! ||
      hour > 23 || minute > 59 || second > 59 || !validZone || !Number.isFinite(time)) {
    throw new TypeError("startsAt contains an invalid date or timezone");
  }
  return new Date(time).toISOString();
}

// Vérifie et prépare les informations d’un match.
export function normalizeMatch(input: unknown, source: string, collectedAt: Date): NormalizedMatch {
  const raw = object(input, "match");
  const sourceName = nonempty(source, "source");
  if (!(collectedAt instanceof Date) || !Number.isFinite(collectedAt.getTime())) {
    throw new TypeError("collectedAt must be a valid Date");
  }
  const sourceMatchId = nonempty(raw.sourceMatchId, "sourceMatchId");
  const homeTeam = nonempty(raw.homeTeam, "homeTeam");
  const awayTeam = nonempty(raw.awayTeam, "awayTeam");
  const competition = nonempty(raw.competition, "competition");
  const normalizedHomeTeam = normalizeName(homeTeam);
  const normalizedAwayTeam = normalizeName(awayTeam);
  // Traite les noms de championnats séparément des équipes.
  const normalizedCompetition = basicName(competition);
  if (!normalizedHomeTeam || !normalizedAwayTeam || !normalizedCompetition) {
    throw new TypeError("teams and competition must contain letters or numbers");
  }
  if (normalizedHomeTeam === normalizedAwayTeam) {
    throw new TypeError("homeTeam and awayTeam must be distinct");
  }
  const rawOdds = object(raw.odds, "odds");
  const odds = {} as Odds;
  for (const outcome of OUTCOMES) {
    const odd = rawOdds[outcome];
    if (typeof odd !== "number" || !Number.isFinite(odd) || odd <= 1) {
      throw new TypeError(`odds.${outcome} must be a finite decimal number greater than 1`);
    }
    odds[outcome] = odd;
  }
  return {
    source: sourceName, sourceMatchId, homeTeam, awayTeam, competition,
    startsAt: timestamp(raw.startsAt), odds,
    normalizedHomeTeam, normalizedAwayTeam, normalizedCompetition,
    collectedAt: collectedAt.toISOString(),
  };
}
