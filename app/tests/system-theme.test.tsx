import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { LEGACY_THEME_STORAGE_KEY, THEME_STORAGE_KEY } from "@/lib/theme";

/*
 * These tests install matchMedia after happy-dom registration so the provider sees the fake. They
 * exercise the provider itself, including its StrictMode listener lifecycle.
 */
let realMatchMedia: typeof window.matchMedia | undefined;
let realGetItem: PropertyDescriptor | undefined;

type Fake = {
  matches: boolean;
  fire: (matches: boolean) => void;
  listeners: number;
};

function installMatchMedia(initial: boolean): Fake {
  const listeners: Array<(event: { matches: boolean }) => void> = [];

  const fake: Fake = {
    matches: initial,
    listeners: 0,
    fire(matches: boolean) {
      fake.matches = matches;
      for (const listener of listeners) listener({ matches });
    },
  };

  Reflect.set(globalThis, "matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return fake.matches;
    },
    addEventListener: (
      _type: string,
      listener: (event: { matches: boolean }) => void,
    ) => {
      listeners.push(listener);
      fake.listeners += 1;
    },
    removeEventListener: (
      _type: string,
      listener: (event: { matches: boolean }) => void,
    ) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
        fake.listeners -= 1;
      }
    },
  }));

  return fake;
}

async function renderProvider(children: ReactNode = null) {
  const { ThemeProvider } = await import("@/components/theme-provider");
  return render(
    <StrictMode>
      <ThemeProvider>{children}</ThemeProvider>
    </StrictMode>,
  );
}

function rootIsDark() {
  return document.documentElement.classList.contains("dark");
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  realMatchMedia = globalThis.matchMedia;
  realGetItem = Object.getOwnPropertyDescriptor(window.localStorage, "getItem");
});

afterEach(() => {
  cleanup();

  if (realMatchMedia === undefined) {
    Reflect.deleteProperty(globalThis, "matchMedia");
  } else {
    globalThis.matchMedia = realMatchMedia;
  }

  if (realGetItem) {
    Object.defineProperty(window.localStorage, "getItem", realGetItem);
  } else {
    Reflect.deleteProperty(window.localStorage, "getItem");
  }
  window.localStorage.clear();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("following the system from a cold start", () => {
  test("a dark system with no stored preference renders dark", async () => {
    installMatchMedia(true);

    await act(async () => {
      await renderProvider();
    });

    expect(rootIsDark()).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  test("a light system with no stored preference renders light", async () => {
    installMatchMedia(false);

    await act(async () => {
      await renderProvider();
    });

    expect(rootIsDark()).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });
});

describe("migrating the previous build's value", () => {
  test("a legacy dark is kept, and the legacy key is retired", async () => {
    installMatchMedia(false);
    window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, "dark");

    await act(async () => {
      await renderProvider();
    });

    // Dark despite a light system: the old switch wrote "dark", so somebody asked for it.
    expect(rootIsDark()).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull();
  });

  test("a legacy light follows the system, and the legacy key is retired", async () => {
    installMatchMedia(true);
    window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, "light");

    await act(async () => {
      await renderProvider();
    });

    // Dark, because the old "light" could have been written for somebody who never chose it.
    expect(rootIsDark()).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    expect(window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull();
  });
});

describe("following a live OS switch", () => {
  test("the palette moves with the system, and no resolution is stored", async () => {
    const fake = installMatchMedia(false);

    await act(async () => {
      await renderProvider();
    });

    expect(rootIsDark()).toBe(false);

    await act(async () => {
      fake.fire(true);
    });

    expect(rootIsDark()).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    // The stored value stays the choice, not the outcome.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");

    await act(async () => {
      fake.fire(false);
    });

    expect(rootIsDark()).toBe(false);
  });

  test("an explicit choice does not follow the system", async () => {
    const fake = installMatchMedia(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");

    await act(async () => {
      await renderProvider();
    });

    expect(rootIsDark()).toBe(false);

    await act(async () => {
      fake.fire(false);
      fake.fire(true);
    });

    expect(rootIsDark()).toBe(false);
  });

  test("StrictMode leaves one listener mounted and cleanup removes it", async () => {
    const fake = installMatchMedia(false);
    let rendered: ReturnType<typeof render> | undefined;

    await act(async () => {
      rendered = await renderProvider();
    });

    expect(fake.listeners).toBe(1);
    rendered?.unmount();
    expect(fake.listeners).toBe(0);
  });
});

describe("degraded platforms", () => {
  test("an absent matchMedia renders light without throwing", async () => {
    Reflect.deleteProperty(globalThis, "matchMedia");

    await act(async () => {
      await renderProvider();
    });

    expect(rootIsDark()).toBe(false);
  });

  test("a query object with no listener API renders without throwing", async () => {
    Reflect.set(globalThis, "matchMedia", () => ({ matches: false }));

    await act(async () => {
      await renderProvider();
    });

    expect(rootIsDark()).toBe(false);
  });

  test("a matchMedia call that throws renders without throwing", async () => {
    Reflect.set(globalThis, "matchMedia", () => {
      throw new Error("blocked");
    });

    await act(async () => {
      await renderProvider();
    });

    expect(rootIsDark()).toBe(false);
  });

  test("a throwing matches getter renders without throwing", async () => {
    Reflect.set(globalThis, "matchMedia", () => ({
      get matches() {
        throw new Error("blocked");
      },
    }));

    await act(async () => {
      await renderProvider();
    });

    expect(rootIsDark()).toBe(false);
  });

  test("a store whose read throws still renders", async () => {
    installMatchMedia(false);

    // The provider reads the preference during render, and this app has no error boundary, so an
    // unguarded throw here would blank the window rather than paint the wrong colour.
    Object.defineProperty(window.localStorage, "getItem", {
      configurable: true,
      value: () => {
        throw new Error("blocked");
      },
    });

    await act(async () => {
      await renderProvider();
    });

    expect(rootIsDark()).toBe(false);
    expect(document.getElementById("root") ?? document.body).toBeTruthy();
  });
});
