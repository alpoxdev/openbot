import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStoredDarkTheme } from "../src/lib/theme";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const srcRoot = join(appRoot, "src");

function readWorktreeFile(relativeFromApp: string) {
  return readFileSync(join(appRoot, relativeFromApp), "utf8");
}

function walkFiles(dir: string, files: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walkFiles(path, files);
      continue;
    }
    files.push(path);
  }
  return files;
}

describe("chat shell baseline", () => {
  test("the authed app shell still uses SidebarShell at 340px with AppSidebar", () => {
    const source = readWorktreeFile("src/routes/_authed/_app.tsx");

    expect(source).toContain("SidebarShell");
    expect(source).toContain('width="340px"');
    expect(source).toContain("AppSidebar");
  });

  test("the composer still ships the rounded-2xl min-h-14 shell", () => {
    const source = readWorktreeFile(
      "src/components/channels/composer/composer.tsx",
    );

    expect(source).toContain("rounded-2xl");
    expect(source).toContain("min-h-14");
  });

  test("app/src does not pin agent-rail or members-rail test ids", () => {
    const files = walkFiles(srcRoot);
    const hits = files.filter((path) => {
      const source = readFileSync(path, "utf8");
      return (
        source.includes('data-testid="agent-rail"') ||
        source.includes('data-testid="members-rail"')
      );
    });

    expect(hits).toEqual([]);
  });
});

describe("theme baseline", () => {
  test("only the stored dark value enables dark theme", () => {
    expect(parseStoredDarkTheme("dark")).toBe(true);
    expect(parseStoredDarkTheme("light")).toBe(false);
    expect(parseStoredDarkTheme(null)).toBe(false);
    expect(parseStoredDarkTheme("")).toBe(false);
    expect(parseStoredDarkTheme("Dark")).toBe(false);
  });
});
