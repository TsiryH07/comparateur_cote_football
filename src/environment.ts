import { loadEnvFile } from "node:process";
import { AppError } from "./errors.js";

// Charge les réglages du fichier .env.
export function loadEnvironment(file = ".env"): void {
  try {
    loadEnvFile(file);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return;
    throw new AppError("ENV_FILE_UNREADABLE",
      "Impossible de lire le fichier de configuration .env. Vérifiez qu'il s'agit d'un fichier accessible, puis relancez le programme.", { cause });
  }
}
