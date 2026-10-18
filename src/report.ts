import type { CycleResult, HistoryEntry, OddsAlert, StoredAlert, Threshold } from "./types.js";

// Arrondit un nombre pour faciliter sa lecture.
const round = (value: number) => Number(value.toFixed(4));

// Affiche les écarts de cotes détectés.
export function printAlerts(alerts: OddsAlert[] | StoredAlert[]): void {
  if (alerts.length === 0) {
    console.log("Aucun écart supérieur au seuil.");
    return;
  }
  console.table(alerts.map((alert) => ({
    Match: `${alert.homeTeam} - ${alert.awayTeam}`,
    "Début (UTC)": alert.startsAt,
    Issue: alert.outcome,
    Minimum: alert.minOdd,
    "Source min": alert.minSource,
    Maximum: alert.maxOdd,
    "Source max": alert.maxSource,
    Écart: round(alert.absoluteDifference),
    "Écart (%)": round(alert.percentageDifference),
    ...("collectedAt" in alert ? { "Collecte (UTC)": alert.collectedAt } : {}),
  })));
}

// Affiche le bilan de la collecte.
export function printCycle(result: CycleResult, threshold: Threshold): void {
  console.log(`\nCollecte ${result.startedAt} — seuil ${threshold.value}${threshold.mode === "percentage" ? " %" : " (cote)"}`);
  const paired = result.events.filter((event) => event.quotes.length > 1).length;
  console.log(`${result.collectedCount} observations enregistrées, ${result.events.length} matchs, ${paired} rapprochés, ${result.alerts.length} alertes.`);
  console.log(`${result.skippedCount} ignoré(s) (passés/doublons), ${result.rejectedCount} donnée(s) invalide(s).`);
  for (const error of result.errors) console.warn(`[${error.source}] ${error.message}`);
  printAlerts(result.alerts);
}

// Affiche les cotes enregistrées précédemment.
export function printHistory(history: HistoryEntry[]): void {
  if (history.length === 0) {
    console.log("Historique vide. Lancez d'abord npm run demo.");
    return;
  }
  console.table(history.map((row) => ({
    Collecte: row.runId,
    "Date de collecte (UTC)": row.collectedAt,
    Match: `${row.homeTeam} - ${row.awayTeam}`,
    Compétition: row.competition,
    "Début (UTC)": row.startsAt,
    Source: row.source,
    "1": row.odds["1"],
    X: row.odds.X,
    "2": row.odds["2"],
  })));
}
