import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { AppError, redactSecrets, safeErrorMessage } from "../errors.js";
import { normalizeMatch } from "../services/normalize.js";
import type { CollectionError, CycleResult, HistoryEntry, MatchedEvent, OddsAlert, Outcome, StoredAlert } from "../types.js";

type DatabaseOperation = "open" | "read" | "write" | "close";

// Explique un problème de lecture ou d’enregistrement.
function databaseError(error: unknown, operation: DatabaseOperation): AppError {
  if (error instanceof AppError) return error;
  const native = typeof error === "object" && error !== null ? error as {
    code?: unknown; errcode?: unknown;
  } : {};
  // Retrouve la catégorie du problème de stockage.
  const primary = typeof native.errcode === "number" ? native.errcode & 0xff : undefined;
  if (primary === 5 || primary === 6 || native.code === "SQLITE_BUSY" || native.code === "SQLITE_LOCKED") {
    return new AppError("DATABASE_BUSY", "La base SQLite est occupée par une autre opération. Réessayez lorsque celle-ci est terminée.", { cause: error });
  }
  if (primary === 13 || native.code === "SQLITE_FULL" || native.code === "ENOSPC") {
    return new AppError("DATABASE_FULL", "L’espace disponible pour SQLite est insuffisant. Vérifiez l’espace disque avant de relancer la collecte.", { cause: error });
  }
  if (primary === 11 || primary === 26 || native.code === "SQLITE_CORRUPT" || native.code === "SQLITE_NOTADB") {
    return new AppError("DATABASE_CORRUPT", "Le fichier SQLite est illisible ou ne contient pas une base valide. Vérifiez DATABASE_PATH et utilisez une sauvegarde valide si nécessaire.", { cause: error });
  }
  const code = operation === "open" ? "DATABASE_OPEN_FAILED" :
    operation === "read" ? "DATABASE_READ_FAILED" : operation === "close" ? "DATABASE_CLOSE_FAILED" : "DATABASE_WRITE_FAILED";
  const message = operation === "open" ?
    "Impossible d’ouvrir la base SQLite. Vérifiez DATABASE_PATH, le dossier et les droits d’accès." :
    operation === "read" ? "Impossible de lire la base SQLite. Vérifiez le fichier et les droits d’accès." :
    operation === "close" ? "Impossible de fermer correctement la base SQLite." :
    "Impossible d’enregistrer la collecte dans SQLite. Vérifiez les données et les droits d’écriture.";
  return new AppError(code, message, { cause: error });
}

// Signale que les données enregistrées sont invalides.
function corruptData(cause: unknown): AppError {
  return new AppError("DATABASE_CORRUPT", "La base SQLite contient des données enregistrées invalides. Vérifiez le fichier ou restaurez une sauvegarde valide.", { cause });
}

// Vérifie qu’un texte enregistré est bien rempli.
function storedText(value: SQLOutputValue | undefined, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`Invalid stored ${field}`);
  return value;
}

// Vérifie qu’un nombre enregistré respecte les limites.
function storedNumber(value: SQLOutputValue | undefined, field: string, minimum: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || (integer && !Number.isSafeInteger(value))) {
    throw new TypeError(`Invalid stored ${field}`);
  }
  return value;
}

// Vérifie qu’une date enregistrée existe vraiment.
function storedTimestamp(value: SQLOutputValue | undefined, field: string): string {
  const text = storedText(value, field);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!parts) throw new TypeError(`Invalid stored ${field}`);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = parts[8]!;
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! ||
      Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6] ?? 0) > 59 ||
      (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) ||
      !Number.isFinite(Date.parse(text))) {
    throw new TypeError(`Invalid stored ${field}`);
  }
  return text;
}

// Relit les problèmes enregistrés sans révéler de secrets.
function readErrors(value: SQLOutputValue | undefined): CollectionError[] {
  const errors: unknown = JSON.parse(storedText(value, "errors_json"));
  if (!Array.isArray(errors) || errors.some((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return true;
    const candidate = entry as Record<string, unknown>;
    return typeof candidate.source !== "string" || !candidate.source.trim() ||
      typeof candidate.message !== "string" || !candidate.message.trim();
  })) throw new TypeError("Invalid stored collection errors");
  return (errors as CollectionError[]).map((error) => ({
    source: redactSecrets(error.source), message: safeErrorMessage(error.message),
  }));
}

