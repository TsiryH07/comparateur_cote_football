import { normalizeMatch } from "../services/normalize.js";
import { AppError } from "../errors.js";
import type { CollectionContext, CollectionError, Collector, RawMatch } from "../types.js";
import { discardResponse, requestGet, sourceAbortError } from "./http.js";

export interface OddsApiCollectorOptions {
  apiKey: string;
  sports: string[];
  fetch?: typeof globalThis.fetch;
}

interface BookmakerDefinition {
  name: string;
  bookmakerKey: string;
  label: string;
}

interface LeagueResult {
  matches: RawMatch[];
  warnings: CollectionError[];
}

class RequestError extends AppError {
  // Décrit un problème de réponse du fournisseur.
  constructor(message: string, code = "SOURCE_RESPONSE_INVALID") { super(code, message); }
}

// Vérifie que la donnée contient des champs.
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Vérifie un texte et retire les espaces inutiles.
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Signale que la collecte de cette source est annulée.
function cancelled(source: string): Error {
  return sourceAbortError(`Collecte ${source} annulée.`);
}

// Explique pourquoi le site a refusé la demande.
function httpMessage(status: number): string {
  if (status === 401) return "Clé The Odds API invalide ou absente (HTTP 401).";
  if (status === 403) return "Accès refusé : vérifiez les droits de votre abonnement The Odds API (HTTP 403).";
  if (status === 429) return "Quota ou fréquence de requêtes The Odds API dépassé (HTTP 429).";
  if (status >= 500) return "The Odds API est temporairement indisponible.";
  return "The Odds API a refusé la requête.";
}

// Extrait les matchs et cotes de la source demandée.
function parseLeague(payload: unknown[], sport: string, now: Date, bookmaker: BookmakerDefinition): LeagueResult {
  const matches: RawMatch[] = [];
  let malformed = 0;
  let incomplete = 0;
  for (const event of payload) {
    if (!object(event) || !text(event.sport_key)) { malformed++; continue; }
    if (event.sport_key !== sport) { malformed++; continue; }
    const sourceMatchId = text(event.id);
    const homeTeam = text(event.home_team);
    const awayTeam = text(event.away_team);
    const startsAt = text(event.commence_time);
    if (!sourceMatchId || !homeTeam || !awayTeam || !startsAt || !Array.isArray(event.bookmakers)) {
      malformed++; continue;
    }
    const bookmakers = event.bookmakers.filter((value: unknown) => object(value) && value.key === bookmaker.bookmakerKey);
    if (bookmakers.length !== 1 || !object(bookmakers[0]) || !Array.isArray(bookmakers[0].markets)) {
      incomplete++; continue;
    }
    const markets = bookmakers[0].markets.filter((market: unknown) => object(market) && market.key === "h2h");
    if (markets.length !== 1 || !object(markets[0]) || !Array.isArray(markets[0].outcomes) || markets[0].outcomes.length !== 3) {
      incomplete++; continue;
    }
    const prices = new Map<string, number>();
    let invalid = false;
    for (const outcome of markets[0].outcomes as unknown[]) {
      if (!object(outcome)) { invalid = true; break; }
      const name = text(outcome.name);
      if (!name || ![homeTeam, awayTeam, "Draw"].includes(name) || prices.has(name) ||
          typeof outcome.price !== "number" || !Number.isFinite(outcome.price) || outcome.price <= 1) {
        invalid = true; break;
      }
      prices.set(name, outcome.price);
    }
    if (invalid || prices.size !== 3 || !prices.has(homeTeam) || !prices.has(awayTeam) || !prices.has("Draw")) {
      incomplete++; continue;
    }
    try {
      const normalized = normalizeMatch({
        sourceMatchId, homeTeam, awayTeam, competition: text(event.sport_title) ?? sport,
        startsAt, odds: { "1": prices.get(homeTeam)!, X: prices.get("Draw")!, "2": prices.get(awayTeam)! },
      }, bookmaker.name, now);
      if (Date.parse(normalized.startsAt) <= now.getTime()) continue;
      matches.push({
        sourceMatchId: normalized.sourceMatchId, homeTeam: normalized.homeTeam, awayTeam: normalized.awayTeam,
        competition: normalized.competition, startsAt: normalized.startsAt, odds: normalized.odds,
      });
    } catch {
      malformed++;
    }
  }
  const warnings: CollectionError[] = [];
  if (malformed) warnings.push({ source: bookmaker.name, message: `${sport} : ${malformed} événement(s) malformé(s) ou hors de la ligue ignoré(s).` });
  if (incomplete) warnings.push({ source: bookmaker.name, message: `${sport} : ${incomplete} rencontre(s) sans marché 1X2 complet chez ${bookmaker.label}.` });
  return { matches, warnings };
}

