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
    expect(source).toContain("AgentRail");
    expect(source).toContain("MembersRail");
  });

  test("the composer ships a Grok pill radius instead of rounded-2xl", () => {
    const source = readWorktreeFile(
      "src/components/channels/composer/composer.tsx",
    );

    expect(source).toContain("rounded-full");
    expect(source).toContain("rounded-[24px]");
    expect(source).not.toContain("rounded-2xl");
    expect(source).toContain("min-h-12");
  });

  test("app/src pins agent-rail and members-rail test ids", () => {
    const files = walkFiles(srcRoot);
    const agentRail = files.filter((path) =>
      readFileSync(path, "utf8").includes('data-testid="agent-rail"'),
    );
    const membersRail = files.filter((path) =>
      readFileSync(path, "utf8").includes('data-testid="members-rail"'),
    );

    expect(agentRail.length).toBeGreaterThan(0);
    expect(membersRail.length).toBeGreaterThan(0);
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
