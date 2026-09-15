/**
 * Whether a typed address is an OpenBot site this window may open.
 *
 * Sibling of `isHttpEndpointUrl`, which still admits any http(s) host for BYO harnesses and
 * OpenAI-compatible model endpoints. This one is stricter: company hosts must be https; http is
 * only for loopback, so a local other process can be opened without pretending LAN HTTP is allowed.
 */
export function isOpenBotSiteUrl(value: string): boolean {
  return openBotSiteUrl(value) !== null;
}

export function openBotSiteUrl(value: string): string | null {
  if (value.split("").some((character) => character.charCodeAt(0) < 32)) {
    return null;
  }
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    if (url.username || url.password) return null;
    if (/\s/.test(decodeURIComponent(url.hostname))) return null;
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
