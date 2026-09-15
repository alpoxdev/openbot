import { afterAll, mock, spyOn } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/*
 * Base UI's platform and owner-document helpers are imported by the real Select before the test
 * body runs. This fixture is dynamically imported by the child test process, so registration is
 * complete before any DOM-sensitive application module is evaluated.
 */
GlobalRegistrator.register({ url: "http://localhost/settings" });

/*
 * ImportedHistory is also rendered by the Bot route and the account-free acceptance test. A
 * process-wide module mock here survives this file and replaces their real history view, so use a
 * restorable namespace spy instead.
 */
const ImportedHistoryModule = await import(
  "@/components/channels/imported-history"
);
const importedHistory = spyOn(
  ImportedHistoryModule,
  "ImportedHistory",
).mockImplementation(() => <div data-testid="imported-history" />);

afterAll(() => {
  importedHistory.mockRestore();
  GlobalRegistrator.unregister();
});

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
