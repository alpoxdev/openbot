import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  applyThemePreference,
  LEGACY_THEME_STORAGE_KEY,
  migrateLegacyThemePreference,
  parseStoredThemePreference,
  readStoredThemePreference,
  resolveDarkTheme,
  resolveStoredThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "../src/lib/theme";

describe("theme preference parsing", () => {
  test("only the three known values are preferences", () => {
    expect(parseStoredThemePreference("system")).toBe("system");
    expect(parseStoredThemePreference("light")).toBe("light");
    expect(parseStoredThemePreference("dark")).toBe("dark");
  });

  test("anything unrecognised follows the system", () => {
    expect(parseStoredThemePreference(null)).toBe("system");
    expect(parseStoredThemePreference("")).toBe("system");
    expect(parseStoredThemePreference("Dark")).toBe("system");
    expect(parseStoredThemePreference("banana")).toBe("system");
  });
});

describe("legacy theme migration", () => {
  test("legacy dark is a real choice and survives", () => {
    expect(migrateLegacyThemePreference("dark")).toBe("dark");
  });

  test("legacy light is ambiguous and becomes system", () => {
    // The old provider wrote "light" for everyone who had not chosen dark, so it cannot be read
    // as a choice. See the header of `src/lib/theme.ts`.
    expect(migrateLegacyThemePreference("light")).toBe("system");
    expect(migrateLegacyThemePreference(null)).toBe("system");
    expect(migrateLegacyThemePreference("Dark")).toBe("system");
  });
});

describe("resolving the two keys", () => {
  /*
   * The shared resolution table:
   *
   *   v2 present:  "dark" -> dark | "light" -> light | "system" -> prefersDark | other -> prefersDark
   *   v2 absent:   legacy "dark" -> dark | legacy anything else -> prefersDark
   *
   * Both reduce to `resolveDarkTheme(resolveStoredThemePreference(v2, legacy), prefersDark)`.
   * The boot script implements this table in plain JS; its extracted code is checked below.
   */
  test("a stored v2 value is authoritative", () => {
    expect(resolveStoredThemePreference("system", "dark")).toBe("system");
    expect(resolveStoredThemePreference("light", "dark")).toBe("light");
    expect(resolveStoredThemePreference("dark", null)).toBe("dark");
  });

  test("v2 present but unreadable is still authoritative", () => {
    // Garbage under the new key must not fall through to the old one, or a migrated install could
    // be dragged back by whatever the previous build left behind.
    expect(resolveStoredThemePreference("banana", "dark")).toBe("system");
  });

  test("the legacy key is consulted only when v2 is absent", () => {
    expect(resolveStoredThemePreference(null, "dark")).toBe("dark");
    expect(resolveStoredThemePreference(null, "light")).toBe("system");
    expect(resolveStoredThemePreference(null, null)).toBe("system");
  });
});

describe("resolving dark", () => {
  test("an explicit choice ignores the system", () => {
    expect(resolveDarkTheme("dark", false)).toBe(true);
    expect(resolveDarkTheme("light", true)).toBe(false);
  });

  test("system defers to the system", () => {
    expect(resolveDarkTheme("system", true)).toBe(true);
    expect(resolveDarkTheme("system", false)).toBe(false);
  });
});

describe("reading the stored preference", () => {
  test("reads by preference, not by resolution", () => {
    const store: Record<string, string> = { [THEME_STORAGE_KEY]: "system" };
    expect(readStoredThemePreference((key) => store[key] ?? null)).toBe(
      "system",
    );
  });

  test("a store that throws for everything follows the system", () => {
    expect(
      readStoredThemePreference(() => {
        throw new Error("blocked");
      }),
    ).toBe("system");
  });

  test("a store that throws only for the new key does not resurrect the old one", () => {
    // A failed v2 read is not the same as a successful read returning null, so migration is blocked.
    const preference = readStoredThemePreference((key) => {
      if (key === THEME_STORAGE_KEY) throw new Error("blocked");
      return "dark";
    });

    expect(preference).toBe("system");
  });

  test("a store that throws only for the legacy key keeps the v2 answer", () => {
    const preference = readStoredThemePreference((key) => {
      if (key === LEGACY_THEME_STORAGE_KEY) throw new Error("blocked");
      return null;
    });

    expect(preference).toBe("system");
  });
});

