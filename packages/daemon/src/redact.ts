/**
 * Header redaction for captured network requests.
 *
 * Fixed default, no UI opt-out (see blueprint Section 5, Security): these
 * header names carry credentials that would be catastrophic to have flow
 * into a model's context or a log file, so this isn't configurable the way
 * the trusted-port list or the allow-list is. Beyond the core three
 * (Authorization, Cookie, Set-Cookie), it covers the common proxy-auth,
 * API-key, session-token and CSRF-token headers.
 *
 * Caveat, documented rather than silently overpromised: this only redacts
 * header *values*. A token sitting in a URL query string or in a request/
 * response body is not covered — that's why captured logs stay in-memory
 * only by default (see ringBuffer.ts and the blueprint's "Log persistence"
 * decision).
 */

const REDACTED_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-amz-security-token",
]);
const REDACTED_VALUE = "[redacted]";

export function redactHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = REDACTED_HEADER_NAMES.has(name.toLowerCase()) ? REDACTED_VALUE : value;
  }
  return out;
}

/** Best-effort redaction of obviously token-shaped query-string parameters
 * in a URL, e.g. `?api_key=...`, `?token=...`, `?access_token=...`. This is
 * NOT a guarantee — arbitrary custom parameter names won't be caught — and
 * is only ever applied by the opt-in recording feature (not the default
 * ring-buffer capture path), so it's labeled honestly rather than relied on
 * as a security boundary. */
const TOKEN_LIKE_PARAM_NAMES = new Set([
  "token",
  "access_token",
  "api_key",
  "apikey",
  "secret",
  "password",
  "auth",
]);

export function redactTokenLikeQueryParams(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of Array.from(url.searchParams.keys())) {
      if (TOKEN_LIKE_PARAM_NAMES.has(key.toLowerCase())) {
        url.searchParams.set(key, "redacted");
      }
    }
    return url.toString();
  } catch {
    // Not a parseable absolute URL — return as-is rather than throw.
    return rawUrl;
  }
}
