import { OddsApiCollector, type OddsApiCollectorOptions } from "./oddsApi.js";

export type PinnacleCollectorOptions = OddsApiCollectorOptions;

export class PinnacleCollector extends OddsApiCollector {
  // Prépare la récupération des cotes de Pinnacle.
  constructor(options: PinnacleCollectorOptions) {
    super(options, { name: "pinnacle", bookmakerKey: "pinnacle", label: "Pinnacle" });
  }
}
