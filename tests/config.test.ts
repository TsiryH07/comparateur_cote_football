import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";

test("configuration par défaut : seuil 10 %, boucle 10 min, tolérance 15 min", () => {
  const config = readConfig({});
  assert.deepEqual(config.threshold, { mode: "percentage", value: 10 });
  assert.equal(config.intervalMs, 600_000);
  assert.equal(config.matchToleranceMinutes, 15);
  assert.equal(config.collectorTimeoutMs, 15_000);
  assert.match(config.databasePath, /odds\.sqlite$/);
  assert.equal(config.dataSource, "mock");
  assert.equal(config.oddsApiKey, "");
  assert.deepEqual(config.oddsApiSports, ["soccer_epl"]);
});

test("configure seuil absolu nul et boucle courte, utile pour expérimenter", () => {
  const config = readConfig({
    DATABASE_PATH: ":memory:", ODDS_THRESHOLD_MODE: "absolute", ODDS_THRESHOLD: "0",
    INTERVAL_MINUTES: "0.5", MATCH_TOLERANCE_MINUTES: "0", COLLECTOR_TIMEOUT_MS: "50",
  });
  assert.deepEqual(config.threshold, { mode: "absolute", value: 0 });
  assert.equal(config.databasePath, ":memory:");
  assert.equal(config.intervalMs, 30_000);
  assert.equal(config.matchToleranceMinutes, 0);
  assert.equal(config.collectorTimeoutMs, 50);
});

test("refuse les configurations invalides au lieu de démarrer avec des valeurs implicites", () => {
  const invalid = [
    { ODDS_THRESHOLD_MODE: "relative" }, { ODDS_THRESHOLD: "-1" }, { ODDS_THRESHOLD: "" },
    { ODDS_THRESHOLD: "NaN" }, { INTERVAL_MINUTES: "0" }, { INTERVAL_MINUTES: "Infinity" },
    { INTERVAL_MINUTES: "100000000" }, { MATCH_TOLERANCE_MINUTES: "-1" },
    { COLLECTOR_TIMEOUT_MS: "0.5" }, { COLLECTOR_TIMEOUT_MS: "0" },
    { DATABASE_PATH: " " }, { MOCK_DATA_DIR: "" },
  ];
  for (const env of invalid) assert.throws(() => readConfig(env), Error, JSON.stringify(env));
});

test("la présence d'une clé choisit le mode API, un choix mock explicite reste prioritaire", () => {
  const fakeKey = "fake-api-key-for-config-tests";
  const live = readConfig({ ODDS_API_KEY: `  ${fakeKey}  ` });
  assert.equal(live.dataSource, "odds-api");
  assert.equal(live.oddsApiKey, fakeKey);
  assert.deepEqual(live.oddsApiSports, ["soccer_epl"]);
  assert.match(live.databasePath, /odds-live\.sqlite$/);

  const mock = readConfig({ DATA_SOURCE: "mock", ODDS_API_KEY: fakeKey });
  assert.equal(mock.dataSource, "mock");
  assert.match(mock.databasePath, /odds\.sqlite$/);
  assert.notEqual(mock.databasePath, live.databasePath);
  assert.equal(readConfig({ ODDS_API_KEY: "   " }).dataSource, "mock");
});

test("refuse un mode inconnu ou un mode API sans clé", () => {
  for (const key of [undefined, "", "  "]) {
    assert.throws(() => readConfig({ DATA_SOURCE: "odds-api", ODDS_API_KEY: key }), /ODDS_API_KEY/);
  }
  for (const mode of ["", "api", "live", "MOCK"]) {
    assert.throws(() => readConfig({ DATA_SOURCE: mode }), /DATA_SOURCE/);
  }
});

test("nettoie et déduplique les sports tout en refusant les clés non football ou vides", () => {
  const config = readConfig({
    DATA_SOURCE: "mock",
    ODDS_API_SPORTS: " soccer_epl, soccer_france_ligue_one ,soccer_epl,soccer_uefa_champs_league",
  });
  assert.deepEqual(config.oddsApiSports, ["soccer_epl", "soccer_france_ligue_one", "soccer_uefa_champs_league"]);
  for (const sports of [
    "", " ", ",", "soccer_epl,", ",soccer_epl", "soccer_epl,,soccer_laliga",
    "basketball_nba", "soccer_EPL", "soccer_", "soccer_epl_", "soccer_epl?apiKey=fake",
  ]) {
    assert.throws(() => readConfig({ DATA_SOURCE: "mock", ODDS_API_SPORTS: sports }), /ODDS_API_SPORTS/);
  }
});

test("un chemin de base explicite remplace le défaut pour les deux modes", () => {
  assert.equal(readConfig({ DATA_SOURCE: "mock", DATABASE_PATH: ":memory:" }).databasePath, ":memory:");
  assert.equal(readConfig({
    DATA_SOURCE: "odds-api", ODDS_API_KEY: "fake-api-key-for-config-tests", DATABASE_PATH: ":memory:",
  }).databasePath, ":memory:");
});

test("Bet261 est activé par défaut en réel, avec une option booléenne explicite", () => {
  assert.equal(readConfig({}).bet261Enabled, true);
  assert.equal(readConfig({ BET261_ENABLED: "true" }).bet261Enabled, true);
  assert.equal(readConfig({ BET261_ENABLED: "false" }).bet261Enabled, false);
  for (const raw of ["", "yes", "1", "TRUE", "false "]) {
    assert.throws(() => readConfig({ BET261_ENABLED: raw }), /BET261_ENABLED/);
  }
});
