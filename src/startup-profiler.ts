/** Lightweight startup phase profiling. */

import { performance } from "node:perf_hooks";

export interface StartupProfileRecord {
  name: string;
  start_ms: number;
  duration_ms: number;
  ok: boolean;
  detail?: string;
}

export class StartupProfiler {
  private readonly startedAt = performance.now();
  private readonly records: StartupProfileRecord[] = [];

  constructor(private readonly enabled = startupProfileEnabled()) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  mark(name: string, detail?: string): void {
    if (!this.enabled) return;
    const record: StartupProfileRecord = {
      name,
      start_ms: performance.now() - this.startedAt,
      duration_ms: 0,
      ok: true,
    };
    if (detail !== undefined) record.detail = detail;
    this.records.push(record);
  }

  profileSync<T>(name: string, fn: () => T, detail?: (value: T) => string | undefined): T {
    if (!this.enabled) return fn();
    const start = performance.now();
    try {
      const value = fn();
      this.record(name, start, true, detail?.(value));
      return value;
    } catch (error) {
      this.record(name, start, false, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async profileAsync<T>(name: string, fn: () => Promise<T>, detail?: (value: T) => string | undefined): Promise<T> {
    if (!this.enabled) return fn();
    const start = performance.now();
    try {
      const value = await fn();
      this.record(name, start, true, detail?.(value));
      return value;
    } catch (error) {
      this.record(name, start, false, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  report(stderr: NodeJS.WritableStream = process.stderr): void {
    if (!this.enabled || !this.records.length) return;
    const total = Math.max(...this.records.map(record => record.start_ms + record.duration_ms));
    if (startupProfileJsonEnabled()) {
      stderr.write(`${JSON.stringify({ total_ms: total, records: this.records }, null, 2)}\n`);
      return;
    }
    stderr.write(`\nStartup profile (${formatMs(total)} total observed):\n`);
    for (const record of this.records) {
      const status = record.ok ? "ok" : "error";
      const detail = record.detail ? ` ${record.detail}` : "";
      stderr.write(`  ${formatMs(record.start_ms).padStart(8)} +${formatMs(record.duration_ms).padStart(8)}  ${status.padEnd(5)} ${record.name}${detail}\n`);
    }
  }

  private record(name: string, start: number, ok: boolean, detail?: string): void {
    const record: StartupProfileRecord = {
      name,
      start_ms: start - this.startedAt,
      duration_ms: performance.now() - start,
      ok,
    };
    if (detail !== undefined) record.detail = detail;
    this.records.push(record);
  }
}

export function createStartupProfiler(env: NodeJS.ProcessEnv = process.env): StartupProfiler {
  return new StartupProfiler(startupProfileEnabled(env));
}

function startupProfileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.SEEKCODE_STARTUP_PROFILE || env.SEEK_STARTUP_PROFILE;
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function startupProfileJsonEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.SEEKCODE_STARTUP_PROFILE_JSON || env.SEEKCODE_STARTUP_PROFILE || "";
  return value.trim().toLowerCase() === "json";
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}
