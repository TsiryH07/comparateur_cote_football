import type { Config } from "../config.js";
import type { Collector } from "../types.js";
import { discoverCollectors } from "./mock.js";
import { OneXBetCollector } from "./oneXBet.js";
import { Bet261Collector } from "./bet261.js";
import { PinnacleCollector } from "./pinnacle.js";

// Prépare les sources choisies dans les réglages.
export async function createCollectors(config: Config): Promise<Collector[]> {
  if (config.dataSource === "odds-api") {
    const collectors: Collector[] = [new OneXBetCollector({ apiKey: config.oddsApiKey, sports: config.oddsApiSports })];
    if (config.bet261Enabled) collectors.push(new Bet261Collector({ sports: config.oddsApiSports }));
    collectors.push(new PinnacleCollector({ apiKey: config.oddsApiKey, sports: config.oddsApiSports }));
    return collectors;
  }
  return discoverCollectors(config.mockDataDir);
}
