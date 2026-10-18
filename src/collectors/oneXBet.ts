import { OddsApiCollector, type OddsApiCollectorOptions } from "./oddsApi.js";

export type OneXBetCollectorOptions = OddsApiCollectorOptions;

export class OneXBetCollector extends OddsApiCollector {
  // Prépare la récupération des cotes de 1xBet.
  constructor(options: OneXBetCollectorOptions) {
    super(options, { name: "1xbet", bookmakerKey: "onexbet", label: "1xBet" });
  }
}
