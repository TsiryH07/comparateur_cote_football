import { normalizeMatch } from "../services/normalize.js";
import { AppError } from "../errors.js";
import type { CollectionContext, CollectionError, Collector, Odds, RawMatch } from "../types.js";
import { discardResponse, requestGet, sourceAbortError } from "./http.js";

export interface Bet261CollectorOptions {
  sports: string[];
  fetch?: typeof globalThis.fetch;
  pageSize?: number;
  maxPages?: number;
}

interface League {
  sport: string;
  countries: string[];
  names: string[];
  competition: string;
}

interface LeagueResult {
  matches: RawMatch[];
  warnings: CollectionError[];
}

const SITE = "https://www.bet261.mg";
const API_HOST = "hg-event-api-prod.sporty-tech.net";
const LEAGUES: League[] = [
  { sport: "soccer_epl", countries: ["Angleterre", "England"], names: ["Premier League", "English Premier League"], competition: "EPL" },
  { sport: "soccer_france_ligue_one", countries: ["France"], names: ["Ligue 1"], competition: "Ligue 1 - France" },
  { sport: "soccer_germany_bundesliga", countries: ["Allemagne", "Germany"], names: ["Bundesliga", "1. Bundesliga"], competition: "Bundesliga - Germany" },
  { sport: "soccer_italy_serie_a", countries: ["Italie", "Italy"], names: ["Serie A"], competition: "Serie A - Italy" },
  { sport: "soccer_spain_la_liga", countries: ["Espagne", "Spain"], names: ["LaLiga", "La Liga", "Primera Division"], competition: "La Liga - Spain" },
];
const ITEM_OUTCOMES = new Map<number, "1" | "X" | "2">([[1001, "1"], [1002, "X"], [1003, "2"]]);

class ScrapeError extends AppError {
  // Décrit un problème de lecture chez Bet261.
  constructor(message: string, code = "SOURCE_RESPONSE_INVALID") { super(code, message); }
}

// Vérifie que la donnée contient des champs.
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Vérifie que le numéro est entier et positif.
function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// Simplifie un nom pour mieux le comparer.
function name(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ") : "";
}

// Vérifie si le nom correspond à un nom connu.
function matchesName(value: unknown, aliases: string[]): boolean {
  return aliases.some((alias) => name(alias) === name(value));
}

// Signale que la collecte Bet261 est annulée.
function cancelled(): Error {
  return sourceAbortError("Collecte Bet261 annulée.");
}

// Choisit un message sans révéler de détails sensibles.
function safeMessage(error: unknown): string {
  return error instanceof AppError ? error.message : "Lecture des données publiques Bet261 impossible.";
}

