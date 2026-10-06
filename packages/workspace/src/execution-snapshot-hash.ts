import { createHash } from "node:crypto";

/**
 * C6b: canonical hashing and diffing for execution snapshots.
 *
 * One implementation, used by both stores and by the provider, so a hash written by the Postgres store can
 * always be re-verified by the in-memory one and the API cannot disagree with persistence about what a
 * snapshot "is".
 *
 * The canonical form is a recursively sorted JSON serialisation: two payloads that differ only in key order
 * hash identically, and any real change hashes differently. Values are limited to JSON scalars, arrays and
 * objects; anything else is represented by its type name so a stray `undefined`, function or `Date` cannot
 * silently become `null` and make two different snapshots look equal.
 */

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function canonicalise(value: unknown): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value as CanonicalValue;
  }
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: { [key: string]: CanonicalValue } = {};
    for (const key of Object.keys(source).sort()) {
      const nested = source[key];
      if (nested === undefined) continue;
      out[key] = canonicalise(nested);
    }
    return out;
  }
  // undefined / function / symbol: represent the type rather than pretending it is null.
  return typeof value;
}

/** Stable, key-sorted JSON for a snapshot payload. */
export function canonicalSnapshotJson(payload: Record<string, unknown>): string {
  return JSON.stringify(canonicalise(payload));
}

/** sha256 of the canonical form, prefixed so the algorithm is visible where the hash is read. */
export function snapshotPayloadHash(payload: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalSnapshotJson(payload)).digest("hex")}`;
}

const MAX_RENDERED_LENGTH = 120;

/**
 * Render one field value for a diff without ever leaking content: only scalars, lengths and type names.
 * This is what makes `diffExecutionSnapshots` safe to show in an API response or an Activity event.
 */
function renderForDiff(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    // Versions, hashes and enums are what a snapshot diff is about; long strings are summarised by length.
    return value.length <= 64 ? value : `string(${value.length})`;
  }
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return keys.length === 0 ? "object()" : `object(${keys.join(",")})`.slice(0, MAX_RENDERED_LENGTH);
  }
  return typeof value;
}

export interface SnapshottedFieldChange {
  field: string;
  from: string;
  to: string;
}

export interface SnapshottedFieldDiff {
  changes: SnapshottedFieldChange[];
  unchanged: string[];
}

/**
 * Compare two payloads field by field. Nested objects are flattened to dotted paths so a change inside
 * `policy.mode` is reported as `policy.mode` rather than as "the whole policy object changed".
 */
export function diffSnapshotPayloads(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): SnapshottedFieldDiff {
  const flatBefore = flatten(before);
  const flatAfter = flatten(after);
  const fields = Array.from(new Set([...Object.keys(flatBefore), ...Object.keys(flatAfter)])).sort();
  const changes: SnapshottedFieldChange[] = [];
  const unchanged: string[] = [];
  for (const field of fields) {
    const hasBefore = Object.prototype.hasOwnProperty.call(flatBefore, field);
    const hasAfter = Object.prototype.hasOwnProperty.call(flatAfter, field);
    const left = renderForDiff(flatBefore[field]);
    const right = renderForDiff(flatAfter[field]);
    if (!hasBefore) { changes.push({ field, from: "absent", to: right }); continue; }
    if (!hasAfter) { changes.push({ field, from: left, to: "absent" }); continue; }
    if (left === right) { unchanged.push(field); continue; }
    changes.push({ field, from: left, to: right });
  }
  return { changes, unchanged };
}

function flatten(value: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const nested = value[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (nested && typeof nested === "object" && !Array.isArray(nested) && !(nested instanceof Date)) {
      Object.assign(out, flatten(nested as Record<string, unknown>, path));
    } else {
      out[path] = nested;
    }
  }
  return out;
}
