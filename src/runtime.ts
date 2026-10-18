import { logError } from "./errors.js";

// Prépare l’arrêt du programme en cas de panne.
export function installFatalHandlers(cleanup: () => void | Promise<void>): () => void {
  let stopping = false;
  const fatal = (error: unknown) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = 1;
    logError("Arrêt après une erreur inattendue :", error);
    const deadline = setTimeout(() => process.exit(1), 5000);
    deadline.unref();
    void Promise.resolve().then(cleanup).catch((failure: unknown) => {
      logError("Erreur pendant l'arrêt :", failure);
    }).finally(() => {
      clearTimeout(deadline);
      process.exit(1);
    });
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  return () => {
    process.removeListener("uncaughtException", fatal);
    process.removeListener("unhandledRejection", fatal);
  };
}
