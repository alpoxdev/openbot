import { createFileRoute } from "@tanstack/react-router";
import React from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StandingInstructions } from "@/components/settings/standing-instructions";
import { ConversationImport } from "@/components/settings/conversation-import";
import { ImportedHistory } from "@/components/channels/imported-history";
import { useTheme } from "@/components/theme-provider";
import type { ThemePreference } from "@/lib/theme";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatHotkey, HOTKEYS } from "@/lib/hotkeys/hotkeys";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { preference, setPreference } = useTheme();

  /*
   * The measurements that used to be written out here now live in `PageShell`, which Skills, Admin
   * and this screen all render through. The reason they match is no longer that somebody remembered
   * to copy them.
   *
   * Connected accounts used to be a section below. It is its own screen now: a connector can need
   * more from a person than one switch, and a section cannot grow a page's worth of that.
   */
  return (
    <PageShell
      description="How OpenBot looks and behaves for you. These apply to your account alone, on every deployment you sign in to."
      title="Preferences"
    >
      <PageSection title="General">
        <PageRows>
          {/*
           * Keep this fixed three-way choice inline: a dialog would add ceremony without giving the
           * appearance control any more room or context.
           */}
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Appearance</ItemTitle>
              <ItemDescription>
                {preference === "system"
                  ? "Follows your operating system's light or dark setting, and changes with it."
                  : preference === "dark"
                    ? "Always dark, whatever your operating system is set to."
                    : "Always light, whatever your operating system is set to."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Select<ThemePreference>
                // The label map, so the closed trigger reads a word rather than the raw value.
                items={{ system: "System", light: "Light", dark: "Dark" }}
                onValueChange={(next) => {
                  if (
                    next === "system" ||
                    next === "light" ||
                    next === "dark"
                  ) {
                    setPreference(next);
                  }
                }}
                value={preference}
              >
                <SelectTrigger aria-label="Appearance" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">System</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectContent>
              </Select>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
      {/*
       * Above the shortcuts and below the appearance control, because it is the only thing on this
       * screen that changes what a coworker says rather than what this browser looks like.
       */}
      <StandingInstructions />
      <ConversationImport />
      <ImportedHistory />
      {/*
       * Drawn from the same registry the listeners match against, so this list is what the keys
       * actually do rather than what somebody remembered they did. Read-only on purpose: these
       * are not rebindable, and a row with nothing to click says so by having nothing to click.
       */}
      <PageSection title="Keyboard shortcuts">
        <PageRows>
          {HOTKEYS.map((hotkey, index) => (
            <React.Fragment key={hotkey.id}>
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{hotkey.label}</ItemTitle>
                  <ItemDescription>{hotkey.description}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="flex gap-1">
                    {formatHotkey(hotkey.combo).map((part) => (
                      <kbd
                        className="rounded-md border bg-muted px-1.5 py-0.5 font-sans text-xs text-muted-foreground"
                        key={part}
                      >
                        {part}
                      </kbd>
                    ))}
                  </span>
                </ItemActions>
              </Item>
              {index !== HOTKEYS.length - 1 && <Separator />}
            </React.Fragment>
          ))}
        </PageRows>
      </PageSection>
    </PageShell>
  );
}