describe("applying a preference", () => {
  function recorder(
    options: { failWrite?: boolean; failRemoval?: boolean } = {},
  ) {
    const writes: Array<[string, string]> = [];
    const removals: string[] = [];
    const toggles: Array<[string, boolean]> = [];
    const schemes: Array<string> = [];

    return {
      writes,
      removals,
      toggles,
      schemes,
      effects: {
        setStoredValue: (key: string, value: string) => {
          if (options.failWrite) throw new Error("blocked");
          writes.push([key, value]);
        },
        removeStoredValue: (key: string) => {
          removals.push(key);
          if (options.failRemoval) throw new Error("blocked");
        },
        toggleRootClass: (name: string, force: boolean) =>
          toggles.push([name, force]),
        setRootColorScheme: (scheme: "dark" | "light") => schemes.push(scheme),
      },
    };
  }

  test("stores the preference and applies the resolution", () => {
    const { writes, removals, toggles, schemes, effects } = recorder();

    applyThemePreference("dark", false, effects);

    expect(writes).toEqual([[THEME_STORAGE_KEY, "dark"]]);
    expect(toggles).toEqual([["dark", true]]);
    expect(schemes).toEqual(["dark"]);
    expect(removals).toEqual([LEGACY_THEME_STORAGE_KEY]);
  });

  test("system stores system rather than what it resolved to", () => {
    // The bug this guards: writing "light" here would make the remembered choice a resolution, and
    // the next OS switch would be ignored forever.
    const { writes, toggles, schemes, effects } = recorder();

    applyThemePreference("system", true, effects);

    expect(writes).toEqual([[THEME_STORAGE_KEY, "system"]]);
    expect(toggles).toEqual([["dark", true]]);
    expect(schemes).toEqual(["dark"]);
  });

  test("light on a dark system stays light", () => {
    const { writes, toggles, schemes, effects } = recorder();

    applyThemePreference("light", true, effects);

    expect(writes).toEqual([[THEME_STORAGE_KEY, "light"]]);
    expect(toggles).toEqual([["dark", false]]);
    expect(schemes).toEqual(["light"]);
  });

  test("the legacy key is only ever removed, never written", () => {
    const { writes, effects } = recorder();

    for (const preference of [
      "system",
      "light",
      "dark",
    ] satisfies ThemePreference[]) {
      applyThemePreference(preference, true, effects);
    }

    expect(writes.map(([key]) => key)).not.toContain(LEGACY_THEME_STORAGE_KEY);
  });

  test("a failed v2 write does not block visual effects or remove legacy data", () => {
    const { writes, removals, toggles, schemes, effects } = recorder({
      failWrite: true,
    });

    applyThemePreference("dark", false, effects);

    expect(writes).toEqual([]);
    expect(removals).toEqual([]);
    expect(toggles).toEqual([["dark", true]]);
    expect(schemes).toEqual(["dark"]);
  });

  test("a failed legacy removal does not block visual effects", () => {
    const { writes, removals, toggles, schemes, effects } = recorder({
      failRemoval: true,
    });

    applyThemePreference("light", true, effects);

    expect(writes).toEqual([[THEME_STORAGE_KEY, "light"]]);
    expect(removals).toEqual([LEGACY_THEME_STORAGE_KEY]);
    expect(toggles).toEqual([["dark", false]]);
    expect(schemes).toEqual(["light"]);
  });
});

describe("pre-paint theme boot", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  const escapeRegExp = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = (html.match(
    /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/,
  ) ?? ["", ""])[1]
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  test("the boot script runs before the first paint", () => {
    const boot = html.match(/<script(?![^>]*\bsrc=)[^>]*>/);

    expect(boot).not.toBeNull();
    expect(boot?.[0]).not.toContain("module");
    expect(boot?.[0]).not.toContain("defer");
  });

  test("the boot script extracts to something with code in it", () => {
    // Guards the extraction itself: a regex that matched the wrong tag would leave these
    // assertions passing over an empty string.
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("preference");
  });

  test("the boot script reads both keys, in call shape", () => {
    expect(body).toMatch(
      new RegExp(
        `v2\\s*=\\s*window\\.localStorage\\.getItem\\(\\s*${escapeRegExp(
          JSON.stringify(THEME_STORAGE_KEY),
        )}\\s*\\)`,
      ),
    );
    expect(body).toMatch(
      new RegExp(
        `legacy\\s*=\\s*window\\.localStorage\\.getItem\\(\\s*${escapeRegExp(
          JSON.stringify(LEGACY_THEME_STORAGE_KEY),
        )}\\s*\\)`,
      ),
    );
  });

  test("the boot script tracks a successful v2 read before migration", () => {
    expect(body).toMatch(/v2ReadSucceeded\s*=\s*true/);
    expect(body).toMatch(
      /if\s*\(\s*v2ReadSucceeded\s*&&\s*v2\s*===\s*null\s*\)\s*\{\s*try\s*\{/,
    );
    expect(body).toMatch(
      /else\s+if\s*\(\s*v2ReadSucceeded\s*&&\s*v2\s*===\s*null\s*&&\s*legacy\s*===\s*"dark"\s*\)/,
    );
  });

  test("the boot script applies the dark class itself", () => {
    expect(body).toMatch(/classList\.toggle\(\s*"dark"/);
  });

  test("the boot script declares a color scheme before the stylesheet arrives", () => {
    expect(body).toMatch(/colorScheme\s*=/);
  });

  test("the boot script resolves the system appearance too", () => {
    // Without this the first frame is light for a dark-OS user, and the provider corrects it one
    // paint later — the flash the script exists to prevent.
    expect(body).toContain("prefers-color-scheme");
  });

  test("the boot script guards each read on its own", () => {
    // Storage and media-query failures must not abort first paint.
    const guards = body.match(/try\s*\{/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });
});

describe("color scheme", () => {
  const styles = readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );

  test("both themes tell the browser which one they are", () => {
    expect(styles).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*light/);
    expect(styles).toMatch(/\.dark\s*\{[\s\S]*?color-scheme:\s*dark/);
  });
});
