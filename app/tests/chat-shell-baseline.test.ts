import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStoredThemePreference } from "@/lib/theme";

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
  /*
   * The baseline moved when the preference became three-state: the stored value is now the choice
   * (`system` / `light` / `dark`) rather than a resolution, so anything unrecognised — including a
   * value from an older build — means "follow the system" instead of "light".
   */
  test("only the three known values are preferences", () => {
    expect(parseStoredThemePreference("dark")).toBe("dark");
    expect(parseStoredThemePreference("light")).toBe("light");
    expect(parseStoredThemePreference("system")).toBe("system");
    expect(parseStoredThemePreference(null)).toBe("system");
    expect(parseStoredThemePreference("")).toBe("system");
    expect(parseStoredThemePreference("Dark")).toBe("system");
  });
});
