import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createCollectors } from "../src/collectors/index.js";
import { JsonFileCollector } from "../src/collectors/mock.js";
import { OneXBetCollector } from "../src/collectors/oneXBet.js";
import { Bet261Collector } from "../src/collectors/bet261.js";
import { PinnacleCollector } from "../src/collectors/pinnacle.js";
import { readConfig } from "../src/config.js";

test("le mode réel active 1xBet, Bet261 et Pinnacle sans mélanger les sources d'exemple", async () => {
  const collectors = await createCollectors(readConfig({ DATA_SOURCE: "odds-api", ODDS_API_KEY: "test-key-not-real" }));
  assert.deepEqual(collectors.map((collector) => collector.name), ["1xbet", "bet261", "pinnacle"]);
  assert.ok(collectors[0] instanceof OneXBetCollector);
  assert.ok(collectors[1] instanceof Bet261Collector);
  assert.ok(collectors[2] instanceof PinnacleCollector);
});

test("Bet261 peut être désactivé sans modifier les autres collecteurs", async () => {
  const collectors = await createCollectors(readConfig({
    DATA_SOURCE: "odds-api", ODDS_API_KEY: "test-key-not-real", BET261_ENABLED: "false",
  }));
  assert.deepEqual(collectors.map((collector) => collector.name), ["1xbet", "pinnacle"]);
});

test("le mode mock reste disponible même avec une clé configurée", async () => {
  const collectors = await createCollectors(readConfig({
    DATA_SOURCE: "mock", ODDS_API_KEY: "test-key-not-real", MOCK_DATA_DIR: resolve("data/examples"),
  }));
  assert.deepEqual(collectors.map((collector) => collector.name), ["exemple-a", "exemple-b"]);
  assert.ok(collectors.every((collector) => collector instanceof JsonFileCollector));
});
