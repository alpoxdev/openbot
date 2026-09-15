/**
 * Which appearance OpenBot wears, and how that is decided.
 *
 * The old key (`openbot-theme`) stored `"light"` both for an explicit light choice and for users
 * who had never opened Settings. That value is therefore ambiguous: this migration preserves only
 * legacy `"dark"` and maps everything else to `"system"`, accepting that a genuinely light choice
 * may need to be made again. The new key is authoritative whenever its read succeeds and finds a
 * value; applying a preference retires the old key after the new value is persisted.
 *
 * FOR THE NEXT MIGRATION: this build stamps `"system"` on first mount, so a stored `"system"` will
 * itself be ambiguous — it will mean both "deliberately chose System" and "never chose, and this
 * version defaulted". Anything that replaces this scheme must decide that case explicitly rather
 * than repeat the mistake above.
 */
export const THEME_STORAGE_KEY = "openbot-theme-v2";

/** The previous build's key. Read once, when the new key is absent, then retired. */
export const LEGACY_THEME_STORAGE_KEY = "openbot-theme";

export type ThemePreference = "system" | "light" | "dark";

/** The three values this build understands; everything else means "follow the system". */
export function parseStoredThemePreference(
  value: string | null,
): ThemePreference {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

/** Convert the previous build's ambiguous value into this build's preference. */
export function migrateLegacyThemePreference(
  value: string | null,
): ThemePreference {
  return value === "dark" ? "dark" : "system";
}

/**
 * Resolve both raw keys. A present v2 value is authoritative, including an unrecognised value.
 */
export function resolveStoredThemePreference(
  v2: string | null,
  legacy: string | null,
): ThemePreference {
  return v2 === null
    ? migrateLegacyThemePreference(legacy)
    : parseStoredThemePreference(v2);
}

/** The palette is dark when the preference says so, or when it defers to a dark system. */
export function resolveDarkTheme(
  preference: ThemePreference,
  systemDark: boolean,
): boolean {
  return preference === "dark" || (preference === "system" && systemDark);
}

/**
 * Read the preference through an injected reader. A failed v2 read is different from an absent v2
 * value, so migration is allowed only after a successful read confirms absence.
 */
export function readStoredThemePreference(
  read: (key: string) => string | null,
): ThemePreference {
  let v2: string | null;
  try {
    v2 = read(THEME_STORAGE_KEY);
  } catch {
    // Do not consult the legacy key when the new key could not be read.
    return "system";
  }

  let legacy: string | null = null;
  if (v2 === null) {
    try {
      legacy = read(LEGACY_THEME_STORAGE_KEY);
    } catch {
      legacy = null;
    }
  }

  return resolveStoredThemePreference(v2, legacy);
}

export type ThemeEffects = {
  setStoredValue: (key: string, value: string) => void;
  removeStoredValue: (key: string) => void;
  toggleRootClass: (name: string, force: boolean) => void;
  setRootColorScheme: (scheme: "dark" | "light") => void;
};

/**
 * Apply the preference, remembering the choice rather than its current resolution. Visual effects
 * are independent of storage availability; legacy data is retired only after v2 persistence.
 */
export function applyThemePreference(
  preference: ThemePreference,
  systemDark: boolean,
  effects: ThemeEffects,
) {
  const dark = resolveDarkTheme(preference, systemDark);

  let stored = false;
  try {
    effects.setStoredValue(THEME_STORAGE_KEY, preference);
    stored = true;
  } catch {
    // A blocked store must not prevent the palette from being applied.
  }

  if (stored) {
    try {
      effects.removeStoredValue(LEGACY_THEME_STORAGE_KEY);
    } catch {
      // Legacy cleanup is best effort after the new choice is safe.
    }
  }

  try {
    effects.toggleRootClass("dark", dark);
  } catch {
    // Keep the color-scheme effect independent from a hostile DOM implementation.
  }
  try {
    // `index.html` sets this inline before paint, and an inline style outranks the palette.
    effects.setRootColorScheme(dark ? "dark" : "light");
  } catch {
    // A blocked DOM effect must not turn a preference update into an app error.
  }
}
