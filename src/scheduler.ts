import { logError } from "./errors.js";

export interface SchedulerOptions {
  intervalMs: number;
  signal: AbortSignal;
  onError?: (error: unknown) => void;
}

// Relance la collecte à intervalles réguliers.
export async function runScheduler(
  task: () => Promise<void>,
  { intervalMs, signal, onError }: SchedulerOptions,
): Promise<void> {
  if (
    !Number.isInteger(intervalMs) ||
    intervalMs <= 0 ||
    intervalMs > 2_147_483_647
  ) {
    throw new RangeError("intervalMs must be an integer between 1 and 2147483647.");
  }

  while (!signal.aborted) {
    try {
      await task();
    } catch (error) {
      try {
        if (onError) await onError(error);
        else if (!signal.aborted) logError("Échec du cycle :", error);
      } catch (reportingError) {
        // Un message d’erreur ne doit pas bloquer la prochaine collecte.
        logError("Échec du cycle :", error);
        logError("Impossible de signaler l'erreur :", reportingError);
      }
    }

    if (!signal.aborted) {
      await waitForNextCycle(intervalMs, signal);
    }
  }
}

// Attend avant la prochaine collecte.
function waitForNextCycle(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, intervalMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}
