"use client";

/**
 * Browser-side client for the local TradingView MCP HTTP bridge.
 * The bridge runs on the user's machine alongside TradingView Desktop.
 */

import type {
  MarketChatLevel,
  MarketChatSetup,
  MarketChatZone,
} from "@/lib/parse-market-chat-json";

export type TradingViewBridgeStatus = {
  ok: boolean;
  connected?: boolean;
  tradingView?: boolean;
  error?: string;
};

export type TradingViewBridgeDrawPayload = {
  symbol: string;
  resolution?: string;
  setup?: MarketChatSetup | null;
  levels?: MarketChatLevel[];
  zones?: MarketChatZone[];
  referenceTime?: number;
  clearExisting?: boolean;
};

const DEFAULT_BRIDGE =
  typeof process !== "undefined" &&
  process.env.NEXT_PUBLIC_TRADINGVIEW_MCP_BRIDGE_URL
    ? process.env.NEXT_PUBLIC_TRADINGVIEW_MCP_BRIDGE_URL
    : "http://127.0.0.1:3847";

export function getTradingViewBridgeUrl(): string {
  return DEFAULT_BRIDGE;
}

export async function checkTradingViewBridge(
  signal?: AbortSignal,
): Promise<TradingViewBridgeStatus> {
  try {
    const res = await fetch(`${getTradingViewBridgeUrl()}/health`, {
      method: "GET",
      signal,
      cache: "no-store",
    });
    if (!res.ok) {
      return { ok: false, error: `Bridge HTTP ${res.status}` };
    }
    const data = (await res.json()) as TradingViewBridgeStatus;
    return { ...data, ok: data.ok ?? true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Bridge unreachable",
    };
  }
}

export async function drawViaTradingViewBridge(
  payload: TradingViewBridgeDrawPayload,
): Promise<{
  ok: boolean;
  drawn?: string[];
  errors?: string[];
  error?: string;
}> {
  try {
    const res = await fetch(`${getTradingViewBridgeUrl()}/draw-setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      drawn?: string[];
      errors?: string[];
      error?: string;
    };
    if (!res.ok) {
      return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    }
    return {
      ok: data.ok === true,
      drawn: data.drawn,
      errors: data.errors,
      error: data.error,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Bridge draw failed",
    };
  }
}
