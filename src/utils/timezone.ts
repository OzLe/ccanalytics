/**
 * @module utils/timezone
 *
 * IANA timezone validation and resolution helpers (ACT-001 / SEM2-293).
 *
 * Background
 * ----------
 * `conversation_turns.timestamp` is a tz-naive `TIMESTAMP` whose value is the
 * stored ISO-8601 string with the trailing `Z` stripped (verified in
 * `batch-inserter.ts` / both adapters). The wall-clock value therefore IS the
 * UTC instant. EXTRACT(HOUR), CAST AS DATE, DATE_TRUNC on that column return
 * UTC math — not local-time math — and any UI that labels the result "1pm"
 * without a UTC tag is wrong by the user's offset.
 *
 * The fix (Option A — query-time projection) wraps every time math expression:
 *
 *     EXTRACT(HOUR FROM (ct.timestamp AT TIME ZONE 'UTC')
 *                       AT TIME ZONE $user_tz_param)
 *
 * The outer `AT TIME ZONE` projects a TIMESTAMPTZ back to a tz-naive local
 * TIMESTAMP, which is safe to feed into EXTRACT / CAST / DATE_TRUNC.
 *
 * This module owns the *validation* side: every IANA string that reaches the
 * SQL bind must be one the runtime accepts. We use `Intl.supportedValuesOf`
 * when the JS engine ships it (Node 18+), and fall back to a curated whitelist
 * + a strict regex for very old runtimes.
 */

/** The safe default when no timezone is configured. */
export const DEFAULT_TIMEZONE = "UTC";

/**
 * Curated fallback set of IANA zones for runtimes that don't expose
 * `Intl.supportedValuesOf('timeZone')`. Covers the common Mac/Linux defaults
 * plus the major continents. Not exhaustive — `isValidTimezone()` also tries
 * `Intl.DateTimeFormat` for anything not in the list.
 */
const FALLBACK_ZONES = new Set<string>([
  "UTC",
  "GMT",
  // Africa
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Lagos",
  "Africa/Nairobi",
  // Americas
  "America/Anchorage",
  "America/Argentina/Buenos_Aires",
  "America/Bogota",
  "America/Chicago",
  "America/Denver",
  "America/Halifax",
  "America/Los_Angeles",
  "America/Mexico_City",
  "America/New_York",
  "America/Phoenix",
  "America/Sao_Paulo",
  "America/St_Johns",
  "America/Toronto",
  "America/Vancouver",
  // Asia
  "Asia/Bangkok",
  "Asia/Dubai",
  "Asia/Hong_Kong",
  "Asia/Jakarta",
  "Asia/Jerusalem",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Kuala_Lumpur",
  "Asia/Manila",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Taipei",
  "Asia/Tehran",
  "Asia/Tokyo",
  "Asia/Yekaterinburg",
  // Australia / Pacific
  "Australia/Adelaide",
  "Australia/Brisbane",
  "Australia/Melbourne",
  "Australia/Perth",
  "Australia/Sydney",
  "Pacific/Auckland",
  "Pacific/Honolulu",
  // Europe
  "Europe/Amsterdam",
  "Europe/Athens",
  "Europe/Berlin",
  "Europe/Brussels",
  "Europe/Bucharest",
  "Europe/Budapest",
  "Europe/Copenhagen",
  "Europe/Dublin",
  "Europe/Helsinki",
  "Europe/Istanbul",
  "Europe/Lisbon",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Moscow",
  "Europe/Oslo",
  "Europe/Paris",
  "Europe/Prague",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Vienna",
  "Europe/Warsaw",
  "Europe/Zurich",
]);

/**
 * IANA timezone identifiers follow the form `Area/Location` (or single-word
 * legacy ids like `UTC`/`GMT`). This regex rejects anything with whitespace,
 * SQL-injection chars, or empty segments, even before we try to validate it
 * with `Intl.DateTimeFormat`. It's a defense-in-depth check, not the primary
 * gate.
 */
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z][A-Za-z0-9_+-]*){0,2}$/;

/**
 * Cached list of zones reported by `Intl.supportedValuesOf('timeZone')`, if
 * the runtime supports it. Computed lazily on first use.
 */
let supportedZonesCache: Set<string> | null | undefined;

function getSupportedZones(): Set<string> | null {
  if (supportedZonesCache !== undefined) return supportedZonesCache;
  // `Intl.supportedValuesOf` is ES2022; available on Node 18+. Guard for
  // older runtimes where it doesn't exist.
  const intlAny = Intl as unknown as {
    supportedValuesOf?: (key: string) => string[];
  };
  if (typeof intlAny.supportedValuesOf !== "function") {
    supportedZonesCache = null;
    return null;
  }
  try {
    const list = intlAny.supportedValuesOf("timeZone");
    supportedZonesCache = new Set(list);
  } catch {
    supportedZonesCache = null;
  }
  return supportedZonesCache;
}

/**
 * Validate that a string is a well-formed IANA timezone identifier the
 * runtime knows about.
 *
 * Strategy (most → least authoritative):
 *   1. Regex shape check (rejects garbage / SQL-injection attempts).
 *   2. Curated fallback whitelist (catches universal ids like `UTC`/`GMT`
 *      that `Intl.supportedValuesOf` excludes).
 *   3. `Intl.supportedValuesOf('timeZone')` if available.
 *   4. `new Intl.DateTimeFormat(undefined, {timeZone})` — throws on unknown.
 *      This catches both legacy aliases (`America/Argentina/Buenos_Aires`)
 *      that ICU resolves but `supportedValuesOf` reports only under the
 *      canonical name, AND the universal `UTC`/`GMT` ids.
 *
 * Returns `false` for empty strings, `null`, `undefined`, or invalid input.
 */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0) return false;
  if (!IANA_SHAPE.test(tz)) return false;

  // Whitelist short-circuits the universal ids and the common zones, so the
  // hot path doesn't hit Intl twice.
  if (FALLBACK_ZONES.has(tz)) return true;

  const supported = getSupportedZones();
  if (supported && supported.has(tz)) return true;

  // Constructor probe — throws on truly unknown ids, accepts legacy aliases.
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a raw timezone input to a validated IANA identifier, or
 * `DEFAULT_TIMEZONE` ("UTC") when the input is missing/invalid.
 *
 * This is the function called by every read path (parseFilters, CLI flag
 * resolver) so a bad value never reaches the SQL bind.
 */
export function resolveTimezone(raw: unknown): string {
  if (isValidTimezone(raw)) return raw;
  return DEFAULT_TIMEZONE;
}

/**
 * The UTC→local SQL projection fragment. Wrap any tz-naive TIMESTAMP column
 * with this when you need to extract local-time math from it.
 *
 *     const localTs = wrapTimestampForTz('ct.timestamp', '$3');
 *     // produces: ((ct.timestamp AT TIME ZONE 'UTC') AT TIME ZONE $3)
 *
 * The wrapping is the same everywhere — every route, every view, every CLI
 * query — so centralising it here lets us audit / change the strategy in one
 * place.
 */
export function wrapTimestampForTz(
  columnExpr: string,
  tzParamRef: string,
): string {
  return `((${columnExpr} AT TIME ZONE 'UTC') AT TIME ZONE ${tzParamRef})`;
}
