import { VoiceBridgeError } from '../errors.ts';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const PATH_PATTERN = /^\/[A-Za-z0-9._~\-/]*$/;

/**
 * Validates a backend base URL from **server-side configuration** (never from clients, tokens,
 * metadata, speech, or LLM output).
 *
 * Rules: `https:`, or `http:` only for loopback hosts; no embedded credentials, query, or fragment.
 * Returns the normalized URL without a trailing slash.
 */
export function parseBackendBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VoiceBridgeError('config_error', 'backend baseUrl is not a valid URL');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new VoiceBridgeError(
      'config_error',
      'backend baseUrl must use https (http is allowed only for localhost)',
    );
  }
  if (url.username || url.password) {
    throw new VoiceBridgeError('config_error', 'backend baseUrl must not contain credentials');
  }
  if (url.search || url.hash) {
    throw new VoiceBridgeError(
      'config_error',
      'backend baseUrl must not contain a query or fragment',
    );
  }
  return url.href.replace(/\/+$/, '');
}

/** Validates a configured endpoint path: absolute, safe characters, no `..` segments, no `//`. */
export function assertEndpointPath(path: string): string {
  if (!PATH_PATTERN.test(path) || path.split('/').includes('..') || path.includes('//')) {
    throw new VoiceBridgeError(
      'config_error',
      'endpoint path must be an absolute path without ".." or "//"',
    );
  }
  return path;
}

export function joinUrl(base: string, path: string): string {
  return `${base}${assertEndpointPath(path)}`;
}
