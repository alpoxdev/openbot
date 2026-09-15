# G004 recon — how bots talk to each other (verified by reading source)

## Mechanism: typed handoff tool, NOT @mentions
- `server/src/agents/handoff-tool.ts` — the tool is named **`message_bot`**, ref `bot/message_bot`.
  Typed params: `bot` (name as in roster), `task` (required), `constraints?`, `expecting?`.
  Deliberately typed rather than free text so the receiving Bot cannot silently infer intent.
- There is **no `@mention` parsing** anywhere in `server/src` or `app/src/lib` (grep: only prose
  hits). A reply is scoped to one agent thread; multi-bot turns happen via handoff hops.
- `server/src/agents/handoff.ts` — `HANDOFF_KIND = "bot.message"`, `HANDOFF_GRANT = "bot"`.

## Caps (server/src/config.ts handoffCaps)
- `BOT_HANDOFF_MAX_DEPTH` default **1**
- `BOT_HANDOFF_MAX_PER_RUN` default **3**
- Both must be > 0 or the tool is not even offered (`server/src/index.ts:869-871`).
- Consequence at defaults: a user-initiated run is depth 0, so A may address B and C (depth 1),
  but **B may not address C** (depth 1 >= maxDepth 1 is refused). Chain A->B->C is refused;
  fan-out A->{B,C} is allowed. G004 must test the fan-out shape.

## Grant surface (UI)
- `app/src/components/agents/agent-dialog.tsx:112` — dialog has a section `{ id: "handoff", name: "Handoff" }`,
  rendering `<HandoffPanel agentId={agentId} />` at :228.
- `app/src/lib/agents/handoff-roster.ts` — decides which coworkers get a switch in that panel.
- `app/src/lib/agents/mutations.ts:132` — `setHandoffGrantMutationOptions`.
- `app/src/lib/agents/queries.ts:137` — `agentHandoffQueryOptions` -> GET `{agentApiPath}/handoff`.

## Observability
- Audit events: `agent.handoff_offered`, `agent.handoff_delivered`, `agent.handoff_refused`,
  `agent.handoff_failed`, `agent.handoff_retried` (`app/src/lib/audit/outcome.ts:41,63`).
- `/admin/audit` has a filter chip "Nobody watching" = `?initiatorKind=routine,handoff`
  (`app/src/routes/_authed/admin/audit.tsx:59`), and renders handoff initiators at :151.
- `app/src/components/channels/channel-chat.tsx:396` — a relayed handoff answer runs server-side and
  lands in the channel thread with no browser attached.

## Implication for G004 test steps
1. Create 3 coworkers at /agents.
2. Open A's dialog -> Handoff tab -> switch ON B and C.
3. Channel containing A (and B, C as members).
4. Ask A something that needs a role it lacks, naming B and C, so it calls message_bot twice.
5. Evidence: channel transcript showing B's and C's answers + /admin/audit handoff events.

## Automation gotcha (found live during G002 node 1)

- `orca computer get-app-state --app openbot-desktop` fails with `window_not_found` whenever the
  app is NOT frontmost, even though the window exists and is visible (verified: macOS System Events
  reports 1 window named "OpenBot", visible=true, while orca reports an empty window list).
  Recovery: activate first, then query:
  `osascript -e 'tell application "System Events" to set frontmost of process "openbot-desktop" to true'`
- `--restore-window` does NOT fix it and can hang.
- Consequence: every automation step must re-activate the app before reading state, because clicking
  through the sign-in flow brings Aside to the front and hides the app from orca.