export abstract class OddsApiCollector implements Collector {
  readonly name: string;
  readonly #bookmaker: BookmakerDefinition;
  readonly #apiKey: string;
  readonly #sports: string[];
  readonly #fetch: typeof globalThis.fetch;
  #warnings: CollectionError[] = [];

  // Vérifie et prépare les réglages du fournisseur de cotes.
  protected constructor(options: OddsApiCollectorOptions, bookmaker: BookmakerDefinition) {
    if (!options || typeof options !== "object") throw new AppError("COLLECTOR_CONFIG", "La configuration du collecteur The Odds API est absente.");
    if (typeof options.apiKey !== "string" || !options.apiKey.trim()) {
      throw new AppError("COLLECTOR_CONFIG", `Une clé The Odds API est nécessaire pour la source ${bookmaker.name}.`);
    }
    if (!Array.isArray(options.sports) || options.sports.length === 0 ||
        options.sports.some((sport) => typeof sport !== "string" || !/^soccer_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(sport))) {
      throw new AppError("COLLECTOR_CONFIG", `Les ligues ${bookmaker.name} doivent être des clés The Odds API de football commençant par soccer_.`);
    }
    if (typeof (options.fetch ?? globalThis.fetch) !== "function") throw new AppError("COLLECTOR_CONFIG", "Le transport HTTP The Odds API est indisponible.");
    this.name = bookmaker.name;
    this.#bookmaker = { ...bookmaker };
    this.#apiKey = options.apiKey.trim();
    this.#sports = [...new Set(options.sports)];
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  // Renvoie les problèmes rencontrés pendant la dernière collecte.
  getWarnings(): CollectionError[] {
    return this.#warnings.map((warning) => ({ ...warning }));
  }

  // Rassemble les matchs des championnats demandés.
  async collect({ now, signal }: CollectionContext): Promise<unknown[]> {
    this.#warnings = [];
    if (signal.aborted) throw cancelled(this.name);
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new AppError("COLLECTION_CONTEXT", `La date de collecte ${this.name} est invalide.`);
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(cancelled(this.name));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const results = await Promise.race([
        Promise.allSettled(this.#sports.map((sport) => this.fetchLeague(sport, now, signal))), aborted,
      ]);
      if (signal.aborted) throw cancelled(this.name);
      const matches: RawMatch[] = [];
      let successful = 0;
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          successful++;
          matches.push(...result.value.matches);
          this.#warnings.push(...result.value.warnings);
        } else {
          const message = result.reason instanceof AppError ? result.reason.message : "Collecte de cette ligue impossible.";
          this.#warnings.push({ source: this.name, message: `${this.#sports[index]} : ${message}` });
        }
      });
      if (successful === 0) throw new AppError("SOURCE_UNAVAILABLE", `Collecte ${this.name} impossible. ${this.#warnings.map((warning) => warning.message).join(" ")}`);
      return matches;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  // Demande et vérifie les cotes d’un championnat.
  private async fetchLeague(sport: string, now: Date, signal: AbortSignal): Promise<LeagueResult> {
    const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds`);
    url.search = new URLSearchParams({
      apiKey: this.#apiKey, bookmakers: this.#bookmaker.bookmakerKey, markets: "h2h", oddsFormat: "decimal",
      dateFormat: "iso", commenceTimeFrom: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    }).toString();
    const response = await requestGet(this.#fetch, url, { signal, redirect: "error" }, {
      network: "Connexion à The Odds API impossible après deux essais.", cancelled: `Collecte ${this.name} annulée.`,
    });
    if (signal.aborted) throw cancelled(this.name);
    if (!response.ok) {
      await discardResponse(response);
      throw new RequestError(httpMessage(response.status), `SOURCE_HTTP_${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (signal.aborted) throw cancelled(this.name);
      throw new RequestError("Réponse JSON The Odds API illisible.", "SOURCE_JSON_INVALID");
    }
    if (signal.aborted) throw cancelled(this.name);
    if (!Array.isArray(payload)) throw new RequestError("The Odds API doit retourner un tableau d’événements.");
    return parseLeague(payload, sport, now, this.#bookmaker);
  }
}
