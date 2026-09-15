import { afterAll, afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { ComponentType } from "react";

type ChildResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const expectedCases = [
  "the row shows the current choice as a word, not the stored value",
  "the control is a labelled combobox a keyboard can reach",
  "keyboard opens exactly the three appearance options with System selected",
  "keyboard selection persists Dark and updates the applied appearance",
  "the old two-state switch is gone from the row",
  "the trigger is labelled and the row explains what the current choice means",
  "an explicit stored choice is what the row explains",
] as const;

const childMode = process.env.APPEARANCE_SETTING_CHILD === "1";

if (!childMode) {
  const driverPath = fileURLToPath(
    new URL("./appearance-setting-driver.test.ts", import.meta.url),
  );

  function childEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {
      APPEARANCE_SETTING_CHILD: "1",
    };
    if (process.env.PATH) environment.PATH = process.env.PATH;
    if (process.platform === "win32") {
      for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
        const value = process.env[name];
        if (value) environment[name] = value;
      }
    }
    return environment;
  }

  async function runChild(): Promise<ChildResult> {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", "--no-env-file", driverPath],
      env: childEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  function casesFrom(stdout: string): string[] {
    const line = stdout
      .split("\n")
      .find((entry) => entry.startsWith("APPEARANCE_SETTING_CASES "));
    if (!line) throw new Error(`missing appearance case marker in:\n${stdout}`);
    return JSON.parse(
      line.slice("APPEARANCE_SETTING_CASES ".length),
    ) as string[];
  }

  test("appearance setting cases run in an isolated child process", async () => {
    const child = await runChild();

    expect(child.exitCode).toBe(0);
    expect(casesFrom(child.stdout).sort()).toEqual([...expectedCases].sort());
  });
} else {
  await import("./appearance-setting.fixture");

  const { cleanup, render, waitFor, within } = await import(
    "@testing-library/react"
  );
  const { default: userEvent } = await import("@testing-library/user-event");
  const { ThemeProvider } = await import("@/components/theme-provider");
  const { THEME_STORAGE_KEY } = await import("@/lib/theme");
  const { Route: SettingsRoute } = await import(
    "@/routes/_authed/settings/index"
  );
  const SettingsScreen = SettingsRoute.options.component as ComponentType;

  if (!SettingsScreen) throw new Error("the settings route has no component");

  /* Keep every case on the same concrete route component. */
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  function renderSettings() {
    return render(
      <ThemeProvider>
        <SettingsScreen />
      </ThemeProvider>,
    );
  }

  const executedCases = new Set<string>();
  function appearanceCase(
    name: (typeof expectedCases)[number],
    body: () => void | Promise<void>,
  ) {
    test(name, async () => {
      executedCases.add(name);
      await body();
    });
  }

  afterAll(() => {
    console.log(
      `APPEARANCE_SETTING_CASES ${JSON.stringify([...executedCases])}`,
    );
  });

  appearanceCase(
    "the row shows the current choice as a word, not the stored value",
    () => {
      const { getByRole } = renderSettings();

      // The label map is what turns a stored `system` into the word a person reads. Without it the
      // closed trigger would say "system".
      const trigger = getByRole("combobox");
      expect(trigger.textContent).toContain("System");
      expect(trigger.textContent).not.toContain("openbot-theme");
    },
  );

  appearanceCase(
    "the control is a labelled combobox a keyboard can reach",
    () => {
      const { getByRole } = renderSettings();

      const trigger = getByRole("combobox");

      expect(trigger.getAttribute("aria-label") ?? "").toContain("Appearance");
      // Not disabled and focusable: the row is operable without a pointer.
      expect(trigger.hasAttribute("disabled")).toBe(false);
      expect(trigger.getAttribute("tabindex")).not.toBe("-1");
    },
  );

  appearanceCase(
    "keyboard opens exactly the three appearance options with System selected",
    async () => {
      const view = renderSettings();
      const trigger = view.getByRole("combobox", { name: "Appearance" });
      const ownerDocument = trigger.ownerDocument;
      const user = userEvent.setup({ document: ownerDocument });

      trigger.focus();
      expect(ownerDocument.activeElement).toBe(trigger);
      await user.keyboard("{ArrowDown}");

      const options = await within(ownerDocument.body).findAllByRole("option");
      expect(options.map((option) => option.textContent?.trim())).toEqual([
        "System",
        "Light",
        "Dark",
      ]);

      const selected = options.filter(
        (option) => option.getAttribute("aria-selected") === "true",
      );
      expect(selected).toHaveLength(1);
      expect(selected[0]?.textContent?.trim()).toBe("System");
    },
  );

  appearanceCase(
    "keyboard selection persists Dark and updates the applied appearance",
    async () => {
      const view = renderSettings();
      const trigger = view.getByRole("combobox", { name: "Appearance" });
      const ownerDocument = trigger.ownerDocument;
      const user = userEvent.setup({ document: ownerDocument });

      trigger.focus();
      await user.keyboard("{ArrowDown}");
      await within(ownerDocument.body).findAllByRole("option");
      await user.keyboard("{End}");
      await user.keyboard("{Enter}");

      await waitFor(() => {
        expect(trigger.textContent).toContain("Dark");
        expect(
          ownerDocument.defaultView?.localStorage.getItem(THEME_STORAGE_KEY),
        ).toBe("dark");
        expect(ownerDocument.documentElement.classList.contains("dark")).toBe(
          true,
        );
        expect(view.getByText(/Always dark/i)).toBeTruthy();
      });
    },
  );

  appearanceCase("the old two-state switch is gone from the row", () => {
    const { queryByRole, queryByText } = renderSettings();

    // A leftover `Switch` would mean the row still had two states, which cannot express `system`.
    expect(queryByRole("switch")).toBeNull();
    expect(queryByText("Dark theme")).toBeNull();
  });

  appearanceCase(
    "the trigger is labelled and the row explains what the current choice means",
    () => {
      const { getByLabelText, getByText } = renderSettings();

      expect(getByLabelText("Appearance")).toBeTruthy();
      // With nothing stored, the preference follows the system, and the row says so.
      expect(getByText(/Follows your operating system/i)).toBeTruthy();
    },
  );

  appearanceCase(
    "an explicit stored choice is what the row explains",
    async () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, "light");

      const { getByText } = renderSettings();

      await waitFor(() => {
        expect(getByText(/Always light/i)).toBeTruthy();
      });
    },
  );
}
