/// <reference types="vite/client" />
// ---------------------------------------------------------------------------
// AXIS Market — browser client for the live trading gateway (packages/marketplace).
// When VITE_AXIS_MARKET_URL is set, the MarketWidget routes quotes and fills to
// the real gateway, which settles them into a shared ledger and splits each fee
// between the liquidity pool and the AXIS AI miners. Otherwise it runs locally.
// ---------------------------------------------------------------------------

export type Side = "buy" | "sell";

export type MarketQuoteResp = {
  quote_id: string;
  side: Side;
  asset: string;
  amount: number;
  price: number;
  notional: number;
  fee: number;
  split: { liquidity: number; miner: number; burn?: number };
  ai_saved: number;
  miner: string;
  expires_at: string;
};

export type MarketStats = {
  mid: number;
  fills: number;
  volume_usdc: number;
  liquidity_earnings_usdc: number;
  miner_earnings_usdc: number;
  /** USDC routed to buying back AXIS at the mid. */
  buyback_usdc?: number;
  /** Cumulative AXIS bought back and permanently burned. */
  buyback_burned_axis?: number;
  trader_pnl_usdc: number;
};

export type MarketExecuteResp = {
  fill_id: string;
  settled_at: string;
  side: Side;
  amount: number;
  price: number;
  notional: number;
  fee: number;
  split: { liquidity: number; miner: number; burn?: number };
  miner_wallet: string;
  onchain?: boolean;
  settlement_tx?: string | null;
  miner_axis?: string | null;
  mid: number;
  stats: MarketStats;
};

export type MarketFill = {
  id: string;
  side: Side;
  amount: number;
  price: number;
  notional: number;
  miner_fee: number;
  lp_fee: number;
  pnl: number;
  miner_wallet: string;
  ts: string;
};

export function marketUrl(): string | null {
  const url = import.meta.env.VITE_AXIS_MARKET_URL as string | undefined;
  return url && url.trim() ? url.trim() : null;
}

export class AxisMarketClient {
  baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async quote(body: {
    side: Side;
    amount: number;
    trader?: string;
    /** Miner wallet to credit the AI fee share to (the trader's own wallet). */
    miner?: string;
  }): Promise<MarketQuoteResp> {
    const res = await fetch(`${this.baseUrl}/market/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asset: "AXIS", ...body }),
    });
    if (!res.ok) throw new Error(`quote ${res.status}`);
    return res.json();
  }

  async execute(body: {
    quote_id: string;
    trader?: string;
    /** Miner wallet to credit the AI fee share to (the trader's own wallet). */
    miner?: string;
    pnl?: number;
  }): Promise<MarketExecuteResp> {
    const res = await fetch(`${this.baseUrl}/market/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`execute ${res.status}`);
    return res.json();
  }

  async stats(): Promise<MarketStats> {
    const res = await fetch(`${this.baseUrl}/market/stats`);
    if (!res.ok) throw new Error(`stats ${res.status}`);
    return res.json();
  }

  async fills(limit = 30): Promise<MarketFill[]> {
    const res = await fetch(`${this.baseUrl}/market/fills?limit=${limit}`);
    if (!res.ok) throw new Error(`fills ${res.status}`);
    const j = await res.json();
    return Array.isArray(j.fills) ? j.fills : [];
  }
}
