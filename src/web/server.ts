import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { createCollectors } from "../collectors/index.js";
import type { Config } from "../config.js";
import type { OddsDatabase } from "../database/sqlite.js";
import { AppError, safeErrorMessage } from "../errors.js";
import { collectCycle } from "../services/collectCycle.js";
import { compareOdds } from "../services/compareOdds.js";
import type { Collector, CycleResult, Threshold } from "../types.js";
import type { DashboardState } from "./types.js";

type DashboardDatabase = Pick<OddsDatabase, "saveCycle" | "getHistory" | "getAlerts" | "getLatestCycle">;

export interface DashboardServerOptions {
  config: Config;
  database: DashboardDatabase;
  publicDir?: string;
  collectors?: Collector[];
  clock?: () => Date;
  onError?: (error: unknown) => void;
}

export interface DashboardServer {
  server: Server;
  collect(): Promise<DashboardState>;
  // Arrête le service sans fermer le fichier d’historique.
  close(): Promise<void>;
}

class HttpError extends AppError {
  // Prépare une erreur à envoyer au navigateur.
  constructor(public readonly status: number, message: string, code = `HTTP_${status}`) {
    super(code, message);
  }
}

// Prépare un message d’erreur sans information secrète.
function publicError(error: unknown): { status: number; code: string; error: string } {
  if (error instanceof HttpError) return { status: error.status, code: error.code, error: safeErrorMessage(error) };
  if (error instanceof AppError) {
    return { status: error.code.startsWith("DATABASE_") ? 503 : 500, code: error.code, error: safeErrorMessage(error) };
  }
  return { status: 500, code: "INTERNAL_ERROR", error: "Une erreur interne est survenue." };
}

const MAX_BODY_BYTES = 16 * 1024;
const SHUTDOWN_GRACE_MS = 2_000;
// Garde les anciennes cotes même si leur site est désactivé.
const REAL_SOURCES = new Set(["1xbet", "bet261", "pinnacle"]);
const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml; charset=utf-8" },
};

// Vérifie le format des informations.
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Vérifie les réglages envoyés par l’utilisateur.
function validateSettings(value: unknown): { threshold: Threshold; automatic: boolean } {
  if (!isObject(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "threshold") || !Object.hasOwn(value, "automatic") ||
      typeof value.automatic !== "boolean" || !isObject(value.threshold)) {
    throw new HttpError(400, "Les paramètres attendus sont threshold et automatic (booléen).");
  }
  const threshold = value.threshold;
  if (Object.keys(threshold).length !== 2 || !Object.hasOwn(threshold, "mode") ||
      !Object.hasOwn(threshold, "value") ||
      (threshold.mode !== "absolute" && threshold.mode !== "percentage") ||
      typeof threshold.value !== "number" || !Number.isFinite(threshold.value) || threshold.value < 0) {
    throw new HttpError(400, "Le seuil attend un mode percentage ou absolute et une valeur numérique positive ou nulle.");
  }
  return { threshold: { mode: threshold.mode, value: threshold.value }, automatic: value.automatic };
}

// Vérifie que la demande vise l’application locale.
function localOrigin(request: IncomingMessage): string {
  const host = request.headers.host;
  const match = host && /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i.exec(host);
  if (!match || Number(match[2] ?? 80) !== request.socket.localPort) {
    throw new HttpError(403, "Ce service est accessible uniquement avec une adresse locale.");
  }
  return new URL(`http://${host}`).origin;
}

// Refuse les actions envoyées depuis un autre site.
function requireSameOrigin(request: IncomingMessage, origin: string): void {
  const supplied = request.headers.origin;
  if (request.headers["sec-fetch-site"] === "cross-site" || (supplied !== undefined && supplied !== origin)) {
    throw new HttpError(403, "Les requêtes provenant d'une autre origine sont refusées.");
  }
}

