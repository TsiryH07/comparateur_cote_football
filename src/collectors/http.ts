import { AppError } from "../errors.js";

const RETRYABLE_STATUSES = new Set([408, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 200;

interface RequestMessages {
  network: string;
  cancelled: string;
}

// Prépare un message signalant l’annulation d’une collecte.
export function sourceAbortError(message: string): AppError {
  const error = new AppError("COLLECTION_ABORTED", message);
  error.name = "AbortError";
  return error;
}

// Libère une réponse qui ne sera plus utilisée.
export async function discardResponse(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Transport cleanup is best effort. */ }
}

// Attend un peu avant de réessayer.
function retryDelay(signal: AbortSignal, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(sourceAbortError(message)); return; }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(sourceAbortError(message));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, RETRY_DELAY_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Demande les données et réessaie une fois si nécessaire.
export async function requestGet(
  fetch: typeof globalThis.fetch,
  url: URL,
  init: RequestInit & { signal: AbortSignal },
  messages: RequestMessages,
): Promise<Response> {
  const { signal } = init;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) throw sourceAbortError(messages.cancelled);
    let response: Response;
    try {
      response = await fetch(url, { ...init, method: "GET" });
    } catch {
      if (signal.aborted) throw sourceAbortError(messages.cancelled);
      if (attempt === 1) throw new AppError("SOURCE_NETWORK", messages.network);
      await retryDelay(signal, messages.cancelled);
      continue;
    }
    if (signal.aborted) {
      await discardResponse(response);
      throw sourceAbortError(messages.cancelled);
    }
    if (attempt === 0 && RETRYABLE_STATUSES.has(response.status)) {
      await discardResponse(response);
      await retryDelay(signal, messages.cancelled);
      continue;
    }
    return response;
  }
  throw new AppError("SOURCE_NETWORK", messages.network);
}
