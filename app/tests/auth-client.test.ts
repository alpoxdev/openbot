import { describe, expect, test } from "bun:test";
import { providerName, signInWith } from "@/lib/auth/client";

/*
 * A browser origin, which the sign-in call needs for its callback URL and this environment has no
 * window to supply. Stubbed rather than designed around: where the browser sends somebody back to
 * is the browser's own business, and threading it through as an argument would only move the same
 * value to the caller.
 */
(globalThis as { window?: unknown }).window = {
  location: { origin: "http://localhost:3010" },
};

/**
 * Starting sign-in for the env provider a deployment can configure.
 */
describe("signInWith", () => {
  test.each(["google"] as const)("starts %s through the same call", async (provider) => {
    const asked: string[] = [];

    await signInWith(provider, async (input) => {
      asked.push(input.provider);
      return {};
    });

    expect(asked).toEqual([provider]);
  });

  test("sends the browser back where it started", async () => {
    let callbackURL = "";

    await signInWith("google", async (input) => {
      callbackURL = input.callbackURL;
      return {};
    });

    expect(callbackURL).toBe("http://localhost:3010");
  });

  test("throws what the client said when it refuses", async () => {
    const refuse = async () => ({
      error: { message: "That provider is not configured." },
    });

    expect(signInWith("google", refuse)).rejects.toThrow(
      "That provider is not configured.",
    );
  });

  /**
   * A refusal with nothing to say still has to name the provider.
   */
  test("names the provider when the client says nothing", async () => {
    const refuse = async () => ({ error: {} });

    expect(signInWith("google", refuse)).rejects.toThrow("Google");
  });

  test("resolves quietly when the redirect is under way", async () => {
    expect(
      signInWith("google", async () => ({ error: null })),
    ).resolves.toBeUndefined();
  });
});

describe("providerName", () => {
  test("gives each provider the name people call it", () => {
    expect(providerName("google")).toBe("Google");
  });
});
