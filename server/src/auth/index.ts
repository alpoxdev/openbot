import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { eq, sql } from "drizzle-orm";
import type { AuditEventInput, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import {
  accounts,
  sessions,
  ssoProviders,
  users,
  verifications,
} from "../db/schema";
import { encryptSsoConfig } from "./encrypt-sso-config";
import { applyConfiguredAdmin, seedRole } from "./roles";

/**
 * Write a row about a sign-in, and never let the writing of it stop one.
 *
 * These run inside Better Auth's own hooks, where a thrown error becomes a refused sign-in. A trail
 * that is briefly unavailable must not lock everybody out of the deployment, so the failure is
 * logged where an operator will see it and the sign-in continues.
 */
async function record(
  auditStore: AuditStore | undefined,
  event: AuditEventInput,
): Promise<void> {
  if (!auditStore) return;
  try {
    await recordAuditEvent(auditStore, event);
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "sign-in-audit-write-failed",
        eventType: event.eventType,
        error: String(error),
      }),
    );
  }
}

export async function stampSignIn(
  database: Database,
  userId: string,
  at: Date,
): Promise<void> {
  try {
    await database
      .update(users)
      .set({
        lastSignedInAt: sql`greatest(coalesce(${users.lastSignedInAt}, ${at}), ${at})`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "sign-in-stamp-write-failed",
        userId,
        error: String(error),
      }),
    );
  }
}

/**
 * Identity providers a company registers while this is running, by SAML or OIDC.
 *
 * Always on, because it has nothing to configure from the environment: what it can do depends
 * entirely on what an administrator has registered, and an empty table means it offers nothing.
 * Turning it on and off would only mean a deployment could hold a registered IdP that silently
 * stopped working.
 */
