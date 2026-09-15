import { afterAll, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/*
 * Base UI's platform and owner-document helpers are imported by the real Select before the test
 * body runs. Register Happy DOM here, while this fixture is the first dependency of the test, so
 * those helpers see a browser-like environment at module evaluation time rather than only after
 * the test's beforeAll hook.
 */
GlobalRegistrator.register({ url: "http://localhost/settings" });

afterAll(() => GlobalRegistrator.unregister());

/*
 * The settings screen's other sections reach for server state and are outside this test's scope.
 *
 * Mocking them keeps the test on the row it is about — and keeps it from failing for a reason that
 * has nothing to do with appearance, such as a query client or an unreachable API. The precedent is
 * `home-fallback-routing.fixture.tsx` next door.
 */
mock.module("@/components/settings/standing-instructions", () => ({
  StandingInstructions: () => <div data-testid="standing-instructions" />,
}));

mock.module("@/components/settings/conversation-import", () => ({
  ConversationImport: () => <div data-testid="conversation-import" />,
}));

mock.module("@/components/channels/imported-history", () => ({
  ImportedHistory: () => <div data-testid="imported-history" />,
}));
