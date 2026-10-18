import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { OddsDatabase } from "../src/database/sqlite.js";
import { AppError } from "../src/errors.js";
import type { CycleResult, MatchedEvent, NormalizedMatch } from "../src/types.js";

const firstCollectedAt = "2026-10-17T10:00:00.000Z";
const secondCollectedAt = "2026-10-17T10:10:00.000Z";

// Prépare un exemple de match pour les tests.
function quote(source: string, collectedAt: string): NormalizedMatch {
  return {
    source,
    sourceMatchId: `${source}-123`,
    homeTeam: "Paris SG",
    awayTeam: "Marseille",
    competition: "Ligue 1",
    startsAt: "2026-10-18T19:00:00.000Z",
    odds: { "1": 1.5, X: 3.2, "2": 5.5 },
    normalizedHomeTeam: "paris saint germain",
    normalizedAwayTeam: "marseille",
    normalizedCompetition: "ligue 1",
    collectedAt,
  };
}

// Prépare un exemple de collecte.
function cycle(collectedAt = firstCollectedAt): CycleResult {
  const event: MatchedEvent = {
    id: "paris-marseille-20261018",
    homeTeam: "Paris SG",
    awayTeam: "Marseille",
    competition: "Ligue 1",
    startsAt: "2026-10-18T19:00:00.000Z",
    quotes: [quote("exemple-a", collectedAt), quote("exemple-b", collectedAt)],
  };
  event.quotes[1]!.odds["1"] = 1.8;
  return {
    startedAt: collectedAt,
    finishedAt: collectedAt,
    events: [event],
    alerts: [{
      eventId: event.id,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      competition: event.competition,
      startsAt: event.startsAt,
      outcome: "1",
      minOdd: 1.5,
      maxOdd: 1.8,
      minSource: "exemple-a",
      maxSource: "exemple-b",
      absoluteDifference: 0.3,
      percentageDifference: 20,
    }],
    errors: [],
    rejectedCount: 0,
    skippedCount: 0,
    collectedCount: 2,
  };
}

test("conserve deux collectes identiques, toutes les cotes et leurs dates", () => {
  const database = new OddsDatabase(":memory:");
  try {
    const first = cycle();
    const second = cycle(secondCollectedAt);
    const firstRun = database.saveCycle(first);
    const secondRun = database.saveCycle(second);
    assert.notEqual(firstRun, secondRun);
    const history = database.getHistory();
    assert.equal(history.length, 4);
    assert.deepEqual(history.map((row) => row.runId), [secondRun, secondRun, firstRun, firstRun]);
    assert.deepEqual(history[0], {
      runId: secondRun,
      eventId: second.events[0]!.id,
      homeTeam: "Paris SG",
      awayTeam: "Marseille",
      competition: "Ligue 1",
      startsAt: "2026-10-18T19:00:00.000Z",
      source: "exemple-b",
      sourceMatchId: "exemple-b-123",
      collectedAt: secondCollectedAt,
      odds: { "1": 1.8, X: 3.2, "2": 5.5 },
    });
    assert.deepEqual(database.getHistory(1), history.slice(0, 1));
    assert.deepEqual(database.getAlerts(), [
      { ...second.alerts[0]!, runId: secondRun, collectedAt: second.finishedAt },
      { ...first.alerts[0]!, runId: firstRun, collectedAt: first.finishedAt },
    ]);
    assert.equal(database.getAlerts(1).length, 1);
  } finally {
    database.close();
  }
});

test("stocke une troisième source et un match sans rapprochement", () => {
  const database = new OddsDatabase(":memory:");
  try {
    const result = cycle();
    result.events[0]!.quotes.push(quote("troisieme-source", firstCollectedAt));
    result.events.push({
      id: "match-isole",
      homeTeam: "Nice",
      awayTeam: "Lyon",
      competition: "Ligue 1",
      startsAt: "2026-10-18T17:00:00.000Z",
      quotes: [{
        ...quote("troisieme-source", firstCollectedAt),
        sourceMatchId: "isole-42",
        homeTeam: "Nice",
        awayTeam: "Lyon",
        startsAt: "2026-10-18T17:00:00.000Z",
      }],
    });
    result.collectedCount = 4;
    database.saveCycle(result);
    const history = database.getHistory();
    assert.equal(history.length, 4);
    assert.equal(history.filter((row) => row.source === "troisieme-source").length, 2);
    assert.equal(history.find((row) => row.eventId === "match-isole")?.homeTeam, "Nice");
  } finally {
    database.close();
  }
});