// Vérifie l’adresse utilisée pour lire les données Bet261.
function apiBase(config: unknown): URL {
  if (!object(config) || typeof config.apiEventsBaseUrl !== "string") {
    throw new ScrapeError("La configuration publique Bet261 ne contient pas d’API d’événements valide.");
  }
  let url: URL;
  try { url = new URL(config.apiEventsBaseUrl); }
  catch { throw new ScrapeError("L’adresse de l’API publique Bet261 est invalide."); }
  if (url.protocol !== "https:" || url.hostname !== API_HOST || url.port || url.username || url.password || url.search || url.hash) {
    throw new ScrapeError("La configuration Bet261 désigne un hôte d’API non autorisé.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

// Retrouve le numéro du championnat choisi.
function categoryId(categories: unknown[], league: League): number {
  const candidates: number[] = [];
  for (const country of categories) {
    if (!object(country) || country.parentEventCategoryId !== 101 || !positiveId(country.id) ||
        !matchesName(country.name, league.countries) || !Array.isArray(country.subCategories)) continue;
    for (const category of country.subCategories as unknown[]) {
      if (object(category) && positiveId(category.id) && category.parentEventCategoryId === country.id &&
          matchesName(category.name, league.names)) candidates.push(category.id);
    }
  }
  if (candidates.length !== 1) {
    throw new ScrapeError(candidates.length ? "Plusieurs catégories correspondent à cette ligue ; rapprochement abandonné." :
      "Compétition introuvable dans les catégories publiques Bet261.");
  }
  return candidates[0]!;
}

type Parsed = { match: RawMatch } | { problem: "ignored" | "malformed" | "market" };

// Extrait les trois cotes d’un match à venir.
function parseEvent(value: unknown, category: number, league: League, now: Date): Parsed {
  if (!object(value) || !positiveId(value.id)) return { problem: "malformed" };
  if (value.entryPointId !== 101 || value.isVirtual !== false || value.eventType !== "Match" ||
      value.preEventOrLive !== "PreEvent" || value.state !== "Undisputed" || value.stateDetails !== "NotStarted" ||
      value.categoryId !== category) return { problem: "ignored" };
  if (!Array.isArray(value.eventBetTypes)) return { problem: "market" };
  const markets = value.eventBetTypes.filter((market: unknown) => object(market) && market.betTypeId === 10001);
  if (markets.length !== 1 || !object(markets[0])) return { problem: "market" };
  const market = markets[0];
  if (market.active !== true || market.bettingAllowed !== true || market.isAsian === true ||
      !Array.isArray(market.eventBetTypeItems) || market.eventBetTypeItems.length !== 3) return { problem: "market" };
  const odds = {} as Odds;
  const seen = new Set<string>();
  for (const item of market.eventBetTypeItems as unknown[]) {
    if (!object(item) || typeof item.betTypeItemId !== "number") return { problem: "market" };
    const outcome = ITEM_OUTCOMES.get(item.betTypeItemId);
    if (!outcome || item.shortName !== outcome || seen.has(outcome) || item.active !== true || item.bettingAllowed !== true ||
        typeof item.odds !== "number" || !Number.isFinite(item.odds) || item.odds <= 1) return { problem: "market" };
    seen.add(outcome);
    odds[outcome] = item.odds;
  }
  try {
    const match = normalizeMatch({
      sourceMatchId: String(value.id), homeTeam: value.homeTeamName, awayTeam: value.awayTeamName,
      competition: league.competition, startsAt: value.expectedStart, odds,
    }, "bet261", now);
    if (Date.parse(match.startsAt) <= now.getTime()) return { problem: "ignored" };
    return { match: {
      sourceMatchId: match.sourceMatchId, homeTeam: match.homeTeam, awayTeam: match.awayTeam,
      competition: match.competition, startsAt: match.startsAt, odds: match.odds,
    } };
  } catch { return { problem: "malformed" }; }
}

export class Bet261Collector implements Collector {
  readonly name = "bet261";
  readonly #sports: string[];
  readonly #fetch: typeof globalThis.fetch;
  readonly #pageSize: number;
  readonly #maxPages: number;
  #warnings: CollectionError[] = [];

  // Vérifie et prépare les réglages de Bet261.
  constructor(options: Bet261CollectorOptions) {
    if (!options || typeof options !== "object") throw new AppError("COLLECTOR_CONFIG", "La configuration du collecteur Bet261 est absente.");
    if (!Array.isArray(options.sports) || !options.sports.length ||
        options.sports.some((sport) => typeof sport !== "string" || !/^soccer_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(sport))) {
      throw new AppError("COLLECTOR_CONFIG", "Les ligues Bet261 doivent être une liste de clés de football non vides commençant par soccer_.");
    }
    if (typeof (options.fetch ?? globalThis.fetch) !== "function") throw new AppError("COLLECTOR_CONFIG", "Le transport HTTP Bet261 est indisponible.");
    const pageSize = options.pageSize ?? 50;
    const maxPages = options.maxPages ?? 5;
    if (!Number.isSafeInteger(pageSize) || !Number.isSafeInteger(pageSize + 1) || pageSize < 1 || !Number.isSafeInteger(maxPages) || maxPages < 1 ||
        !Number.isSafeInteger(pageSize * maxPages)) throw new AppError("COLLECTOR_CONFIG", "La pagination Bet261 doit utiliser des entiers strictement positifs et sûrs.");
    this.#sports = [...new Set(options.sports)];
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#pageSize = pageSize;
    this.#maxPages = maxPages;
  }

  // Renvoie les problèmes rencontrés pendant la dernière collecte.
  getWarnings(): CollectionError[] {
    return this.#warnings.map((warning) => ({ ...warning }));
  }

  // Récupère les matchs Bet261 et permet d’annuler.
  async collect({ now, signal }: CollectionContext): Promise<unknown[]> {
    this.#warnings = [];
    if (signal.aborted) throw cancelled();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new AppError("COLLECTION_CONTEXT", "La date de collecte Bet261 est invalide.");
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(cancelled());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try { return await Promise.race([this.scrape(now, signal), aborted]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  // Rassemble les matchs des championnats Bet261 demandés.
  private async scrape(now: Date, signal: AbortSignal): Promise<RawMatch[]> {
    const leagues: League[] = [];
    for (const sport of this.#sports) {
      const league = LEAGUES.find((candidate) => candidate.sport === sport);
      if (league) leagues.push(league);
      else this.#warnings.push({ source: this.name, message: `${sport} : ligue non prise en charge par le collecteur Bet261.` });
    }
    if (!leagues.length) throw new ScrapeError("Aucune ligue configurée n’est prise en charge par Bet261.");
    const base = apiBase(await this.fetchJson(new URL(`${SITE}/configurations/config.json`), signal));
    const url = new URL("eventcategories/101", base);
    url.searchParams.set("lang", "fr");
    const categories: unknown = await this.fetchJson(url, signal);
    if (!Array.isArray(categories)) throw new ScrapeError("Les catégories publiques Bet261 doivent être un tableau JSON.");
    const results = await Promise.allSettled(leagues.map(async (league) =>
      this.fetchLeague(base, categoryId(categories, league), league, now, signal)));
    if (signal.aborted) throw cancelled();
    const matches: RawMatch[] = [];
    let successful = 0;
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        successful++;
        matches.push(...result.value.matches);
        this.#warnings.push(...result.value.warnings);
      } else this.#warnings.push({ source: this.name, message: `${leagues[index]!.sport} : ${safeMessage(result.reason)}` });
    });
    if (!successful) throw new ScrapeError(`Collecte Bet261 impossible. ${this.#warnings.map((warning) => warning.message).join(" ")}`, "SOURCE_UNAVAILABLE");
    return matches;
  }

  // Lit les pages d’un championnat sans répéter les matchs.
  private async fetchLeague(base: URL, category: number, league: League, now: Date, signal: AbortSignal): Promise<LeagueResult> {
    const matches: RawMatch[] = [];
    const warnings: CollectionError[] = [];
    const seen = new Set<number>();
    let malformed = 0;
    let incomplete = 0;
    let duplicates = 0;
    for (let page = 0; page < this.#maxPages; page++) {
      const url = new URL("events", base);
      url.search = new URLSearchParams({
        eventCategoryIds: String(category), offset: String(page * this.#pageSize), length: String(this.#pageSize + 1),
        fetchEventBetTypesMode: "0", betTypeId: "10001", l: "fr",
      }).toString();
      let payload: unknown;
      try {
        payload = await this.fetchJson(url, signal);
        if (!Array.isArray(payload)) throw new ScrapeError("Les événements publics Bet261 doivent être un tableau JSON.");
      } catch (error) {
        if (signal.aborted) throw cancelled();
        if (page === 0) throw error;
        warnings.push({ source: this.name, message: `${league.sport} : collecte partielle à la page ${page + 1}. ${safeMessage(error)}` });
        break;
      }
      let newIds = 0;
      const rows = (payload as unknown[]).slice(0, this.#pageSize);
      for (const row of rows) {
        if (object(row) && positiveId(row.id)) {
          if (seen.has(row.id)) { duplicates++; continue; }
          seen.add(row.id);
          newIds++;
        }
        const parsed = parseEvent(row, category, league, now);
        if ("match" in parsed) matches.push(parsed.match);
        else if (parsed.problem === "malformed") malformed++;
        else if (parsed.problem === "market") incomplete++;
      }
      if (page > 0 && rows.length && newIds === 0) {
        warnings.push({ source: this.name, message: `${league.sport} : page répétée ou sans nouvel identifiant ; pagination arrêtée.` });
        break;
      }
      if ((payload as unknown[]).length <= this.#pageSize) break;
      if (page === this.#maxPages - 1) warnings.push({
        source: this.name, message: `${league.sport} : résultats tronqués à ${this.#maxPages} page(s) de ${this.#pageSize} observations.`,
      });
    }
    if (malformed) warnings.push({ source: this.name, message: `${league.sport} : ${malformed} événement(s) malformé(s) ignoré(s).` });
    if (incomplete) warnings.push({ source: this.name, message: `${league.sport} : ${incomplete} marché(s) 1X2 incomplet(s) ou suspendu(s) ignoré(s).` });
    if (duplicates) warnings.push({ source: this.name, message: `${league.sport} : ${duplicates} identifiant(s) de match en double ignoré(s).` });
    return { matches, warnings };
  }

  // Lit les données Bet261 et vérifie la réponse.
  private async fetchJson(url: URL, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw cancelled();
    const response = await requestGet(this.#fetch, url, {
      signal, redirect: "error", credentials: "omit",
      headers: { Accept: "application/json", Origin: SITE, Referer: `${SITE}/sports` },
    }, { network: "Connexion aux données publiques Bet261 impossible après deux essais.", cancelled: "Collecte Bet261 annulée." });
    if (signal.aborted) throw cancelled();
    const html = response.headers.get("content-type")?.toLowerCase().includes("text/html");
    if (!response.ok || html) {
      await discardResponse(response);
      const code = `SOURCE_HTTP_${response.status}`;
      if (response.status === 403 || response.status === 401) throw new ScrapeError(`Accès aux données publiques Bet261 refusé (HTTP ${response.status}).`, code);
      if (response.status === 429) throw new ScrapeError("Fréquence de requêtes Bet261 dépassée (HTTP 429).", code);
      if (response.status >= 500) throw new ScrapeError("Le service public Bet261 est temporairement indisponible.", code);
      if (html) throw new ScrapeError("Bet261 a renvoyé une page HTML : accès protégé ou restriction géographique possible.");
      throw new ScrapeError("Le service public Bet261 a refusé la requête.", code);
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch {
      if (signal.aborted) throw cancelled();
      throw new ScrapeError("Réponse JSON Bet261 illisible ; les données publiques sont indisponibles depuis cet accès.", "SOURCE_JSON_INVALID");
    }
    if (signal.aborted) throw cancelled();
    return payload;
  }
}
