import type { OddsDatabase } from "../database/sqlite.js";
import { AppError, safeErrorMessage } from "../errors.js";
import type { Collector, CycleResult, NormalizedMatch, Threshold } from "../types.js";
import { compareOdds } from "./compareOdds.js";
import { matchMatches } from "./matchMatcher.js";
import { normalizeMatch } from "./normalize.js";

export interface CycleOptions {
  collectors: Collector[];
  database: Pick<OddsDatabase, "saveCycle">;
  threshold: Threshold;
  matchToleranceMinutes?: number;
  collectorTimeoutMs?: number;
  signal?: AbortSignal;
  clock?: () => Date;
}

// Récupère les cotes avec un temps limité.
async function collectWithTimeout(collector: Collector, now: Date, timeoutMs: number, signal?: AbortSignal): Promise<unknown[]> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new AppError("COLLECTOR_TIMEOUT", `Délai de collecte dépassé (${timeoutMs} ms).`)), timeoutMs);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason ?? new Error("Collecte annulée."));
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return collector.collect({ now: new Date(now), signal: controller.signal });
      }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    signal?.removeEventListener("abort", abort);
  }
}

// Récupère, compare et enregistre les cotes.
export async function collectCycle(options: CycleOptions): Promise<CycleResult> {
  const { collectors, database, threshold, signal, clock = () => new Date(),
    matchToleranceMinutes = 15, collectorTimeoutMs = 15_000 } = options;
  if (!Array.isArray(collectors) || collectors.length === 0 ||
      collectors.some((c) => !c || typeof c.name !== "string" || !c.name.trim() || typeof c.collect !== "function") ||
      new Set(collectors.map((c) => c.name.trim())).size !== collectors.length) {
    throw new AppError("COLLECTOR_CONFIG_INVALID", "Il faut au moins une source, une méthode de collecte et des noms de sources uniques et non vides.");
  }
  if (!Number.isSafeInteger(collectorTimeoutMs) || collectorTimeoutMs < 1 || collectorTimeoutMs > 2_147_483_647) {
    throw new AppError("COLLECTOR_CONFIG_INVALID", "Le délai de collecte doit être un entier entre 1 et 2147483647 ms.");
  }
  // Vérifie les réglages avant de contacter les sites.
  compareOdds([], threshold);
  matchMatches([], matchToleranceMinutes);
  signal?.throwIfAborted();
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AppError("CLOCK_INVALID", "La date de début de collecte est invalide. Vérifiez l'horloge du programme.");
  }
  const startedAt = now.toISOString();
  const settled = await Promise.allSettled(collectors.map((collector) => collectWithTimeout(collector, now, collectorTimeoutMs, signal)));
  signal?.throwIfAborted();
  const result: CycleResult = {
    startedAt, finishedAt: startedAt, events: [], alerts: [], errors: [],
    rejectedCount: 0, skippedCount: 0, collectedCount: 0,
  };
  const matches: NormalizedMatch[] = [];
  settled.forEach((collection, index) => {
    const source = collectors[index]!.name.trim();
    if (collection.status === "rejected") {
      result.errors.push({ source, message: safeErrorMessage(collection.reason, "Cette source n'a pas pu être lue.") });
      return;
    }
    if (!Array.isArray(collection.value)) {
      result.errors.push({ source, message: "La source doit retourner un tableau de matchs." });
      return;
    }
    try {
      const collector = collectors[index]!;
      const warnings = collector.getWarnings ? collector.getWarnings() : [];
      if (!Array.isArray(warnings)) throw new Error("Les avertissements de la source doivent être une liste.");
      for (const warning of warnings) {
        if (!warning || typeof warning.message !== "string" || !warning.message.trim()) {
          throw new Error("Un avertissement de la source est invalide.");
        }
        result.errors.push({ source, message: safeErrorMessage(warning.message) });
      }
    } catch (error) {
      // Garde les cotes même si un message d’erreur manque.
      result.errors.push({ source, message: `Lecture des avertissements impossible : ${safeErrorMessage(error)}` });
    }
    collection.value.forEach((row: unknown, rowIndex: number) => {
      try {
        const match = normalizeMatch(row, source, now);
        if (Date.parse(match.startsAt) <= now.getTime()) result.skippedCount += 1;
        else matches.push(match);
      } catch (error) {
        result.rejectedCount += 1;
        result.errors.push({ source, message: `Ligne ${rowIndex + 1} : ${safeErrorMessage(error)}` });
      }
    });
  });
  result.events = matchMatches(matches, matchToleranceMinutes);
  result.collectedCount = result.events.reduce((count, event) => count + event.quotes.length, 0);
  result.skippedCount += matches.length - result.collectedCount;
  result.alerts = compareOdds(result.events, threshold);
  const finishedAt = clock();
  if (!(finishedAt instanceof Date) || !Number.isFinite(finishedAt.getTime()) || finishedAt.getTime() < now.getTime()) {
    throw new AppError("CLOCK_INVALID", "La date de fin de collecte est invalide ou antérieure à son début. Aucune donnée n'a été enregistrée.");
  }
  result.finishedAt = finishedAt.toISOString();
  signal?.throwIfAborted();
  database.saveCycle(result);
  return result;
}
