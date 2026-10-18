import type { CycleResult, Threshold } from "../types.js";

export interface DashboardSettings {
  threshold: Threshold;
  intervalMinutes: number;
  automatic: boolean;
}

export interface DashboardState {
  dataSource: "mock" | "odds-api";
  settings: DashboardSettings;
  sources: string[];
  latestCycle: CycleResult | null;
  collecting: boolean;
  nextRunAt: string | null;
  // Dernier échec, effacé après une collecte réussie.
  lastError?: { code: string; message: string } | null;
}
