/** Default: the M4 host token route on loopback (`examples/host-token-route`). */
export const DEFAULT_TOKEN_ENDPOINT = 'http://127.0.0.1:8790/api/voice/token';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validates the token endpoint at build time. It must be `https`, or `http` only on a loopback
 * host, and carry no credentials, query string, or fragment. The endpoint is fixed at build time:
 * nothing at runtime (URL parameters, user input, server responses) can change it.
 */
export function resolveTokenEndpoint(raw: string | undefined): string {
  const value = raw?.trim() || DEFAULT_TOKEN_ENDPOINT;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('NEXT_PUBLIC_VB_TOKEN_ENDPOINT is not a valid URL');
  }
  const local = LOCAL_HOSTNAMES.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('NEXT_PUBLIC_VB_TOKEN_ENDPOINT must use https (http is allowed for localhost)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'NEXT_PUBLIC_VB_TOKEN_ENDPOINT must not contain credentials, a query, or a fragment',
    );
  }
  return url.toString();
}

/** How long to wait for the token route before giving up. */
export const TOKEN_TIMEOUT_MS = 10_000;
/** How long to wait from "credentials received" until the agent is listening. */
export const CONNECT_TIMEOUT_MS = 30_000;
/** The SDK marks the agent as failed if it has not joined within this time. */
export const AGENT_JOIN_TIMEOUT_MS = 20_000;
/** Longest typed question accepted. Matches the order of magnitude a spoken turn would produce. */
export const MAX_TYPED_MESSAGE_LENGTH = 500;