// Lit les informations envoyées par le navigateur.
function readBody(request: IncomingMessage): Promise<string> {
  const length = Number(request.headers["content-length"] ?? 0);
  if (length > MAX_BODY_BYTES) {
    request.resume();
    return Promise.reject(new HttpError(413, "Le corps de la requête dépasse 16 Ko."));
  }
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        cleanup();
        request.resume();
        reject(new HttpError(413, "Le corps de la requête dépasse 16 Ko."));
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = () => {
      cleanup();
      reject(new HttpError(400, "Impossible de lire le corps de la requête."));
    };
    const onAborted = () => onError();
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

// Vérifie le nombre de résultats demandés.
function readLimit(url: URL): number {
  const values = url.searchParams.getAll("limit");
  if (values.length === 0) return 50;
  const raw = values[0]!;
  if (values.length !== 1 || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 10_000) {
    throw new HttpError(400, "limit doit être un entier entre 1 et 10000.");
  }
  return Number(raw);
}

// Envoie les résultats au navigateur.
function sendJson(response: ServerResponse, status: number, value: unknown, head = false): void {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(head ? undefined : body);
}

// Prépare le fonctionnement de l’interface.
export function createDashboardServer(options: DashboardServerOptions): DashboardServer {
  const { config, database, clock = () => new Date() } = options;
  const publicDir = options.publicDir ?? resolve("public");
  let threshold: Threshold = { ...config.threshold };
  let automatic = true;
  const relevantCycle = (cycle: CycleResult | null): CycleResult | null => {
    if (config.dataSource !== "odds-api" || !cycle) return cycle;
    // Sépare les exemples des vraies cotes.
    const events = cycle.events.map((event) => ({
      ...event, quotes: event.quotes.filter((quote) => REAL_SOURCES.has(quote.source)),
    })).filter((event) => event.quotes.length > 0);
    const errors = cycle.errors.filter((error) => REAL_SOURCES.has(error.source));
    const onlyExcludedSources = events.length === 0 && errors.length === 0;
    return {
      ...cycle, events, errors, alerts: [],
      collectedCount: events.reduce((count, event) => count + event.quotes.length, 0),
      rejectedCount: onlyExcludedSources ? 0 : cycle.rejectedCount,
      skippedCount: onlyExcludedSources ? 0 : cycle.skippedCount,
    };
  };
  // L’interface reste accessible si l’historique est indisponible.
  let latestCycle: CycleResult | null = null;
  let sources: string[] = options.collectors?.map((collector) => collector.name) ??
    (config.dataSource === "odds-api" ? ["1xbet", ...(config.bet261Enabled !== false ? ["bet261"] : []), "pinnacle"] : []);
  let collecting = false;
  let nextRunAt: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeCollection: Promise<DashboardState> | null = null;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let lastError: { code: string; message: string } | null = null;
  const shutdown = new AbortController();

  const reportError = (error: unknown): void => {
    const fallback = () => console.error("Erreur du service :", safeErrorMessage(error, "Une erreur interne est survenue."));
    if (!options.onError) { fallback(); return; }
    try {
      // Évite qu’un message d’erreur provoque une autre panne.
      void Promise.resolve(options.onError(error)).catch(() => fallback());
    } catch { fallback(); }
  };

  const state = (refreshFromDatabase = true): DashboardState => {
    // Vérifie si un autre lancement a ajouté des cotes.
    if (refreshFromDatabase && !collecting) {
      latestCycle = relevantCycle(database.getLatestCycle());
      if (!options.collectors && config.dataSource === "mock") {
        sources = [...new Set([...sources,
          ...latestCycle?.events.flatMap((event) => event.quotes.map((quote) => quote.source)) ?? [],
          ...latestCycle?.errors.map((error) => error.source) ?? [],
        ])].sort();
      }
    }
    return {
      dataSource: config.dataSource,
      settings: { threshold: { ...threshold }, intervalMinutes: config.intervalMs / 60_000, automatic },
      sources: [...sources],
      latestCycle: latestCycle ? { ...latestCycle, alerts: compareOdds(latestCycle.events, threshold) } : null,
      collecting,
      nextRunAt,
      lastError,
    };
  };

  const clearSchedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    nextRunAt = null;
  };

  const scheduleNext = () => {
    clearSchedule();
    if (closing || !automatic || collecting) return;
    try {
      nextRunAt = new Date(clock().getTime() + config.intervalMs).toISOString();
    } catch (error) {
      lastError = { code: "SCHEDULER_FAILED", message: "La prochaine collecte n’a pas pu être programmée. Relancez une collecte manuelle." };
      reportError(error);
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      nextRunAt = null;
      void collect().catch((error: unknown) => {
        if (!closing) reportError(error);
      });
    }, config.intervalMs);
    timer.unref();
  };

  // Lance la collecte et actualise les résultats.
  async function collect(): Promise<DashboardState> {
    if (closing) throw new HttpError(503, "Le service est en cours d'arrêt.", "SERVICE_STOPPING");
    if (collecting) throw new HttpError(409, "Une collecte est déjà en cours.", "COLLECTION_IN_PROGRESS");
    collecting = true;
    clearSchedule();
    activeCollection = Promise.resolve().then(async () => {
      try {
        const collectors = options.collectors ?? await createCollectors(config);
        sources = collectors.map((collector) => collector.name);
        latestCycle = await collectCycle({
          collectors,
          database,
          threshold: { ...threshold },
          matchToleranceMinutes: config.matchToleranceMinutes,
          collectorTimeoutMs: config.collectorTimeoutMs,
          signal: shutdown.signal,
          clock,
        });
        lastError = null;
      } catch (error) {
        if (!closing) {
          const details = publicError(error);
          lastError = { code: details.code, message: details.error };
        }
        throw error;
      } finally {
        collecting = false;
        activeCollection = null;
        scheduleNext();
      }
      // Confirme les données déjà enregistrées.
      return state(false);
    });
    return activeCollection;
  }

  const server = createServer((request, response) => {
    // Termine la collecte même si le navigateur se déconnecte.
    request.on("error", () => {});
    response.on("error", reportError);
    void handleRequest(request, response).catch((error: unknown) => {
      if (!(error instanceof HttpError)) reportError(error);
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      const { status, code, error: message } = publicError(error);
      try { sendJson(response, status, { error: message, code }, request.method === "HEAD"); }
      catch (sendError) { reportError(sendError); response.destroy(); }
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on("clientError", (error, socket) => {
    if (!socket.writable || socket.destroyed || socket.writableEnded) return;
    const oversized = (error as NodeJS.ErrnoException).code === "HPE_HEADER_OVERFLOW";
    const status = oversized ? 431 : 400;
    const body = JSON.stringify({ code: oversized ? "HTTP_431" : "HTTP_400", error: oversized ?
      "Les en-têtes de la requête sont trop volumineux." : "La requête HTTP est invalide." });
    try {
      socket.end(`HTTP/1.1 ${status} ${oversized ? "Request Header Fields Too Large" : "Bad Request"}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } catch { socket.destroy(); }
  });

  // Répond aux demandes envoyées par le navigateur.
  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = localOrigin(request);
    let url: URL;
    try { url = new URL(request.url ?? "/", origin); }
    catch { throw new HttpError(400, "Adresse de requête invalide."); }
    if (url.origin !== origin) throw new HttpError(400, "Adresse de requête invalide.");
    const path = url.pathname;
    const readRequest = request.method === "GET" || request.method === "HEAD";
    const head = request.method === "HEAD";
    const writes = path === "/api/collect" || path === "/api/settings";
    const reads = path === "/api/state" || path === "/api/history" || path === "/api/alerts" || Object.hasOwn(ASSETS, path);
    if (!writes && !reads) throw new HttpError(404, "Ressource introuvable.");
    if ((writes && request.method !== "POST") || (reads && !readRequest)) {
      response.setHeader("allow", writes ? "POST" : "GET, HEAD");
      throw new HttpError(405, "Méthode HTTP non autorisée.");
    }
    if (closing) throw new HttpError(503, "Le service est en cours d'arrêt.", "SERVICE_STOPPING");

    if (path === "/api/state") {
      sendJson(response, 200, state(), head);
    } else if (path === "/api/history") {
      const history = database.getHistory(readLimit(url), config.dataSource === "odds-api" ? [...REAL_SOURCES] : undefined);
      sendJson(response, 200, { history }, head);
    } else if (path === "/api/alerts") {
      const alerts = database.getAlerts(readLimit(url), config.dataSource === "odds-api" ? [...REAL_SOURCES] : undefined);
      sendJson(response, 200, { alerts }, head);
    } else if (path === "/api/collect") {
      requireSameOrigin(request, origin);
      if ((await readBody(request)).length !== 0) throw new HttpError(400, "La collecte attend un corps de requête vide.");
      sendJson(response, 200, await collect());
    } else if (path === "/api/settings") {
      requireSameOrigin(request, origin);
      if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        throw new HttpError(415, "Le type de contenu doit être application/json.");
      }
      const body = await readBody(request);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new HttpError(400, "Le corps de la requête doit être du JSON valide.");
      }
      const settings = validateSettings(parsed);
      if (closing) throw new HttpError(503, "Le service est en cours d'arrêt.", "SERVICE_STOPPING");
      // Vérifie les données avant de changer les réglages.
      const snapshot = state();
      const updatedCycle = snapshot.latestCycle ? {
        ...snapshot.latestCycle, alerts: compareOdds(snapshot.latestCycle.events, settings.threshold),
      } : null;
      const wasAutomatic = automatic;
      threshold = settings.threshold;
      automatic = settings.automatic;
      if (!automatic) clearSchedule();
      else if (!wasAutomatic && !collecting) scheduleNext();
      sendJson(response, 200, {
        ...snapshot,
        settings: { ...snapshot.settings, threshold: { ...threshold }, automatic },
        latestCycle: updatedCycle, nextRunAt, lastError,
      });
    } else {
      const asset = ASSETS[path]!;
      let body: Buffer;
      try {
        body = await readFile(join(publicDir, asset.file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "Ressource introuvable.");
        throw error;
      }
      response.writeHead(200, {
        "content-type": asset.type,
        "content-length": body.length,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
      response.end(head ? undefined : body);
    }
  }

  // Arrête les collectes et ferme l’interface.
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    clearSchedule();
    shutdown.abort();
    const pendingCollection = activeCollection;
    const serverClosed = new Promise<void>((resolveClose, reject) => {
      if (!server.listening) return resolveClose();
      // Évite d’attendre indéfiniment pendant l’arrêt.
      const forceClose = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
      forceClose.unref();
      server.close((error) => {
        clearTimeout(forceClose);
        if (error) reject(error);
        else resolveClose();
      });
      server.closeIdleConnections();
    });
    closePromise = Promise.all([serverClosed, pendingCollection?.catch(() => {})]).then(() => {});
    return closePromise;
  }

  return { server, collect, close };
}
