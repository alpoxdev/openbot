/**
 * What a computer is told about itself.
 *
 * Kept separate from the HTTP server so the exact environment boundary is testable without
 * starting a listener or connecting to Docker. Nothing here is caller-supplied: a request says
 * which Bot, never what to run or what to set.
 */

const NAMED = [
  "COMPUTER_TOKEN",
  "COMPUTER_BROWSER_MODE",
  "COMPUTER_MAX_BROWSERS",
  "COMPUTER_BROWSER_IDLE_MS",
  "CLOAKBROWSER_LICENSE_KEY",
  "CLOAKBROWSER_CACHE_DIR",
  "CLOAKBROWSER_AUTO_UPDATE",
  "CLOAKBROWSER_VERSION",
  "CLOAKBROWSER_RELEASE_CHANNEL",
  "CLOAKBROWSER_BINARY_PATH",
] as const;

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function environmentFor(
  botId: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const passthrough = Object.entries(env).filter(([key]) =>
    key.startsWith("EGRESS_PROXY"),
  );
  const spireSocketVolume = env.SPIRE_AGENT_SOCKET_VOLUME;
  return [
    `COMPUTER_BOT_ID=${botId}`,
    ...NAMED.flatMap((key) => {
      const value = present(env[key]);
      return value ? [`${key}=${value}`] : [];
    }),
    ...(spireSocketVolume
      ? ["SPIFFE_ENDPOINT_SOCKET=/tmp/spire-agent/public/api.sock"]
      : []),
    ...passthrough.map(([key, value]) => `${key}=${value ?? ""}`),
  ];
}
