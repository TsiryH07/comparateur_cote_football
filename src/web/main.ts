import { readConfig } from "../config.js";
import { loadEnvironment } from "../environment.js";
import { AppError, logError, safeErrorMessage } from "../errors.js";
import { OddsDatabase } from "../database/sqlite.js";
import { installFatalHandlers } from "../runtime.js";
import { createDashboardServer } from "./server.js";

// Explique pourquoi l’interface ne peut pas démarrer.
function listenError(cause: unknown, port: number): AppError {
  const code = (cause as NodeJS.ErrnoException)?.code;
  if (code === "EADDRINUSE") return new AppError("WEB_PORT_IN_USE",
    `Le port ${port} est déjà utilisé. Arrêtez l'autre instance ou changez WEB_PORT dans .env.`, { cause });
  if (code === "EACCES" || code === "EPERM") return new AppError("WEB_PORT_FORBIDDEN",
    `L'accès au port ${port} est refusé. Choisissez un autre WEB_PORT dans .env.`, { cause });
  return new AppError("WEB_START_FAILED", "Impossible de démarrer le serveur local. Vérifiez le port et les droits d'accès.", { cause });
}

// Démarre l’interface et prépare son arrêt.
async function main(): Promise<void> {
  loadEnvironment();
  const rawPort = process.env.WEB_PORT ?? "3000";
  if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(Number(rawPort)) || Number(rawPort) > 65_535) {
    throw new AppError("CONFIG_INVALID", "WEB_PORT doit être un entier entre 0 et 65535.");
  }
  const config = readConfig();
  const database = new OddsDatabase(config.databasePath);
  let dashboard: ReturnType<typeof createDashboardServer>;
  try {
    dashboard = createDashboardServer({ config, database, onError: (error) => logError("Erreur du service :", error) });
  } catch (error) {
    try { database.close(); } catch (closeError) { logError("Fermeture de l'historique :", closeError); }
    throw error;
  }
  let stopping: Promise<void> | undefined;
  let listening = false;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      try { await dashboard.close(); }
      finally {
        try { database.close(); }
        finally {
          process.removeListener("SIGINT", requestStop);
          process.removeListener("SIGTERM", requestStop);
          dashboard.server.removeListener("error", serverError);
          removeFatalHandlers();
        }
      }
    })().catch((error: unknown) => {
      logError("Erreur pendant l'arrêt :", error);
      process.exitCode = 1;
    });
    return stopping;
  };
  const requestStop = () => { void stop(); };
  const serverError = (error: Error) => {
    if (!listening || stopping) return;
    process.exitCode = 1;
    logError("Arrêt du serveur :", new AppError("WEB_SERVER_FAILED",
      "Le serveur local a rencontré une erreur. Relancez le programme.", { cause: error }));
    void stop();
  };
  const removeFatalHandlers = installFatalHandlers(stop);
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  dashboard.server.on("error", serverError);
  try {
    await new Promise<void>((resolveListen, reject) => {
      const onError = (cause: Error) => reject(listenError(cause, Number(rawPort)));
      dashboard.server.once("error", onError);
      dashboard.server.listen(Number(rawPort), "127.0.0.1", () => {
        dashboard.server.removeListener("error", onError);
        listening = true;
        resolveListen();
      });
    });
    if (stopping) return;
    const address = dashboard.server.address();
    if (!address || typeof address === "string") throw new AppError("WEB_START_FAILED", "Adresse HTTP locale indisponible.");
    console.log(`Interface locale : http://127.0.0.1:${address.port}`);
    console.log(config.dataSource === "odds-api" ?
      `Cotes 1xBet et Pinnacle via The Odds API${config.bet261Enabled ? " et Bet261 via son site public" : ""}. Ctrl+C pour arrêter.` :
      "Données JSON d'exemple uniquement. Ctrl+C pour arrêter.");
    try {
      const state = await dashboard.collect();
      for (const error of state.latestCycle?.errors ?? []) console.warn(`[${error.source}] ${safeErrorMessage(error.message)}`);
    } catch (error) {
      if (!stopping) logError("Échec de la collecte initiale ; une nouvelle tentative aura lieu au prochain cycle :", error);
    }
  } catch (error) {
    await stop();
    throw error;
  }
}

main().catch((error: unknown) => {
  logError("Erreur :", error);
  process.exitCode = 1;
});
