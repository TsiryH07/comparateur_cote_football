import { resolve } from "node:path";
import { AppError, safeErrorMessage } from "./errors.js";
import type { Threshold } from "./types.js";

export interface Config {
  dataSource: "mock" | "odds-api";
  // Cette clé reste privée.
  oddsApiKey: string;
  oddsApiSports: string[];
  bet261Enabled: boolean;
  databasePath: string;
  mockDataDir: string;
  threshold: Threshold;
  intervalMs: number;
  matchToleranceMinutes: number;
  collectorTimeoutMs: number;
}

// Vérifie une valeur numérique des réglages.
function numberSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, allowZero = false): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (raw?.trim() === "" || !Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${name} doit être un nombre ${allowZero ? "positif ou nul" : "strictement positif"}.`);
  }
  return value;
}

// Charge et vérifie les réglages du projet.
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    return parseConfig(env);
  } catch (cause) {
    throw new AppError("CONFIG_INVALID", safeErrorMessage(cause, "La configuration est invalide. Vérifiez .env."), { cause });
  }
}

// Prépare les réglages et leurs valeurs par défaut.
function parseConfig(env: NodeJS.ProcessEnv): Config {
  const oddsApiKey = env.ODDS_API_KEY?.trim() ?? "";
  const dataSource = env.DATA_SOURCE ?? (oddsApiKey ? "odds-api" : "mock");
  if (dataSource !== "mock" && dataSource !== "odds-api") {
    throw new Error("DATA_SOURCE doit valoir mock ou odds-api.");
  }
  if (dataSource === "odds-api" && !oddsApiKey) {
    throw new Error("ODDS_API_KEY doit être renseignée dans .env pour les données réelles.");
  }
  const oddsApiSports = [...new Set((env.ODDS_API_SPORTS ?? "soccer_epl").split(",").map((sport) => sport.trim()))];
  if (oddsApiSports.length === 0 || oddsApiSports.some((sport) => !/^soccer_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(sport))) {
    throw new Error("ODDS_API_SPORTS doit contenir des clés de football soccer_* séparées par des virgules.");
  }
  const bet261Setting = env.BET261_ENABLED ?? "true";
  if (bet261Setting !== "true" && bet261Setting !== "false") {
    throw new Error("BET261_ENABLED doit valoir true ou false.");
  }
  const mode = env.ODDS_THRESHOLD_MODE ?? "percentage";
  if (mode !== "absolute" && mode !== "percentage") {
    throw new Error("ODDS_THRESHOLD_MODE doit valoir percentage ou absolute.");
  }
  const intervalMs = Math.round(numberSetting(env, "INTERVAL_MINUTES", 10) * 60_000);
  const collectorTimeoutMs = numberSetting(env, "COLLECTOR_TIMEOUT_MS", 15_000);
  for (const [name, value] of [["INTERVAL_MINUTES (converti en ms)", intervalMs], ["COLLECTOR_TIMEOUT_MS", collectorTimeoutMs]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new Error(`${name} doit correspondre à un entier de 1 à 2147483647 ms.`);
    }
  }
  const databasePath = env.DATABASE_PATH ?? (dataSource === "odds-api" ? "./data/odds-live.sqlite" : "./data/odds.sqlite");
  const mockDataDir = env.MOCK_DATA_DIR ?? "./data/examples";
  if (!databasePath.trim() || !mockDataDir.trim()) {
    throw new Error("DATABASE_PATH et MOCK_DATA_DIR ne doivent pas être vides.");
  }
  return {
    dataSource,
    oddsApiKey,
    oddsApiSports,
    bet261Enabled: bet261Setting === "true",
    databasePath: databasePath === ":memory:" ? databasePath : resolve(databasePath),
    mockDataDir: resolve(mockDataDir),
    threshold: { mode, value: numberSetting(env, "ODDS_THRESHOLD", 10, true) },
    intervalMs,
    matchToleranceMinutes: numberSetting(env, "MATCH_TOLERANCE_MINUTES", 15, true),
    collectorTimeoutMs,
  };
}
