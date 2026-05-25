export interface JsonSafeOptions {
  sortKeys?: boolean;
  dropUndefinedObjectFields?: boolean;
  space?: string | number;
}

const MAX_JSON_SAFE_ARRAY_ITEMS = 10_000;
const MAX_JSON_SAFE_OBJECT_KEYS = 2_000;

export function toJsonSafe(value: unknown, options: JsonSafeOptions = {}): unknown {
  return normalizeJsonValue(value, options, new WeakSet<object>(), false);
}

export function safeJsonStringify(value: unknown, options: JsonSafeOptions = {}): string {
  return JSON.stringify(toJsonSafe(value, options), null, options.space) ?? "null";
}

export function stableJsonStringify(value: unknown): string {
  return safeJsonStringify(value, { sortKeys: true, dropUndefinedObjectFields: true });
}

function normalizeJsonValue(
  value: unknown,
  options: JsonSafeOptions,
  seen: WeakSet<object>,
  insideObject: boolean,
): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return options.dropUndefinedObjectFields && insideObject ? undefined : null;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (safeIsArray(value)) {
      const items = safeArrayItems(value as unknown[]);
      if (!items) return { truncated: true };
      return items.map(item => {
        const normalized = normalizeJsonValue(item, options, seen, false);
        return normalized === undefined ? null : normalized;
      });
    }

    const result: Record<string, unknown> = {};
    const entries = safeObjectEntries(value);
    if (!entries) return { truncated: true };
    if (options.sortKeys) entries.sort(([a], [b]) => a.localeCompare(b));
    for (const [key, child] of entries) {
      const normalized = normalizeJsonValue(child, options, seen, true);
      if (normalized === undefined && options.dropUndefinedObjectFields) continue;
      result[key] = normalized === undefined ? null : normalized;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function safeIsArray(value: unknown): boolean {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function safeArrayItems(value: unknown[]): unknown[] | null {
  let length = 0;
  try {
    length = Math.min(value.length, MAX_JSON_SAFE_ARRAY_ITEMS);
  } catch {
    return null;
  }
  const items: unknown[] = [];
  for (let index = 0; index < length; index++) {
    try {
      items.push(value[index]);
    } catch {
      return null;
    }
  }
  return items;
}

function safeObjectEntries(value: object): Array<[string, unknown]> | null {
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return null;
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys.slice(0, MAX_JSON_SAFE_OBJECT_KEYS)) {
    try {
      entries.push([key, (value as Record<string, unknown>)[key]]);
    } catch {
      return null;
    }
  }
  return entries;
}
