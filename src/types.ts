export const OUTCOMES = ["1", "X", "2"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type Odds = Record<Outcome, number>;

// Informations d’un match avant vérification.
export interface RawMatch {
  sourceMatchId: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  // La date précise aussi le fuseau horaire.
  startsAt: string;
  odds: Odds;
}

export interface CollectionContext {
  now: Date;
  signal: AbortSignal;
}

export interface Collector {
  readonly name: string;
  collect(context: CollectionContext): Promise<unknown[]>;
  // Ces problèmes n’empêchent pas de garder les autres résultats.
  getWarnings?(): CollectionError[];
}

export interface NormalizedMatch extends RawMatch {
  source: string;
  normalizedHomeTeam: string;
  normalizedAwayTeam: string;
  normalizedCompetition: string;
  collectedAt: string;
}

export interface MatchedEvent {
  id: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startsAt: string;
  quotes: NormalizedMatch[];
}

export interface Threshold {
  mode: "absolute" | "percentage";
  value: number;
}

export interface OddsAlert {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startsAt: string;
  outcome: Outcome;
  minOdd: number;
  maxOdd: number;
  minSource: string;
  maxSource: string;
  absoluteDifference: number;
  percentageDifference: number;
}

export interface CollectionError {
  source: string;
  message: string;
}

export interface CycleResult {
  startedAt: string;
  finishedAt: string;
  events: MatchedEvent[];
  alerts: OddsAlert[];
  errors: CollectionError[];
  rejectedCount: number;
  skippedCount: number;
  collectedCount: number;
}

export interface HistoryEntry {
  runId: number;
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startsAt: string;
  source: string;
  sourceMatchId: string;
  collectedAt: string;
  odds: Odds;
}

export interface StoredAlert extends OddsAlert {
  runId: number;
  collectedAt: string;
}
