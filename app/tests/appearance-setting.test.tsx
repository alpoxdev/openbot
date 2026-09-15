import "./appearance-setting.fixture";

import { afterEach, expect, test } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { Route as SettingsRoute } from "@/routes/_authed/settings/index";

/* Keep every case on the same concrete route component. */
const SettingsScreen = SettingsRoute.options.component as ComponentType;

if (!SettingsScreen) throw new Error("the settings route has no component");

/*
 * The fixture registers and unregisters Happy DOM around the file so Base UI sees its environment
 * while importing. `cleanup` and storage reset still run after each case.
 */
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

test("the row shows the current choice as a word, not the stored value", () => {
  const { getByRole } = renderSettings();

  // The label map is what turns a stored `system` into the word a person reads. Without it the
  // closed trigger would say "system".
  const trigger = getByRole("combobox");
  expect(trigger.textContent).toContain("System");
  expect(trigger.textContent).not.toContain("openbot-theme");
});

test("the control is a labelled combobox a keyboard can reach", () => {
  const { getByRole } = renderSettings();

  const trigger = getByRole("combobox");

  expect(trigger.getAttribute("aria-label") ?? "").toContain("Appearance");
  // Not disabled and focusable: the row is operable without a pointer.
  expect(trigger.hasAttribute("disabled")).toBe(false);
  expect(trigger.getAttribute("tabindex")).not.toBe("-1");
});

test("keyboard opens exactly the three appearance options with System selected", async () => {
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
});

test("keyboard selection persists Dark and updates the applied appearance", async () => {
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
    expect(ownerDocument.documentElement.classList.contains("dark")).toBe(true);
    expect(view.getByText(/Always dark/i)).toBeTruthy();
  });
});

test("the old two-state switch is gone from the row", () => {
  const { queryByRole, queryByText } = renderSettings();

  // A leftover `Switch` would mean the row still had two states, which cannot express `system`.
  expect(queryByRole("switch")).toBeNull();
  expect(queryByText("Dark theme")).toBeNull();
});

test("the trigger is labelled and the row explains what the current choice means", () => {
  const { getByLabelText, getByText } = renderSettings();

  expect(getByLabelText("Appearance")).toBeTruthy();
  // With nothing stored, the preference follows the system, and the row says so.
  expect(getByText(/Follows your operating system/i)).toBeTruthy();
});

test("an explicit stored choice is what the row explains", async () => {
  window.localStorage.setItem(THEME_STORAGE_KEY, "light");

  const { getByText } = renderSettings();

  await waitFor(() => {
    expect(getByText(/Always light/i)).toBeTruthy();
  });
});
