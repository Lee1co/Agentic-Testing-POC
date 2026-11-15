export class DisallowedHostError extends Error {
  constructor(url: string) {
    super(`Refusing to access ${url}: host is not in ALLOWED_HOSTS`);
    this.name = 'DisallowedHostError';
  }
}

export function isAllowedUrl(url: string | URL, allowedHosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return false;
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'about:') return true;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return allowedHosts.includes(parsed.hostname.toLowerCase());
}

/** Resolves a path (or absolute URL) against the base URL and enforces the allowlist. */
export function resolveAppUrl(baseUrl: string, pathOrUrl: string, allowedHosts: readonly string[]): string {
  const resolved = new URL(pathOrUrl || '/', `${baseUrl.replace(/\/+$/, '')}/`).toString();
  if (!isAllowedUrl(resolved, allowedHosts)) {
    throw new DisallowedHostError(resolved);
  }
  return resolved;
}

/** Absolute http(s) URLs referenced in source code. Used to keep generated tests on approved hosts. */
export function findExternalUrls(code: string, allowedHosts: readonly string[]): string[] {
  const matches = code.match(/https?:\/\/[^\s'"`)]+/g) ?? [];
  return [...new Set(matches.filter((url) => !isAllowedUrl(url, allowedHosts)))];
}
