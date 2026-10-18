import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, extname, join } from "node:path";
import { AppError, redactSecrets } from "../errors.js";
import type { CollectionContext, Collector } from "../types.js";
import { sourceAbortError } from "./http.js";

// Vérifie que la donnée contient des champs.
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Calcule la date d’un match d’exemple.
function resolveSchedule(value: unknown, now: Date): unknown {
  if (!isObject(value) || value.startsAt !== undefined || !isObject(value.schedule)) return value;
  const { dayOffset, time } = value.schedule;
  if (typeof dayOffset !== "number" || !Number.isInteger(dayOffset) || Math.abs(dayOffset) > 3650 ||
      typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/.test(time)) {
    throw new Error("schedule doit contenir dayOffset entier (-3650 à 3650) et time au format HH:mm:ssZ (UTC).");
  }
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return { ...value, startsAt: `${date.toISOString().slice(0, 10)}T${time}` };
}

export class JsonFileCollector implements Collector {
  readonly name: string;
  private readonly filePath: string;

  // Associe une source à son fichier d’exemples.
  constructor(name: string, filePath: string) {
    if (typeof name !== "string" || !name.trim()) throw new AppError("COLLECTOR_CONFIG", "Le nom de la source JSON doit être non vide.");
    if (typeof filePath !== "string" || !filePath.trim()) throw new AppError("COLLECTOR_CONFIG", "Le chemin du fichier JSON doit être non vide.");
    this.name = name.trim();
    this.filePath = filePath;
  }

  // Lit les matchs d’exemple et prépare leurs dates.
  async collect({ now, signal }: CollectionContext): Promise<unknown[]> {
    if (signal.aborted) throw sourceAbortError("Lecture de la source JSON annulée.");
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new AppError("COLLECTION_CONTEXT", "La date de lecture de la source JSON est invalide.");
    const file = redactSecrets(basename(this.filePath));
    let contents: string;
    try { contents = await readFile(this.filePath, { encoding: "utf8", signal }); }
    catch (error) {
      if (signal.aborted) throw sourceAbortError("Lecture de la source JSON annulée.");
      const code = isObject(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
      if (code === "ENOENT") throw new AppError("MOCK_FILE_MISSING", `Le fichier d’exemple ${file} est introuvable (ENOENT). Vérifiez MOCK_DATA_DIR et le nom du fichier.`);
      if (code === "EACCES" || code === "EPERM") throw new AppError("MOCK_FILE_ACCESS", `Lecture du fichier ${file} refusée : vérifiez les droits d’accès.`);
      if (code === "EISDIR") throw new AppError("MOCK_FILE_TYPE", `La source ${file} doit désigner un fichier JSON et non un dossier.`);
      throw new AppError("MOCK_FILE_READ", `Lecture du fichier d’exemple ${file} impossible.`);
    }
    if (signal.aborted) throw sourceAbortError("Lecture de la source JSON annulée.");
    let rows: unknown;
    try { rows = JSON.parse(contents.replace(/^\uFEFF/, "")); }
    catch { throw new AppError("MOCK_JSON_INVALID", `Le fichier ${file} contient un JSON invalide : vérifiez les virgules, guillemets et crochets.`); }
    if (!Array.isArray(rows)) throw new AppError("MOCK_JSON_SHAPE", `${file} doit contenir un tableau JSON de matchs.`);
    return rows.map((row: unknown) => {
      try {
        return resolveSchedule(row, now);
      } catch {
        // Ignore seulement cette ligne incorrecte.
        return row;
      }
    });
  }
}

// Crée une source pour chaque fichier d’exemples.
export async function discoverCollectors(directory: string): Promise<Collector[]> {
  if (typeof directory !== "string" || !directory.trim()) throw new AppError("COLLECTOR_CONFIG", "MOCK_DATA_DIR doit désigner un dossier non vide.");
  let entries: Dirent[];
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
    if (code === "ENOENT") throw new AppError("MOCK_DIRECTORY_MISSING", "Le dossier des sources d’exemple est introuvable (ENOENT). Vérifiez MOCK_DATA_DIR.");
    if (code === "ENOTDIR") throw new AppError("MOCK_DIRECTORY_TYPE", "MOCK_DATA_DIR doit désigner un dossier et non un fichier.");
    if (code === "EACCES" || code === "EPERM") throw new AppError("MOCK_DIRECTORY_ACCESS", "Accès au dossier des sources d’exemple refusé : vérifiez les droits d’accès.");
    throw new AppError("MOCK_DIRECTORY_READ", "Lecture du dossier des sources d’exemple impossible. Vérifiez MOCK_DATA_DIR.");
  }
  const files = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".json")
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) throw new AppError("MOCK_DIRECTORY_EMPTY", "Aucune source JSON trouvée dans le dossier MOCK_DATA_DIR. Ajoutez au moins un fichier .json contenant un tableau de matchs.");
  return files.map((file) => new JsonFileCollector(basename(file, extname(file)), join(directory, file)));
}
