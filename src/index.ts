import { readConfig } from "./config.js";
import { loadEnvironment } from "./environment.js";
import { AppError, logError } from "./errors.js";
import { createCollectors } from "./collectors/index.js";
import { OddsDatabase } from "./database/sqlite.js";
import { printAlerts, printCycle, printHistory } from "./report.js";
import { runScheduler } from "./scheduler.js";
import { installFatalHandlers } from "./runtime.js";
import { collectCycle } from "./services/collectCycle.js";

const HELP = `Comparateur de cotes 1X2 — 1xBet, Bet261, Pinnacle ou données JSON locales

  npm run web                   Interface web locale sur le port 3000
  npm run demo                  Une collecte et affichage des écarts
  npm run watch                 Collecte immédiate puis toutes les 10 minutes
  npm run history -- --limit 20  Dernières observations enregistrées
  npm run alerts -- --limit 20   Dernières alertes enregistrées
  npm run build                 Compilation TypeScript
  npm start -- --once            Exécution compilée, une seule collecte

Options : --once, --watch (défaut), --history, --alerts, --limit N, --mock, --help
Configuration : .env (voir .env.example). --mock force les données d'exemple.
`;

// Lit les options choisies au lancement.
function parseArguments(args: string[]): { command: string; limit: number; forceMock: boolean } {
  let command = "--watch";
  let selected = false;
  let limit = 50;
  let forceMock = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--mock") {
      forceMock = true;
    } else if (arg === "--limit") {
      const raw = args[++index];
      if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 10_000) {
        throw new AppError("CLI_USAGE", "--limit doit être un entier entre 1 et 10000.");
      }
      limit = Number(raw);
    } else if (["--once", "--watch", "--history", "--alerts", "--help"].includes(arg ?? "")) {
      if (selected) throw new AppError("CLI_USAGE", "Choisissez une seule commande parmi --once, --watch, --history, --alerts, --help.");
      command = arg!;
      selected = true;
    } else {
      throw new AppError("CLI_USAGE", "Option inconnue. Utilisez --help.");
    }
  }
  return { command, limit, forceMock };
}

// Lance l’action demandée depuis le terminal.
async function main(): Promise<void> {
  const { command, limit, forceMock } = parseArguments(process.argv.slice(2));
  if (command === "--help") {
    console.log(HELP);
    return;
  }
  const explicitDatabasePath = process.env.DATABASE_PATH;
  loadEnvironment();
  const config = readConfig(forceMock ? {
    ...process.env, DATA_SOURCE: "mock", DATABASE_PATH: explicitDatabasePath ?? "./data/odds.sqlite",
  } : process.env);
  const database = new OddsDatabase(config.databasePath);
  const shutdown = new AbortController();
  const removeFatalHandlers = installFatalHandlers(() => {
    shutdown.abort();
    database.close();
  });
  const stop = () => {
    if (!shutdown.signal.aborted) console.log("\nArrêt demandé.");
    shutdown.abort();
  };
  try {
    if (command === "--history") {
      printHistory(database.getHistory(limit));
      return;
    }
    if (command === "--alerts") {
      printAlerts(database.getAlerts(limit));
      return;
    }
    console.log(config.dataSource === "odds-api" ?
      `Mode réel — 1xBet et Pinnacle via The Odds API${config.bet261Enabled ? " + Bet261 via son site public" : ""} (${config.oddsApiSports.join(", ")}).` :
      "Mode exemple — sources JSON locales.");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const task = async () => {
      // Recherche à nouveau les fichiers pour permettre une reprise.
      const collectors = await createCollectors(config);
      const result = await collectCycle({ ...config, collectors, database, signal: shutdown.signal });
      printCycle(result, config.threshold);
      if (command === "--once" && result.collectedCount === 0 && result.errors.length > 0) process.exitCode = 1;
    };
    if (command === "--once") await task();
    else {
      console.log(`Intervalle : ${config.intervalMs / 60_000} minute(s) après la fin de chaque collecte. Ctrl+C pour arrêter.`);
      await runScheduler(task, {
        intervalMs: config.intervalMs,
        signal: shutdown.signal,
        onError: (error) => {
          if (!shutdown.signal.aborted) logError("Échec du cycle :", error);
        },
      });
    }
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    removeFatalHandlers();
    try { database.close(); } catch (error) {
      logError("Erreur pendant la fermeture de l'historique :", error);
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  logError("Erreur :", error);
  process.exitCode = 1;
});
