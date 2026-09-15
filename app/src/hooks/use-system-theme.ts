const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The media query behind "follow the system", or `null` when the platform cannot answer.
 *
 * Every failure below resolves to "cannot answer" rather than to an exception, because this runs
 * during render and this app has no error boundary: a throw here would blank the window rather than
 * merely paint the wrong colour. The cases are enumerated because each has been seen in the wild —
 * an absent API, an API that throws, a query object that is not an object, a `matches` getter that
 * throws (the historic WebKit media-query hazard), and a `matches` that is not a boolean.
 */
function darkQuery(): MediaQueryList | null {
  try {
    if (typeof window.matchMedia !== "function") return null;

    const query = window.matchMedia(DARK_QUERY);

    if (!query || typeof query !== "object") return null;
    if (typeof query.matches !== "boolean") return null;

    return query;
  } catch {
    return null;
  }
}

/**
 * Whether the system is currently dark, read during render rather than corrected in an effect.
 *
 * Reading it in an effect would paint one wrong frame: the pre-paint script in `index.html` has
 * already resolved the system appearance by the time React runs, so a first render that assumed
 * light would disagree with what is on screen. `use-mobile.ts` initialises to `undefined` and
 * corrects itself afterwards, which is the right shape for a breakpoint and the wrong one here.
 */
export function systemPrefersDark(): boolean {
  return darkQuery()?.matches === true;
}

/**
 * Calls `onChange` when the system appearance changes, and returns the way to stop.
 *
 * The cleanup is not optional: `main.tsx` renders under `StrictMode`, so effects mount, unmount and
 * remount in development, and a listener left behind would accumulate once per mount.
 */
export function subscribeToSystemTheme(
  onChange: (dark: boolean) => void,
): () => void {
  const query = darkQuery();

  if (!query) return () => {};

  const listener = (event: MediaQueryListEvent) => onChange(event.matches);

  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }

  // Safari before 14 shipped only the deprecated pair; it is still in use.
  if (typeof query.addListener === "function") {
    query.addListener(listener);
    return () => query.removeListener(listener);
  }

  return () => {};
}