// Relit et vérifie un ancien relevé de cotes.
function readHistory(row: Record<string, SQLOutputValue>): HistoryEntry {
  const raw = {
    sourceMatchId: storedText(row.source_match_id, "source_match_id"),
    homeTeam: storedText(row.home_team, "home_team"),
    awayTeam: storedText(row.away_team, "away_team"),
    competition: storedText(row.competition, "competition"),
    startsAt: storedTimestamp(row.starts_at, "starts_at"),
    odds: {
      "1": storedNumber(row.home_odd, "home_odd", 1),
      X: storedNumber(row.draw_odd, "draw_odd", 1),
      "2": storedNumber(row.away_odd, "away_odd", 1),
    },
  };
  const source = storedText(row.source, "source");
  const collectedAt = storedTimestamp(row.collected_at, "collected_at");
  normalizeMatch(raw, source, new Date(collectedAt));
  return {
    runId: storedNumber(row.run_id, "run_id", 1, true),
    eventId: storedText(row.event_id, "event_id"),
    ...raw,
    source,
    collectedAt,
  };
}

// Vérifie le nombre de résultats demandés.
function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("La limite doit être un entier strictement positif.");
  }
}

// Relit et vérifie une alerte enregistrée.
function readAlert(row: Record<string, SQLOutputValue>): OddsAlert {
  if (row.outcome !== "1" && row.outcome !== "X" && row.outcome !== "2") {
    throw new TypeError("Invalid stored outcome");
  }
  const minOdd = storedNumber(row.min_odd, "min_odd", 1);
  const maxOdd = storedNumber(row.max_odd, "max_odd", minOdd);
  if (minOdd <= 1) throw new TypeError("Invalid stored min_odd");
  return {
    eventId: storedText(row.event_id, "event_id"),
    homeTeam: storedText(row.home_team, "home_team"),
    awayTeam: storedText(row.away_team, "away_team"),
    competition: storedText(row.competition, "competition"),
    startsAt: storedTimestamp(row.starts_at, "starts_at"),
    outcome: row.outcome as Outcome,
    minOdd,
    maxOdd,
    minSource: storedText(row.min_source, "min_source"),
    maxSource: storedText(row.max_source, "max_source"),
    absoluteDifference: storedNumber(row.absolute_difference, "absolute_difference", 0),
    percentageDifference: storedNumber(row.percentage_difference, "percentage_difference", 0),
  };
}

export class OddsDatabase {
  private readonly database: DatabaseSync;
  private closed = false;
  private unusable = false;