test("annule tout le cycle en cas d'erreur et accepte ensuite une nouvelle collecte", () => {
  const directory = mkdtempSync(join(tmpdir(), "odds-rollback-"));
  const path = join(directory, "odds.sqlite");
  const database = new OddsDatabase(path);
  let inspection: DatabaseSync | undefined;
  try {
    database.saveCycle(cycle());
    const invalid = cycle(secondCollectedAt);
    invalid.events[0]!.homeTeam = "Métadonnée à annuler";
    invalid.alerts[0]!.eventId = "evenement-inexistant";
    assert.throws(() => database.saveCycle(invalid), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "DATABASE_WRITE_FAILED");
      assert.match(String(error.cause), /FOREIGN KEY/i);
      assert.doesNotMatch(error.message, /FOREIGN KEY|INSERT|SELECT/i);
      return true;
    });
    assert.equal(database.getHistory().length, 2);
    assert.equal(database.getAlerts().length, 1);
    inspection = new DatabaseSync(path, { readOnly: true });
    assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM collection_runs").get()?.count, 1);
    assert.equal(inspection.prepare("SELECT home_team FROM matches").get()?.home_team, "Paris SG");
    database.saveCycle(cycle(secondCollectedAt));
    assert.equal(database.getHistory().length, 4);
  } finally {
    inspection?.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persiste les données et les erreurs après réouverture, crée le répertoire", () => {
  const directory = mkdtempSync(join(tmpdir(), "odds-persistence-"));
  const path = join(directory, "nested", "odds.sqlite");
  let database: OddsDatabase | undefined;
  let inspection: DatabaseSync | undefined;
  try {
    database = new OddsDatabase(path);
    const result = cycle();
    result.events[0]!.quotes[0]!.homeTeam = "Paris ' Saint-Germain; DROP TABLE matches; --";
    result.errors = [{ source: "source-hors-service", message: "Temps d'attente dépassé" }];
    result.rejectedCount = 2;
    result.skippedCount = 3;
    const runId = database.saveCycle(result);
    database.close();
    database.close();
    database = new OddsDatabase(path);
    assert.equal(database.getHistory().length, 2);
    assert.equal(database.getHistory()[1]!.homeTeam, result.events[0]!.quotes[0]!.homeTeam);
    assert.equal(database.getAlerts()[0]!.runId, runId);
    inspection = new DatabaseSync(path, { readOnly: true });
    const storedRun = inspection.prepare("SELECT * FROM collection_runs WHERE id = ?").get(runId)!;
    assert.equal(storedRun.collected_count, 2);
    assert.equal(storedRun.rejected_count, 2);
    assert.equal(storedRun.skipped_count, 3);
    assert.deepEqual(JSON.parse(String(storedRun.errors_json)), result.errors);
    assert.equal(storedRun.started_at, firstCollectedAt);
    assert.equal(storedRun.finished_at, firstCollectedAt);
  } finally {
    inspection?.close();
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("conserve les anciens noms même quand les métadonnées du match changent", () => {
  const database = new OddsDatabase(":memory:");
  try {
    database.saveCycle(cycle());
    const second = cycle(secondCollectedAt);
    second.events[0]!.homeTeam = "Paris Saint-Germain";
    second.events[0]!.quotes[0]!.homeTeam = "Paris Saint-Germain";
    database.saveCycle(second);
    const history = database.getHistory();
    assert.equal(history.find((row) => row.collectedAt === firstCollectedAt)?.homeTeam, "Paris SG");
    assert.equal(history.find((row) => row.collectedAt === secondCollectedAt && row.source === "exemple-a")?.homeTeam,
      "Paris Saint-Germain");
  } finally {
    database.close();
  }
});

test("valide les limites et enregistre aussi un cycle entièrement en erreur", () => {
  const database = new OddsDatabase(":memory:");
  try {
    for (const limit of [0, -1, 1.2, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => database.getHistory(limit), RangeError);
      assert.throws(() => database.getAlerts(limit), RangeError);
    }
    const result = cycle();
    result.events = [];
    result.alerts = [];
    result.collectedCount = 0;
    result.errors = [{ source: "exemple-a", message: "Source indisponible" }];
    assert.ok(database.saveCycle(result) > 0);
    assert.deepEqual(database.getHistory(), []);
    assert.deepEqual(database.getAlerts(), []);
  } finally {
    database.close();
  }
});

test("renvoie null sans collecte puis reconstruit seulement le dernier cycle complet", () => {
  const database = new OddsDatabase(":memory:");
  try {
    assert.equal(database.getLatestCycle(), null);
    const first = cycle();
    database.saveCycle(first);
    assert.deepEqual(database.getLatestCycle(), first);

    const second = cycle(secondCollectedAt);
    second.finishedAt = "2026-10-17T10:10:05.000Z";
    second.errors = [{ source: "source-c", message: "Lecture impossible" }];
    second.rejectedCount = 3;
    second.skippedCount = 4;
    second.events[0]!.homeTeam = "Paris Saint-Germain";
    second.events[0]!.quotes[0]!.homeTeam = "PSG";
    second.events[0]!.quotes[1]!.odds.X = 4.1;
    second.events.push({
      id: "match-sans-correspondance",
      homeTeam: "Nice",
      awayTeam: "Lyon",
      competition: "Ligue 1",
      startsAt: "2026-10-18T15:00:00.000Z",
      quotes: [{
        ...quote("source-c", secondCollectedAt),
        sourceMatchId: "nice-lyon",
        homeTeam: "Nice",
        awayTeam: "Lyon",
        normalizedHomeTeam: "nice",
        normalizedAwayTeam: "lyon",
        startsAt: "2026-10-18T15:00:00.000Z",
      }],
    });
    second.collectedCount = 3;
    database.saveCycle(second);
    assert.deepEqual(database.getLatestCycle(), second);
    assert.equal(database.getHistory().length, 5);
  } finally {
    database.close();
  }
});

test("renvoie le dernier cycle vide en erreur au lieu des observations précédentes", () => {
  const database = new OddsDatabase(":memory:");
  try {
    database.saveCycle(cycle());
    const failure: CycleResult = {
      startedAt: secondCollectedAt,
      finishedAt: "2026-10-17T10:10:15.000Z",
      events: [],
      alerts: [],
      errors: [{ source: "exemple-a", message: "Délai dépassé" }],
      collectedCount: 0,
      rejectedCount: 1,
      skippedCount: 2,
    };
    database.saveCycle(failure);
    assert.deepEqual(database.getLatestCycle(), failure);
    assert.equal(database.getHistory().length, 2);
  } finally {
    database.close();
  }
});

test("restitue toutes les observations et alertes du dernier cycle sans limite de 50", () => {
  const database = new OddsDatabase(":memory:");
  try {
    const result = cycle();
    const prototype = result.events[0]!;
    const alertPrototype = result.alerts[0]!;
    result.events = Array.from({ length: 60 }, (_, index) => ({
      ...prototype,
      id: `evenement-${index}`,
      quotes: prototype.quotes.map((item) => ({ ...item, sourceMatchId: `${item.source}-${index}` })),
    }));
    result.alerts = result.events.map((event) => ({ ...alertPrototype, eventId: event.id }));
    result.collectedCount = 120;
    database.saveCycle(result);
    const latest = database.getLatestCycle();
    assert.equal(latest?.events.length, 60);
    assert.equal(latest?.events.flatMap((event) => event.quotes).length, 120);
    assert.equal(latest?.alerts.length, 60);
    assert.deepEqual(latest, result);
    assert.equal(database.getHistory().length, 50);
    assert.equal(database.getAlerts().length, 50);
  } finally {
    database.close();
  }
});

test("relit les cycles ajoutés par une autre connexion sans cache ni réouverture", () => {
  const directory = mkdtempSync(join(tmpdir(), "odds-external-cycle-"));
  const path = join(directory, "odds.sqlite");
  const reader = new OddsDatabase(path);
  let writer: OddsDatabase | undefined;
  try {
    assert.equal(reader.getLatestCycle(), null);
    writer = new OddsDatabase(path);
    writer.saveCycle(cycle());
    assert.deepEqual(reader.getLatestCycle(), cycle());
    const latest = cycle(secondCollectedAt);
    latest.events[0]!.quotes[0]!.odds["2"] = 6.7;
    // Latest means the last inserted cycle, even if its clock is older.
    latest.startedAt = "2026-10-16T23:00:00.000Z";
    latest.finishedAt = "2026-10-16T23:00:01.000Z";
    writer.saveCycle(latest);
    assert.deepEqual(reader.getLatestCycle(), latest);
  } finally {
    writer?.close();
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// Prépare les éléments nécessaires au test.
function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0);
    return true;
  };
}

// Prépare un historique pour les tests.
function nativeConnection(database: OddsDatabase): DatabaseSync {
  return (database as unknown as { database: DatabaseSync }).database;
}

test("signale un chemin impossible et conserve intégralement un fichier qui n’est pas SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "odds-open-errors-"));
  try {
    const path = join(directory, "not-a-database.txt");
    const original = "Contenu important à conserver : ceci n’est pas une base SQLite.";
    writeFileSync(path, original, "utf8");
    assert.throws(() => new OddsDatabase(path), hasCode("DATABASE_CORRUPT"));
    assert.equal(readFileSync(path, "utf8"), original);
    assert.throws(() => new OddsDatabase(join(path, "odds.sqlite")), hasCode("DATABASE_OPEN_FAILED"));
    assert.equal(readFileSync(path, "utf8"), original);
    assert.throws(() => new OddsDatabase(""), hasCode("DATABASE_OPEN_FAILED"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuse clairement toute lecture ou écriture après une fermeture idempotente", () => {
  const database = new OddsDatabase(":memory:");
  database.close();
  database.close();
  for (const operation of [
    () => database.getHistory(), () => database.getAlerts(),
    () => database.getLatestCycle(), () => database.saveCycle(cycle()),
  ]) assert.throws(operation, hasCode("DATABASE_CLOSED"));
});

test("signale un verrou d’écriture et reprend sans aucune collecte partiellement enregistrée", () => {
  const directory = mkdtempSync(join(tmpdir(), "odds-busy-"));
  const path = join(directory, "odds.sqlite");
  const database = new OddsDatabase(path);
  const other = new DatabaseSync(path);
  try {
    database.saveCycle(cycle());
    other.exec("BEGIN IMMEDIATE");
    assert.throws(() => database.saveCycle(cycle(secondCollectedAt)), hasCode("DATABASE_BUSY"));
    assert.equal(database.getHistory().length, 2);
    other.exec("ROLLBACK");
    database.saveCycle(cycle(secondCollectedAt));
    assert.equal(database.getHistory().length, 4);
  } finally {
    if (other.isTransaction) other.exec("ROLLBACK");
    other.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("préserve l’échec initial lorsque SQLite a déjà annulé automatiquement la transaction", () => {
  const database = new OddsDatabase(":memory:");
  const native = nativeConnection(database);
  try {
    database.saveCycle(cycle());
    native.exec(`CREATE TRIGGER reject_snapshot BEFORE INSERT ON odds_snapshots
      BEGIN SELECT RAISE(ROLLBACK, 'snapshot rejeté par le stockage'); END;`);
    assert.throws(() => database.saveCycle(cycle(secondCollectedAt)), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "DATABASE_WRITE_FAILED");
      assert.match(String(error.cause), /snapshot rejeté par le stockage/);
      assert.doesNotMatch(String(error.cause), /cannot rollback/);
      return true;
    });
    assert.equal(database.getHistory().length, 2);
    assert.equal(native.prepare("SELECT COUNT(*) AS count FROM collection_runs").get()?.count, 1);
    native.exec("DROP TRIGGER reject_snapshot");
    database.saveCycle(cycle(secondCollectedAt));
    assert.equal(database.getHistory().length, 4);
  } finally {
    database.close();
  }
});

test("identifie une limite de taille SQLite sans masquer l’erreur ni conserver une transaction incomplète", () => {
  const database = new OddsDatabase(":memory:");
  const native = nativeConnection(database);
  try {
    database.saveCycle(cycle());
    const pages = Number(native.prepare("PRAGMA page_count").get()?.page_count);
    native.exec(`PRAGMA max_page_count = ${pages}`);
    const oversized = cycle(secondCollectedAt);
    oversized.events[0]!.quotes[0]!.homeTeam = "A".repeat(128 * 1024);
    assert.throws(() => database.saveCycle(oversized), hasCode("DATABASE_FULL"));
    assert.equal(native.isTransaction, false);
    assert.equal(database.getHistory().length, 2);
    assert.equal(native.prepare("SELECT COUNT(*) AS count FROM collection_runs").get()?.count, 1);
    native.exec("PRAGMA max_page_count = 1073741823");
    database.saveCycle(cycle(secondCollectedAt));
    assert.equal(database.getHistory().length, 4);
  } finally {
    database.close();
  }
});

test("signale un stockage en lecture seule et permet la reprise après rétablissement des écritures", () => {
  const database = new OddsDatabase(":memory:");
  const native = nativeConnection(database);
  try {
    database.saveCycle(cycle());
    native.exec("PRAGMA query_only = ON");
    assert.throws(() => database.saveCycle(cycle(secondCollectedAt)), hasCode("DATABASE_WRITE_FAILED"));
    assert.equal(database.getHistory().length, 2);
    native.exec("PRAGMA query_only = OFF");
    database.saveCycle(cycle(secondCollectedAt));
    assert.equal(database.getHistory().length, 4);
  } finally {
    database.close();
  }
});

test("refuse un JSON d’erreurs invalide et annule la lecture pour permettre les opérations suivantes", () => {
  const database = new OddsDatabase(":memory:");
  const native = nativeConnection(database);
  try {
    database.saveCycle(cycle());
    for (const malformed of ["pas du JSON confidentiel", "null", "{}", '[{"source":42,"message":"échec"}]']) {
      native.prepare("UPDATE collection_runs SET errors_json = ?").run(malformed);
      assert.throws(() => database.getLatestCycle(), (error: unknown) => {
        hasCode("DATABASE_CORRUPT")(error);
        assert.doesNotMatch((error as AppError).message, /confidentiel|JSON|SELECT/);
        return true;
      });
      assert.equal(native.isTransaction, false);
      assert.equal(database.getHistory().length, 2);
    }
    native.exec("UPDATE collection_runs SET errors_json = '[]'");
    assert.deepEqual(database.getLatestCycle(), cycle());
  } finally {
    database.close();
  }
});

test("refuse les cotes et les alertes persistées invalides sans renvoyer de nombres incohérents", () => {
  const database = new OddsDatabase(":memory:");
  const native = nativeConnection(database);
  try {
    database.saveCycle(cycle());
    native.exec("PRAGMA ignore_check_constraints = ON; UPDATE odds_snapshots SET home_odd = 0.9 WHERE source = 'exemple-a'");
    assert.throws(() => database.getHistory(), hasCode("DATABASE_CORRUPT"));
    assert.throws(() => database.getLatestCycle(), hasCode("DATABASE_CORRUPT"));
    native.exec("UPDATE odds_snapshots SET home_odd = 1.5 WHERE source = 'exemple-a'; UPDATE alerts SET outcome = 'Z'");
    assert.throws(() => database.getAlerts(), hasCode("DATABASE_CORRUPT"));
    assert.throws(() => database.getLatestCycle(), hasCode("DATABASE_CORRUPT"));
    native.exec("UPDATE alerts SET outcome = '1'");
    assert.deepEqual(database.getLatestCycle(), cycle());
    native.exec("UPDATE collection_runs SET started_at = '2026-02-30T10:00:00.000Z'");
    assert.throws(() => database.getLatestCycle(), hasCode("DATABASE_CORRUPT"));
    assert.equal(native.isTransaction, false);
  } finally {
    database.close();
  }
});

test("diagnostique une erreur de lecture ou de préparation sans exposer la requête SQL", () => {
  const database = new OddsDatabase(":memory:");
  const native = nativeConnection(database);
  try {
    native.exec("DROP TABLE alerts");
    assert.throws(() => database.getAlerts(), hasCode("DATABASE_READ_FAILED"));
    assert.throws(() => database.saveCycle(cycle()), hasCode("DATABASE_WRITE_FAILED"));
    assert.equal(native.isTransaction, false);
    assert.deepEqual(database.getHistory(), []);
  } finally {
    database.close();
  }
});

test("masque les secrets des erreurs avant stockage et lors de la relecture d'un ancien cycle", () => {
  const database = new OddsDatabase(":memory:");
  const native = nativeConnection(database);
  try {
    const result = cycle();
    result.errors = [{ source: "provider", message: "Connexion impossible apiKey=fake-storage-secret" }];
    database.saveCycle(result);
    const stored = native.prepare("SELECT errors_json FROM collection_runs").get()!;
    assert.equal(String(stored.errors_json).includes("fake-storage-secret"), false);
    native.prepare("UPDATE collection_runs SET errors_json = ?").run(JSON.stringify([
      { source: "provider", message: "Ancienne erreur ?access_token=fake-legacy-token&ok=1" },
    ]));
    const latest = database.getLatestCycle()!;
    assert.equal(latest.errors[0]!.message.includes("fake-legacy-token"), false);
    assert.ok(latest.errors[0]!.message.includes("ok=1"));
  } finally { database.close(); }
});
