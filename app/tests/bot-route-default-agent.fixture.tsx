import { spyOn } from "bun:test";
import * as CopilotKit from "@copilotkit/react-core/v2";
import * as ActiveBot from "@/lib/copilot/active-bot";
import * as BotThread from "@/lib/copilot/bot-thread";
import * as StoppedTurn from "@/lib/copilot/stopped-turn";
import * as ImportedHistoryModule from "@/components/channels/imported-history";

/**
 * The route needs a few child boundaries, but this file must not install process-wide module mocks
 * while Bun is still evaluating the rest of the test graph. Namespace spies are installed explicitly
 * before the route's dynamic import and restored afterwards, leaving every other export on each real
 * module (including botThreadKey and botThreadArchiveKey) untouched.
 */
export type BotRouteMockOptions = {
  useBotThread: (agentId: string) => unknown;
  useActiveBot: (agentId: string | undefined) => void;
};

let restores: Array<() => void> = [];

export function installBotRouteMocks(options: BotRouteMockOptions): void {
  if (restores.length > 0) return;

  const chatBoundary = Object.assign(
    ({ agentId }: Parameters<typeof CopilotKit.CopilotChat>[0]) => (
      <div data-agent-id={agentId} data-testid="copilot-chat" />
    ),
    { View: CopilotKit.CopilotChat.View },
  );
  const copilotChat = spyOn(CopilotKit, "CopilotChat");
  copilotChat.mockImplementation(chatBoundary);

  const activeBot = spyOn(ActiveBot, "useActiveBot");
  activeBot.mockImplementation(options.useActiveBot);

  const botThread = spyOn(BotThread, "useBotThread");
  botThread.mockImplementation(
    options.useBotThread as typeof BotThread.useBotThread,
  );

  const stoppedTurn = spyOn(StoppedTurn, "useStoppedTurn");
  stoppedTurn.mockImplementation(() => null);

  const importedHistory = spyOn(ImportedHistoryModule, "ImportedHistory");
  importedHistory.mockImplementation(
    ({ agentId, threadId }: { agentId?: string; threadId?: string }) => (
      <div
        data-agent-id={agentId}
        data-testid="imported-history"
        data-thread-id={threadId}
      />
    ),
  );

  restores = [
    () => copilotChat.mockRestore(),
    () => activeBot.mockRestore(),
    () => botThread.mockRestore(),
    () => stoppedTurn.mockRestore(),
    () => importedHistory.mockRestore(),
  ];
}

export function restoreBotRouteMocks(): void {
  const pending = restores;
  restores = [];
  for (const restore of pending.reverse()) restore();
}
