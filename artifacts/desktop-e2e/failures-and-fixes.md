
# Desktop E2E — failures found, diagnosed, fixed (2026-09-15)

## 1. Stack would not start: port 5432 in use  [ENV FIX, applied]
- Symptom: "Something else on this computer is using a port OpenBot needs. Close it, or restart the computer, and try again."
  Detail: `listen tcp4 127.0.0.1:5432: bind: address already in use`.
- Cause: Homebrew `postgresql@17` (pid 2995) held 127.0.0.1:5432 and [::1]:5432.
  `docker-compose.yml:34-35` publishes `127.0.0.1:${POSTGRES_PORT:-5432}:5432` and `.env` set POSTGRES_PORT=5432.
- Fix applied: `brew services stop postgresql@17` (nothing was connected to it). Reversible: `brew services start postgresql@17`.
- PRODUCT BUG (still open): `desktop/src-tauri/src/env.rs:58` hardcodes `postgres: 5432` in `Ports::default()` and
  `env.rs:397` overwrites POSTGRES_PORT on every Start, so editing .env cannot work around it. No free-port probe exists.
  Also `desktop/src-tauri/src/problem.rs:88` advises "restart the computer", which cannot help: postgresql@17 is a
  launchd agent that starts again at login.

## 2. "could not verify its app on port 3010 belongs to this installation"  [ENV FIX, applied]
- Cause: `main.rs:2148 owned_app_url` -> `main.rs:2128 already_running_on` requires `deployment::installed(root)`,
  which is `deployment.rs:159` reading `<root>/.openbot-deployment` (STAMP, deployment.rs:19). That file did not exist.
  Every other gate verified true: /api/capabilities returned 200, the recorded "server" pid 21484 owned :3001, and the
  :3010 listener (vite pid 21540) was a child of the recorded "app" pid 21502 with a matching start fingerprint
  (macos:1789509219:488165) — the walk at stack.rs:2153 is designed to accept that Vite child.
- Fix applied: wrote `<repo>/.openbot-deployment` = {"version":"0.0.11"}. NOTE: not in .gitignore.
- PRODUCT BUG (still open): a `tauri dev` run resolves root to the source tree (stack.rs:2654, the #[cfg(dev)] default_root),
  but the wizard's Start path starts host processes from source without ever writing the install stamp, so the final
  step always fails in dev.

## 3. Product UI rendered a blank window  [CODE FIX, applied]
- Symptom: after "Start using OpenBot" the window navigated (log: `[show] navigating the window to http://127.0.0.1:3010`,
  `navigate returned Ok(())`) but painted nothing. Reproduced in headless Chrome, so not a webview artifact:
  `<div id="root"></div>` stayed empty.
- Cause: `Uncaught ReferenceError: Cannot access 'GALLERY_COMPONENTS' before initialization`
  at `app/src/components/gallery/preview.tsx`. `gallery-registry.ts:79` eagerly globs
  `../../components/gallery/*.tsx`, which includes `preview.tsx` itself; `preview.tsx` imported the registry and read
  `GALLERY_COMPONENTS` in a module-scope `new Map(...)`. The eager import therefore evaluated preview.tsx while the
  registry's const was still in its temporal dead zone. The throw aborted the import graph, so main.tsx never reached
  `createRoot(...).render(...)` and the app was blank.
- Fix applied: `preview.tsx` now builds that map lazily on first render (memoized), so the cycle is harmless.
  Verified: lsp diagnostics 0; headless Chrome now renders `<h1>Welcome to OpenBot</h1>`; the Tauri window shows the
  product with the composer and Continue button.

## 4. Sending a message to a coworker shows "HTTP 404: Not found"  [DIAGNOSED, NOT FIXED]
- Symptom: after the product opened, sending "What is 17 times 23?..." to the LangGraph coworker produced a
  transcript entry `HTTP 404: Not found` plus `Earlier messages are temporarily unavailable. You can keep using
  this conversation.` No assistant reply appeared.
- Evidence gathered:
  - `GET http://127.0.0.1:3001/api/capabilities` -> 200 (server healthy).
  - The harness at 127.0.0.1:4206 DID receive the run: `docker logs openbot-agent-harness-1` shows three
    `POST / HTTP/1.1 200 OK`. Its AG-UI route is `path="/"` (`agent-langgraph-agui/src/main.py`), guarded by a
    `MANAGED_AGENT_TOKEN` middleware that 401s anything else — my unauthenticated probes returned 401, not 404,
    so the harness is not the source of the 404.
  - The string `Not found` is OpenBot's own: `server/src/copilot.ts` returns `new Response("Not found", { status: 404 })`.
    The 404 paths there are: no matching route op; `body.threadId` != route threadId; `body.agentId` != route agentId;
    `store.authorize(...)` throwing ConversationAccessError/ConversationNotFoundError; `access === "none"`; and
    `operation === "run" && access !== "run"`.
  - The browser saw no 4xx on the wire, so the text is rendered from an event/error the client surfaces, not a fetch.
  - Postgres state: 3 channels exist, each named "LangGraph" (one was created per send rather than reusing one), and
    `select count(*) from conversation_events` returns **0** — nothing was persisted.
  - Agents present: general-assistant, knowledge, picked-harness (displayed as "LangGraph").
- Leading hypothesis (unconfirmed): the conversation store's authorization for the channel's thread/agent denies
  access, so both the run and the history read 404 and nothing is persisted. Needs the server's own error detail
  (its log has no request logging) or a DB trace of the thread row to confirm.
- Blocked from finishing: the `aside` MCP session expired mid-capture (`SessionExpiredError`, asked to run
  `/mcp reconnect aside`), so the exact failing request could not be captured.
