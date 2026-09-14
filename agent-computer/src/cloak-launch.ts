import { randomInt } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDefaultStealthArgs } from "cloakbrowser";
import type { Egress } from "./egress";
import { VIEWPORT } from "./viewport";

const SEED_FILE = ".openbot-cloak.json";
const SEED_MIN = 10_000;
const SEED_MAX_EXCLUSIVE = 100_000;

type FingerprintFile = {
  schemaVersion: 1;
  fingerprintSeed: number;
};

function isFingerprintSeed(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= SEED_MIN &&
    value < SEED_MAX_EXCLUSIVE
  );
}

/**
 * The Cloak fingerprint seed stored in a Bot's profile, minted once and reused.
 *
 * Same seed, same `--fingerprint`. A new identity on every launch would look like a
 * different machine after every eviction. A malformed file is refused rather than
 * overwritten: guessing a new seed would silently change who the browser is.
 */
export async function fingerprintSeedFromProfile(
  profileDir: string,
): Promise<number> {
  const path = join(profileDir, SEED_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(profileDir, { recursive: true });
    const fingerprintSeed = randomInt(SEED_MIN, SEED_MAX_EXCLUSIVE);
    const body: FingerprintFile = { schemaVersion: 1, fingerprintSeed };
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(body)}\n`, "utf8");
    await rename(tmp, path);
    return fingerprintSeed;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The Cloak fingerprint file at ${path} is not valid JSON.`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !isFingerprintSeed((parsed as { fingerprintSeed?: unknown }).fingerprintSeed)
  ) {
    throw new Error(`The Cloak fingerprint file at ${path} is malformed.`);
  }
  return (parsed as FingerprintFile).fingerprintSeed;
}

function stealthArgsFor(seed: number, sandboxEnabled: boolean, headless: boolean): string[] {
  const args = getDefaultStealthArgs().filter((arg) => {
    if (arg === "--no-sandbox") return false;
    if (arg === "--fingerprint" || arg.startsWith("--fingerprint=")) return false;
    return true;
  });
  args.push(`--fingerprint=${seed}`);
  if (!sandboxEnabled) args.push("--no-sandbox");
  args.push("--password-store=basic", "--disable-dev-shm-usage");
  if (headless === false) args.push("--ignore-gpu-blocklist");
  return args;
}

/**
 * Options handed to `cloakbrowser.launchPersistentContext`.
 *
 * `stealthArgs` is off so Cloak does not inject a random fingerprint and `--no-sandbox`.
 * `ignoreDefaultArgs` is omitted: a caller list replaces Cloak's, rather than merging.
 */
export function buildCloakPersistentLaunchOptions(input: {
  userDataDir: string;
  headless: boolean;
  sandboxEnabled: boolean;
  proxy?: Egress;
  seed: number;
}) {
  return {
    userDataDir: input.userDataDir,
    headless: input.headless,
    viewport: VIEWPORT,
    stealthArgs: false as const,
    humanize: false as const,
    geoip: false as const,
    args: stealthArgsFor(input.seed, input.sandboxEnabled, input.headless),
    ...(input.proxy ? { proxy: input.proxy } : {}),
    launchOptions: {
      chromiumSandbox: input.sandboxEnabled,
      handleSIGTERM: false,
      handleSIGINT: false,
      handleSIGHUP: false,
    },
  };
}