  // Ouvre l’historique et prépare le rangement des données.
  constructor(path: string) {
    let opened: DatabaseSync | undefined;
    try {
      if (typeof path !== "string" || !path.trim()) throw new TypeError("Invalid database path");
      const databasePath = path === ":memory:" ? path : resolve(path);
      if (path !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
      this.database = opened = new DatabaseSync(databasePath);
      this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      if (path !== ":memory:") {
        this.database.exec("PRAGMA journal_mode = WAL;");
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS collection_runs (
          id INTEGER PRIMARY KEY,
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL,
          collected_count INTEGER NOT NULL CHECK (collected_count >= 0),
          rejected_count INTEGER NOT NULL CHECK (rejected_count >= 0),
          skipped_count INTEGER NOT NULL CHECK (skipped_count >= 0),
          errors_json TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS matches (
          id TEXT PRIMARY KEY,
          home_team TEXT NOT NULL,
          away_team TEXT NOT NULL,
          competition TEXT NOT NULL,
          starts_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS odds_snapshots (
          id INTEGER PRIMARY KEY,
          run_id INTEGER NOT NULL REFERENCES collection_runs(id),
          event_id TEXT NOT NULL REFERENCES matches(id),
          source TEXT NOT NULL,
          source_match_id TEXT NOT NULL,
          home_team TEXT NOT NULL,
          away_team TEXT NOT NULL,
          competition TEXT NOT NULL,
          starts_at TEXT NOT NULL,
          collected_at TEXT NOT NULL,
          home_odd REAL NOT NULL CHECK (home_odd > 1),
          draw_odd REAL NOT NULL CHECK (draw_odd > 1),
          away_odd REAL NOT NULL CHECK (away_odd > 1),
          UNIQUE (run_id, event_id, source)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS alerts (
          id INTEGER PRIMARY KEY,
          run_id INTEGER NOT NULL REFERENCES collection_runs(id),
          event_id TEXT NOT NULL REFERENCES matches(id),
          home_team TEXT NOT NULL,
          away_team TEXT NOT NULL,
          competition TEXT NOT NULL,
          starts_at TEXT NOT NULL,
          collected_at TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('1', 'X', '2')),
          min_odd REAL NOT NULL CHECK (min_odd > 1),
          max_odd REAL NOT NULL CHECK (max_odd >= min_odd),
          min_source TEXT NOT NULL,
          max_source TEXT NOT NULL,
          absolute_difference REAL NOT NULL CHECK (absolute_difference >= 0),
          percentage_difference REAL NOT NULL CHECK (percentage_difference >= 0)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS snapshots_history
          ON odds_snapshots(collected_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS snapshots_event
          ON odds_snapshots(event_id, collected_at DESC);
        CREATE INDEX IF NOT EXISTS alerts_history
          ON alerts(collected_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS alerts_run
          ON alerts(run_id, id);
      `);
    } catch (error) {
      // Garde le premier message d’erreur.
      try { opened?.close(); } catch { /* Preserve the original failure. */ }
      throw databaseError(error, "open");
    }
  }

  // Vérifie que l’historique est encore accessible.
  private assertOpen(): void {
    if (this.closed || this.unusable || !this.database.isOpen) {
      throw new AppError("DATABASE_CLOSED", "La base SQLite est fermée. Redémarrez le service avant de relancer cette opération.");
    }
  }

  // Annule les changements si l’enregistrement échoue.
  private rollbackSafely(): void {
    // L’enregistrement peut déjà avoir été annulé.
    if (!this.database.isOpen || !this.database.isTransaction) return;
    try { this.database.exec("ROLLBACK"); } catch {
      // Ferme l’historique si son état est incertain.
      this.unusable = true;
      try {
        this.database.close();
        this.closed = true;
      } catch { /* Preserve the original failure; close() can retry cleanup. */ }
    }
  }

  // Lit les données et explique les problèmes éventuels.
  private readStored<T>(read: () => T): T {
    try { return read(); } catch (error) {
      if (error instanceof AppError) throw error;
      throw corruptData(error);
    }
  }

  // Enregistre la collecte et ses alertes dans l’historique.
  saveCycle(result: CycleResult): number {
    this.assertOpen();
    try {
      const insertRun = this.database.prepare(`
        INSERT INTO collection_runs
          (started_at, finished_at, collected_count, rejected_count, skipped_count, errors_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const upsertMatch = this.database.prepare(`
        INSERT INTO matches (id, home_team, away_team, competition, starts_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          home_team = excluded.home_team,
          away_team = excluded.away_team,
          competition = excluded.competition,
          starts_at = excluded.starts_at
      `);
      const insertSnapshot = this.database.prepare(`
        INSERT INTO odds_snapshots
          (run_id, event_id, source, source_match_id, home_team, away_team,
           competition, starts_at, collected_at, home_odd, draw_odd, away_odd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertAlert = this.database.prepare(`
        INSERT INTO alerts
          (run_id, event_id, home_team, away_team, competition, starts_at,
           collected_at, outcome, min_odd, max_odd, min_source, max_source,
           absolute_difference, percentage_difference)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this.database.exec("BEGIN IMMEDIATE");
      const runId = Number(insertRun.run(
        result.startedAt,
        result.finishedAt,
        result.collectedCount,
        result.rejectedCount,
        result.skippedCount,
        JSON.stringify(result.errors.map((error) => ({ source: redactSecrets(error.source), message: safeErrorMessage(error.message) }))),
      ).lastInsertRowid);

      for (const event of result.events) {
        upsertMatch.run(event.id, event.homeTeam, event.awayTeam, event.competition, event.startsAt);
        for (const quote of event.quotes) {
          // Conserve les noms d’origine dans chaque relevé.
          insertSnapshot.run(
            runId, event.id, quote.source, quote.sourceMatchId,
            quote.homeTeam, quote.awayTeam, quote.competition, quote.startsAt,
            quote.collectedAt, quote.odds["1"], quote.odds.X, quote.odds["2"],
          );
        }
      }

      for (const alert of result.alerts) {
        insertAlert.run(
          runId, alert.eventId, alert.homeTeam, alert.awayTeam, alert.competition,
          alert.startsAt, result.finishedAt, alert.outcome, alert.minOdd,
          alert.maxOdd, alert.minSource, alert.maxSource,
          alert.absoluteDifference, alert.percentageDifference,
        );
      }

      this.database.exec("COMMIT");
      return runId;
    } catch (error) {
      this.rollbackSafely();
      throw databaseError(error, "write");
    }
  }

  // Retrouve les derniers relevés de cotes enregistrés.
  getHistory(limit = 50, sources?: readonly string[]): HistoryEntry[] {
    validateLimit(limit);
    this.assertOpen();
    try {
      const where = sources === undefined ? "" : sources.length ? `WHERE source IN (${sources.map(() => "?").join(",")})` : "WHERE 0";
      return this.database.prepare(`
        SELECT * FROM odds_snapshots ${where} ORDER BY collected_at DESC, id DESC LIMIT ?
      `).all(...(sources ?? []), limit).map((row) => this.readStored(() => readHistory(row)));
    } catch (error) {
      throw databaseError(error, "read");
    }
  }

  // Retrouve la dernière collecte enregistrée.
  getLatestCycle(): CycleResult | null {
    this.assertOpen();
    // Lit les résultats d’une même collecte ensemble.
    try {
      this.database.exec("BEGIN");
      const run = this.database.prepare("SELECT * FROM collection_runs ORDER BY id DESC LIMIT 1").get();
      if (!run) {
        this.database.exec("COMMIT");
        return null;
      }

      const runId = this.readStored(() => storedNumber(run.id, "run_id", 1, true));
      const rows = this.database.prepare(`
        SELECT snapshots.*,
          matches.home_team AS event_home_team,
          matches.away_team AS event_away_team,
          matches.competition AS event_competition,
          matches.starts_at AS event_starts_at
        FROM odds_snapshots AS snapshots
        LEFT JOIN matches ON matches.id = snapshots.event_id
        WHERE snapshots.run_id = ?
        ORDER BY snapshots.id ASC
      `).all(runId);
      const events = new Map<string, MatchedEvent>();
      for (const row of rows) {
        const history = this.readStored(() => readHistory(row));
        const eventId = history.eventId;
        let event = events.get(eventId);
        if (!event) {
          event = this.readStored(() => ({
            id: eventId,
            homeTeam: storedText(row.event_home_team, "event_home_team"),
            awayTeam: storedText(row.event_away_team, "event_away_team"),
            competition: storedText(row.event_competition, "event_competition"),
            startsAt: storedTimestamp(row.event_starts_at, "event_starts_at"),
            quotes: [],
          }));
          this.readStored(() => normalizeMatch({ ...history, ...event }, history.source, new Date(history.collectedAt)));
          events.set(eventId, event);
        }
        const { runId: _runId, eventId: _eventId, ...raw } = history;
        const collectedAt = history.collectedAt;
        event.quotes.push({
          ...normalizeMatch(raw, history.source, new Date(collectedAt)),
          ...raw,
          collectedAt,
        });
      }

      const alerts = this.database.prepare("SELECT * FROM alerts WHERE run_id = ? ORDER BY id ASC")
        .all(runId).map((row) => this.readStored(() => readAlert(row)));
      const result: CycleResult = this.readStored(() => ({
        startedAt: storedTimestamp(run.started_at, "started_at"),
        finishedAt: storedTimestamp(run.finished_at, "finished_at"),
        events: [...events.values()],
        alerts,
        errors: readErrors(run.errors_json),
        collectedCount: storedNumber(run.collected_count, "collected_count", 0, true),
        rejectedCount: storedNumber(run.rejected_count, "rejected_count", 0, true),
        skippedCount: storedNumber(run.skipped_count, "skipped_count", 0, true),
      }));
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.rollbackSafely();
      throw databaseError(error, "read");
    }
  }

  // Retrouve les dernières alertes enregistrées.
  getAlerts(limit = 50, sources?: readonly string[]): StoredAlert[] {
    validateLimit(limit);
    this.assertOpen();
    try {
      const placeholders = sources?.map(() => "?").join(",");
      const where = sources === undefined ? "" : sources.length ?
        `WHERE min_source IN (${placeholders}) AND max_source IN (${placeholders})` : "WHERE 0";
      return this.database.prepare(`
        SELECT * FROM alerts ${where} ORDER BY collected_at DESC, id DESC LIMIT ?
      `).all(...(sources ?? []), ...(sources ?? []), limit).map((row) => this.readStored(() => ({
        runId: storedNumber(row.run_id, "run_id", 1, true),
        collectedAt: storedTimestamp(row.collected_at, "collected_at"),
        ...readAlert(row),
      })));
    } catch (error) {
      throw databaseError(error, "read");
    }
  }

  // Ferme proprement le fichier de l’historique.
  close(): void {
    if (!this.closed) {
      try {
        if (this.database.isOpen) this.database.close();
        this.closed = true;
      } catch (error) {
        throw databaseError(error, "close");
      }
    }
  }
}
