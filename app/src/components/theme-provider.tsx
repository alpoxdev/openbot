import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  applyThemePreference,
  readStoredThemePreference,
  resolveDarkTheme,
  type ThemePreference,
} from "@/lib/theme";
import {
  subscribeToSystemTheme,
  systemPrefersDark,
} from "@/hooks/use-system-theme";

type ThemeContextValue = {
  /** What was chosen: `system`, `light` or `dark`. */
  preference: ThemePreference;
  /** Whether the operating system is currently dark, live. */
  systemDark: boolean;
  /** What the preference resolves to right now. Derived — never store this. */
  resolvedDark: boolean;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  /*
   * The stored value is read once, during the first render, so the provider agrees with what
   * `index.html` already painted. Reading it in an effect would repaint one frame later.
   */
  const [preference, setPreference] = useState<ThemePreference>(() =>
    readStoredThemePreference((key) => window.localStorage.getItem(key)),
  );

  /*
   * Also read during render, for the same reason: the script resolved the system appearance before
   * paint, so correcting it afterwards would show one wrong frame. It looks like a premature
   * optimisation; it is not.
   */
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  const resolvedDark = resolveDarkTheme(preference, systemDark);

  useEffect(() => {
    applyThemePreference(preference, systemDark, {
      setStoredValue: (key, value) => window.localStorage.setItem(key, value),
      removeStoredValue: (key) => window.localStorage.removeItem(key),
      toggleRootClass: (name, force) =>
        document.documentElement.classList.toggle(name, force),
      setRootColorScheme: (scheme) => {
        document.documentElement.style.colorScheme = scheme;
      },
    });
  }, [preference, systemDark]);

  useEffect(() => subscribeToSystemTheme((dark) => setSystemDark(dark)), []);

  return (
    <ThemeContext.Provider
      value={{ preference, systemDark, resolvedDark, setPreference }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const value = useContext(ThemeContext);

  if (!value) {
    throw new Error("useTheme must be used within ThemeProvider");
  }

  return value;
}
