import type { SearchEngineTelemetry, WebStats } from "./types.js";

const MAX_HOST_CONCURRENCY = 4;
const ENGINE_CIRCUIT_FAILURE_THRESHOLD = 3;
const ENGINE_CIRCUIT_OPEN_MS = 60_000;

const HOST_ACTIVE_FETCHES = new Map<string, number>();
const HOST_WAITERS = new Map<string, Array<() => void>>();
const ENGINE_CIRCUITS = new Map<string, { failures: number; openUntil: number }>();

export const WEB_STATS: WebStats = {
  search_calls: 0,
  search_cache_hits: 0,
  search_engine_calls: {},
  search_engine_failures: {},
  search_engine_ms: {},
  fetch_calls: 0,
  fetch_cache_hits: 0,
  fetch_failures: 0,
  fetch_ms: 0,
  host_queue_waits: {},
};

export function incrementStat(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

export function recordEngineTelemetry(item: SearchEngineTelemetry): void {
  incrementStat(WEB_STATS.search_engine_calls, item.source);
  incrementStat(WEB_STATS.search_engine_ms, item.source, item.duration_ms);
  if (!item.ok) incrementStat(WEB_STATS.search_engine_failures, item.source);
}

export function webStatsSnapshot(cacheEntries: { search: number; fetch: number; refs: number }): WebStats & {
  cache_entries: { search: number; fetch: number; refs: number };
  engine_circuits: Record<string, { failures: number; open_ms_remaining: number }>;
} {
  const now = Date.now();
  const circuits: Record<string, { failures: number; open_ms_remaining: number }> = {};
  for (const [source, circuit] of ENGINE_CIRCUITS) {
    circuits[source] = {
      failures: circuit.failures,
      open_ms_remaining: Math.max(0, circuit.openUntil - now),
    };
  }
  return {
    ...WEB_STATS,
    search_engine_calls: { ...WEB_STATS.search_engine_calls },
    search_engine_failures: { ...WEB_STATS.search_engine_failures },
    search_engine_ms: { ...WEB_STATS.search_engine_ms },
    host_queue_waits: { ...WEB_STATS.host_queue_waits },
    cache_entries: cacheEntries,
    engine_circuits: circuits,
  };
}

export function engineCircuitOpen(source: string): string | null {
  const circuit = ENGINE_CIRCUITS.get(source);
  if (!circuit || circuit.openUntil <= Date.now()) return null;
  return `${source}: temporarily disabled after ${circuit.failures} consecutive failures`;
}

export function recordEngineHealth(source: string, ok: boolean): void {
  if (ok) {
    ENGINE_CIRCUITS.delete(source);
    return;
  }
  const previous = ENGINE_CIRCUITS.get(source);
  const failures = (previous?.failures ?? 0) + 1;
  ENGINE_CIRCUITS.set(source, {
    failures,
    openUntil: failures >= ENGINE_CIRCUIT_FAILURE_THRESHOLD ? Date.now() + ENGINE_CIRCUIT_OPEN_MS : 0,
  });
}

export async function withHostConcurrency<T>(rawUrl: string, fn: () => Promise<T>): Promise<T> {
  let host = "";
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return fn();
  }
  while ((HOST_ACTIVE_FETCHES.get(host) ?? 0) >= MAX_HOST_CONCURRENCY) {
    incrementStat(WEB_STATS.host_queue_waits, host);
    await new Promise<void>(resolve => {
      const waiters = HOST_WAITERS.get(host) ?? [];
      waiters.push(resolve);
      HOST_WAITERS.set(host, waiters);
    });
  }
  HOST_ACTIVE_FETCHES.set(host, (HOST_ACTIVE_FETCHES.get(host) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const active = Math.max(0, (HOST_ACTIVE_FETCHES.get(host) ?? 1) - 1);
    if (active) HOST_ACTIVE_FETCHES.set(host, active);
    else HOST_ACTIVE_FETCHES.delete(host);
    HOST_WAITERS.get(host)?.shift()?.();
  }
}
