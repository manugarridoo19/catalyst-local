"use client";

import PusherClient from "pusher-js";

let cached: PusherClient | null = null;

export function getPusherClient(): PusherClient | null {
  if (typeof window === "undefined") return null;
  if (cached) return cached;
  const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
  const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
  if (!key || !cluster) {
    console.warn("[pusher-client] NEXT_PUBLIC_PUSHER_* no configurado");
    return null;
  }
  cached = new PusherClient(key, { cluster });
  return cached;
}

export const NEWS_CHANNEL = "feed";
export const NEWS_EVENT = "news:new";