export function createAuth(
  config: DeploymentConfig,
  database: Database,
  /**
   * Whether an administrator has removed this address.
   *
   * Checked here rather than only in the request guard, because a removed person whose sign-in
   * still succeeds gets a session, a user row and a place in the list: the removal would read as
   * having worked while quietly not having.
   */
  isRevoked?: (email: string) => Promise<boolean>,
  /**
   * Where getting in, and being turned away, are written down.
   *
   * Sign-in was the one thing this deployment did that left no trace. Two questions could not be
   * answered at all: who granted themselves the administrator role by editing the configuration, and
   * whether a person somebody has just removed had ever been here, because removing them deletes the
   * sessions that were the only evidence.
   *
   * Optional and never fatal. A trail that is unavailable must not stop somebody signing in, so every
   * write below is guarded and its failure is logged rather than raised.
   */
  auditStore?: AuditStore,
) {
  const authConfig = config.auth;
  if (!authConfig) {
    throw new Error("No identity provider is configured.");
  }

  const plugins = [
    /*
     * Identity providers a company registers while this is running, by SAML or OIDC.
     *
     * Always on, because it has nothing to configure: what it can do depends entirely on what an
     * administrator has registered, and an empty table means it offers nothing. Turning it on and
     * off would only mean a deployment could hold a registered IdP that silently stopped working.
     *
     * `provisionUser` runs when somebody arrives through one of them. Their role has to be written
     * here or they land with no role at all and the request guard refuses them with a 403, which
     * reads as a broken deployment rather than a first sign-in.
     */
    sso({
      provisionUser: async ({ user }) => {
        await seedRole(
          database,
          user.id,
          user.email,
          authConfig.initialAdminEmails,
        );
      },
    }),
  ];

  return betterAuth({
    baseURL: authConfig.baseUrl,
    secret: authConfig.secret,
    trustedOrigins: authConfig.trustedOrigins,
    /*
     * Wrapped, so a company's client secret is ciphertext in the column.
     *
     * The SSO plugin writes `oidc_config` and `saml_config` as plaintext JSON, and the client secret
     * for a customer's directory is inside them. Every other secret this deployment keeps goes
     * through `KEY_ENCRYPTION_KEY`; these two were the exception. See encrypt-sso-config.ts.
     */
    database: encryptSsoConfig(
      drizzleAdapter(database, {
        provider: "pg",
        usePlural: true,
        schema: { users, sessions, accounts, verifications, ssoProviders },
      }),
      config.keyEncryptionKey,
    ),
    account: {
      /*
       * The provider's access and refresh tokens, encrypted at rest.
       *
       * Better Auth's own mechanism, which uses `BETTER_AUTH_SECRET` rather than
       * `KEY_ENCRYPTION_KEY`. Deliberately theirs: it encrypts on the way into storage and decrypts
       * on the way out, in the one place that knows every path a token takes, and hand-rolling that
       * inside somebody else's storage layer is how rows become permanently unreadable. It also
       * tolerates the plaintext already in the column, so switching it on does not invalidate the
       * accounts of everybody who has already signed in.
       */
      encryptOAuthTokens: true,
    },
    plugins,
    socialProviders: {
      ...(authConfig.google ? { google: authConfig.google } : {}),
    },
    databaseHooks: {
      user: {
        create: {
          /*
           * Refuse before the account exists.
           *
           * Somebody removed and then signing in again would otherwise arrive as a brand-new person
           * with a fresh id, no role and no memory of having been removed, which is why the deny
           * list is keyed on the address rather than the id.
           */
          before: async (user) => {
            if (await isRevoked?.(user.email)) {
              // The row a removed person coming back produces. Nothing else records the attempt:
              // no user row is written and no session exists to look at afterwards.
              await record(auditStore, {
                eventType: "session.refused",
                targetType: "person",
                payload: {
                  email: user.email,
                  reason: "access removed by an administrator",
                },
              });
              throw new APIError("FORBIDDEN", {
                message: "Your access to this deployment has been removed.",
              });
            }
            return { data: user };
          },
          after: async (user) => {
            /*
             * Who is an administrator is decided by email, not by which provider signed them in.
             */
            await seedRole(
              database,
              user.id,
              user.email,
              authConfig.initialAdminEmails,
            );
          },
        },
      },
      session: {
        create: {
          /*
           * And again for somebody who already has an account. The user hook above only fires for a
           * new one, so without this a removed person signs straight back in.
           */
          before: async (session) => {
            const [user] = await database
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, session.userId))
              .limit(1);
            if (user && (await isRevoked?.(user.email))) {
              await record(auditStore, {
                eventType: "session.refused",
                targetType: "person",
                targetId: session.userId,
                actorUserId: session.userId,
                payload: {
                  email: user.email,
                  reason: "access removed by an administrator",
                },
              });
              throw new APIError("FORBIDDEN", {
                message: "Your access to this deployment has been removed.",
              });
            }
            return { data: session };
          },
          after: async (session) => {
            await stampSignIn(database, session.userId, session.createdAt);

            /*
             * The configured floor, re-applied on every sign-in. Editing the list has to mean
             * something for people already in the table, or adding yourself after you first signed
             * in silently does nothing. Only promotes, and only addresses the list names: everybody
             * else's role belongs to the admin screen.
             */
            const promoted = await applyConfiguredAdmin(
              database,
              session.userId,
              authConfig.initialAdminEmails,
            );

            const [user] = await database
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, session.userId))
              .limit(1);

            /*
             * The promotion, on the trail.
             *
             * The floor is applied silently by design, which meant anybody who could edit
             * `INITIAL_ADMIN_EMAILS` made themselves an administrator and nothing anywhere said so.
             * Written only when the role actually changed, so a returning administrator does not
             * produce one of these on every sign-in.
             */
            if (promoted) {
              await record(auditStore, {
                eventType: "person.admin_by_configuration",
                targetType: "person",
                targetId: session.userId,
                actorUserId: session.userId,
                payload: {
                  email: user?.email,
                  reason:
                    "this address is named in INITIAL_ADMIN_EMAILS, so the configuration granted it",
                },
              });
            }

            await record(auditStore, {
              eventType: "session.signed_in",
              targetType: "person",
              targetId: session.userId,
              actorUserId: session.userId,
              payload: { email: user?.email },
            });
          },
        },
      },
    },
  });
}
