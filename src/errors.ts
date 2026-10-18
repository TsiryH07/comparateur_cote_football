export class AppError extends Error {
  readonly code: string;

  // Prépare une erreur claire et identifiable.
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(redactSecrets(message), options);
    this.name = "AppError";
    this.code = /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "INTERNAL_ERROR";
  }
}

// Cache les informations secrètes dans les messages.
export function redactSecrets(message: string): string {
  let result = message;
  const key = process.env.ODDS_API_KEY?.trim();
  if (key) {
    const values = new Set([key]);
    try { values.add(encodeURIComponent(key)); } catch { /* Also mask a malformed raw key. */ }
    for (const value of values) result = result.split(value).join("[masqué]");
  }
  return result
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[masqué]@")
    .replace(/((?:api[_-]?key|access[_-]?token|token|authorization|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&#,;]+)/gi, "$1[masqué]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [masqué]")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .trim();
}

// Transforme une erreur en message lisible.
export function safeErrorMessage(error: unknown, fallback = "Une erreur inattendue s'est produite."): string {
  let message = fallback;
  try {
    if (error instanceof Error && typeof error.message === "string" && error.message.trim()) message = error.message;
    else if (typeof error === "string" && error.trim()) message = error;
  } catch {
    // Prévoit aussi le cas d’un message impossible à lire.
  }
  return redactSecrets(message).slice(0, 2000) || fallback;
}

// Affiche une erreur sans révéler de secret.
export function logError(label: string, error: unknown): void {
  const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
  console.error(`${redactSecrets(label)} [${code}] ${safeErrorMessage(error)}`);
}
