export const DEFAULT_GITHUB_SERVER_URL = 'https://github.com';

export type GitHubEndpoints = {
  webBase: string;
  apiBase: string;
};

export function normalizeServerUrl(input: string): string {
  const trimmed = (input ?? '').trim();
  if (!trimmed) {
    return DEFAULT_GITHUB_SERVER_URL;
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withScheme);
    // Reducing to the origin drops a pasted /api/v3 path, query, and trailing
    // slashes. url.host keeps a non-default port for self-hosted servers.
    return `${url.protocol}//${url.host}`;
  } catch {
    return DEFAULT_GITHUB_SERVER_URL;
  }
}

export function deriveEndpoints(serverUrl: string): GitHubEndpoints {
  const webBase = normalizeServerUrl(serverUrl);
  const url = new URL(webBase);
  const host = url.hostname.toLowerCase();

  if (host === 'github.com' || host === 'api.github.com') {
    return { webBase: DEFAULT_GITHUB_SERVER_URL, apiBase: 'https://api.github.com' };
  }

  // Enterprise Cloud with data residency serves REST from an api. subdomain.
  if (host.endsWith('.ghe.com')) {
    const webHost = host.startsWith('api.') ? host.slice(4) : host;
    return { webBase: `${url.protocol}//${webHost}`, apiBase: `${url.protocol}//api.${webHost}` };
  }

  // Enterprise Server serves REST under /api/v3 on the same host.
  return { webBase, apiBase: `${webBase}/api/v3` };
}
