import { describe, expect, test } from "bun:test";
import { environmentFor } from "../src/environment";

describe("what the supervisor tells a computer about its browser", () => {
  test("passes the deployment's browser mode to every per-Bot computer", () => {
    expect(
      environmentFor("invoice-collector", {
        COMPUTER_TOKEN: "secret",
        COMPUTER_BROWSER_MODE: "headed",
      }),
    ).toEqual([
      "COMPUTER_BOT_ID=invoice-collector",
      "HOME=/profiles",
      "COMPUTER_TOKEN=secret",
      "COMPUTER_BROWSER_MODE=headed",
    ]);
  });

  test("does not invent a browser mode when the deployment left it unset", () => {
    expect(
      environmentFor("invoice-collector", { COMPUTER_TOKEN: "secret" }),
    ).toEqual([
      "COMPUTER_BOT_ID=invoice-collector",
      "HOME=/profiles",
      "COMPUTER_TOKEN=secret",
    ]);
  });

  test("forwards named Cloak and cap settings when they are set", () => {
    expect(
      environmentFor("invoice-collector", {
        COMPUTER_TOKEN: "secret",
        CLOAKBROWSER_LICENSE_KEY: "lic",
        CLOAKBROWSER_CACHE_DIR: "/profiles/.cloakbrowser",
        CLOAKBROWSER_AUTO_UPDATE: "false",
        CLOAKBROWSER_VERSION: "146.0.7680.177.5",
        CLOAKBROWSER_RELEASE_CHANNEL: "stable",
        CLOAKBROWSER_BINARY_PATH: "/opt/cloak/chrome",
        COMPUTER_MAX_BROWSERS: "4",
        COMPUTER_BROWSER_IDLE_MS: "0",
      }),
    ).toEqual([
      "COMPUTER_BOT_ID=invoice-collector",
      "HOME=/profiles",
      "COMPUTER_TOKEN=secret",
      "COMPUTER_MAX_BROWSERS=4",
      "COMPUTER_BROWSER_IDLE_MS=0",
      "CLOAKBROWSER_LICENSE_KEY=lic",
      "CLOAKBROWSER_CACHE_DIR=/profiles/.cloakbrowser",
      "CLOAKBROWSER_AUTO_UPDATE=false",
      "CLOAKBROWSER_VERSION=146.0.7680.177.5",
      "CLOAKBROWSER_RELEASE_CHANNEL=stable",
      "CLOAKBROWSER_BINARY_PATH=/opt/cloak/chrome",
    ]);
  });

  test("omits empty Cloak keys and never forwards SKIP_CHECKSUM", () => {
    const env = environmentFor("invoice-collector", {
      COMPUTER_TOKEN: "secret",
      CLOAKBROWSER_LICENSE_KEY: "  ",
      CLOAKBROWSER_SKIP_CHECKSUM: "true",
    });
    expect(env).toEqual([
      "COMPUTER_BOT_ID=invoice-collector",
      "HOME=/profiles",
      "COMPUTER_TOKEN=secret",
    ]);
    expect(env.join("\n")).not.toContain("SKIP_CHECKSUM");
  });
});
