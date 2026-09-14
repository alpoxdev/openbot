import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCloakPersistentLaunchOptions,
  fingerprintSeedFromProfile,
} from "../src/cloak-launch";

async function tempProfile(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openbot-cloak-"));
}

describe("Cloak launch options", () => {
  test("sandbox on omits --no-sandbox and enables chromiumSandbox", () => {
    const options = buildCloakPersistentLaunchOptions({
      userDataDir: "/profiles/bot",
      headless: true,
      sandboxEnabled: true,
      seed: 12345,
    });
    expect(options.args.filter((arg) => arg === "--no-sandbox")).toEqual([]);
    expect(options.launchOptions.chromiumSandbox).toBe(true);
    expect(options.stealthArgs).toBe(false);
    expect(options.humanize).toBe(false);
    expect(options.geoip).toBe(false);
    expect("ignoreDefaultArgs" in options).toBe(false);
    expect(options.viewport).toEqual({ width: 1280, height: 800 });
    expect(options.launchOptions.handleSIGTERM).toBe(false);
    expect(options.launchOptions.handleSIGINT).toBe(false);
    expect(options.launchOptions.handleSIGHUP).toBe(false);
    expect(options.args).toContain("--fingerprint=12345");
    expect(options.args).toContain("--password-store=basic");
    expect(options.args).toContain("--disable-dev-shm-usage");
  });

  test("sandbox off adds exactly one --no-sandbox", () => {
    const options = buildCloakPersistentLaunchOptions({
      userDataDir: "/profiles/bot",
      headless: true,
      sandboxEnabled: false,
      seed: 12345,
    });
    expect(options.args.filter((arg) => arg === "--no-sandbox")).toEqual([
      "--no-sandbox",
    ]);
    expect(options.launchOptions.chromiumSandbox).toBe(false);
  });

  test("the same seed produces the same --fingerprint", () => {
    const first = buildCloakPersistentLaunchOptions({
      userDataDir: "/a",
      headless: true,
      sandboxEnabled: true,
      seed: 55555,
    });
    const second = buildCloakPersistentLaunchOptions({
      userDataDir: "/b",
      headless: true,
      sandboxEnabled: true,
      seed: 55555,
    });
    expect(first.args.filter((arg) => arg.startsWith("--fingerprint="))).toEqual(
      ["--fingerprint=55555"],
    );
    expect(second.args.filter((arg) => arg.startsWith("--fingerprint="))).toEqual(
      ["--fingerprint=55555"],
    );
  });

  test("headed adds --ignore-gpu-blocklist", () => {
    const headed = buildCloakPersistentLaunchOptions({
      userDataDir: "/profiles/bot",
      headless: false,
      sandboxEnabled: true,
      seed: 12345,
    });
    const headless = buildCloakPersistentLaunchOptions({
      userDataDir: "/profiles/bot",
      headless: true,
      sandboxEnabled: true,
      seed: 12345,
    });
    expect(headed.args).toContain("--ignore-gpu-blocklist");
    expect(headless.args).not.toContain("--ignore-gpu-blocklist");
  });

  test("a proxy is included only when provided", () => {
    const without = buildCloakPersistentLaunchOptions({
      userDataDir: "/profiles/bot",
      headless: true,
      sandboxEnabled: true,
      seed: 12345,
    });
    const withProxy = buildCloakPersistentLaunchOptions({
      userDataDir: "/profiles/bot",
      headless: true,
      sandboxEnabled: true,
      seed: 12345,
      proxy: { server: "http://proxy.internal:8080", username: "bot", password: "s3cret" },
    });
    expect("proxy" in without).toBe(false);
    expect(withProxy.proxy).toEqual({
      server: "http://proxy.internal:8080",
      username: "bot",
      password: "s3cret",
    });
  });
});

describe("the fingerprint seed stored on a profile", () => {
  test("a missing file writes schemaVersion 1 and a seed in range", async () => {
    const dir = await tempProfile();
    const seed = await fingerprintSeedFromProfile(dir);
    expect(seed).toBeGreaterThanOrEqual(10_000);
    expect(seed).toBeLessThan(100_000);
    const written = JSON.parse(
      await readFile(join(dir, ".openbot-cloak.json"), "utf8"),
    ) as { schemaVersion: number; fingerprintSeed: number };
    expect(written).toEqual({ schemaVersion: 1, fingerprintSeed: seed });
    expect(await fingerprintSeedFromProfile(dir)).toBe(seed);
  });

  test("malformed JSON throws rather than minting a new identity", async () => {
    const dir = await tempProfile();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, ".openbot-cloak.json"),
      JSON.stringify({ schemaVersion: 1, fingerprintSeed: "nope" }),
    );
    await expect(fingerprintSeedFromProfile(dir)).rejects.toThrow(/malformed/);
  });
});
