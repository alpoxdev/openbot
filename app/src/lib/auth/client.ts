import { ssoClient } from "@better-auth/sso/client";
import { createAuthClient } from "better-auth/react";
import type { AuthProviderId } from "./queries";

export const authClient = createAuthClient({ plugins: [ssoClient()] });

/** What each provider is called on the button, since none of them are called by their id. */
const PROVIDER_NAMES: Record<AuthProviderId, string> = {
  google: "Google",
};

export function providerName(provider: AuthProviderId): string {
  return PROVIDER_NAMES[provider];
}

/** What a sign-in attempt came back with, which is either nothing or a reason. */
type SocialResult = { error?: { message?: string } | null };

/**
 * Start sign-in with Google.
 *
 * `start` is injectable because Better Auth's client is a proxy, so a test cannot replace the method
 * on it. Named so it cannot shadow anything it defaults to.
 */
export async function signInWith(
  provider: AuthProviderId,
  start: (input: {
    provider: string;
    callbackURL: string;
  }) => Promise<SocialResult> = (input) =>
    authClient.signIn.social(input as never) as Promise<SocialResult>,
) {
  const result = await start({
    provider,
    callbackURL: window.location.origin,
  });
  if (result.error) {
    // Naming the provider still matters if the client refuses: "Could not start sign-in" leaves
    // somebody looking at the button with no idea which one failed.
    throw new Error(
      result.error.message ||
        `Could not start ${providerName(provider)} sign-in.`,
    );
  }
}

/**
 * Start sign-in through whichever identity provider covers this address.
 *
 * The email is not a credential here and no password is asked for: only the part after the @ is
 * used, to decide which registered provider to hand somebody to. A company with two IdPs mid-merger
 * has two domains, and this is how somebody reaches theirs without being asked which one they are.
 *
 * Injectable for the same reason as `signInWith`: the Better Auth client is a proxy.
 */
export async function signInWithEmailDomain(
  email: string,
  start: (input: {
    email: string;
    callbackURL: string;
  }) => Promise<SocialResult> = (input) =>
    (
      authClient as unknown as {
        signIn: { sso: (i: unknown) => Promise<SocialResult> };
      }
    ).signIn.sso(input),
) {
  const result = await start({ email, callbackURL: window.location.origin });

  if (result.error) {
    throw new Error(
      result.error.message ||
        "No identity provider is registered for that address.",
    );
  }
}
