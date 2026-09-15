# Conversation import

Fresh OpenBot conversations do not need a CopilotKit account, project key, or licence token. Full user and assistant messages, tool calls and results, and their order are stored in this deployment's PostgreSQL. After a browser, app, or API server restart, that store is what is read back. OpenBot sessions, roles, model credentials, grants, policy and audit stay in force; account-free is not authorization-free.

This page describes an **optional, explicit** one-time import of conversations that already exist on an old CopilotKit source. It is not a runtime cloud fallback, not a startup login, and not a background sync.

Old hosted history is not already in PostgreSQL merely because this feature is available. Only an explicitly requested, successful import copies the selected records.

## What is imported, and what is not

Import copies transcripts into the same server store used for new conversations. After a successful publish, those imported messages are also read from PostgreSQL, not from the source. The source is not mutated: no deletes, archives, updates, or key provisioning on the old project.

A PostgreSQL backup of this deployment covers local messages, events, and import records that live in that database. Encrypted staging blobs and other vault secrets additionally require a backup of `KEY_ENCRYPTION_KEY`. A database dump does not reconstruct old hosted history that was never imported.

## How to start it

Import is offered from Settings (administrator). It is never entered on a fresh start.

1. Enter the old source origin and a non-secret project label, and declare the identities to discover. Do not put credentials in the label; URLs containing login details, queries, or fragments are rejected.
2. Enter the old project API key to run read-only discovery. The form clears the key when submitting it; it is held only for that server operation, not in `.env`, Helm, localStorage, query strings, or logs.
3. Review ownership and mappings, then confirm import.
4. Re-enter the key to import the confirmed records. Staging, validation, and publication are separate. Confirming inventory does not publish.

If the job is interrupted, resume requires reauthorization. Existing vault credentials are not reused as the import key.

PostgreSQL records a time-limited claim for each active attempt, so two server replicas cannot own the same job simultaneously. After an owning server stops, the expired attempt can be resumed with a newly supplied key. An expired or cancelled attempt cannot keep writing. Cancellation does not undo conversations already published, and a retry does not overwrite conversations continued locally.

## Inventory scope

Coverage is relative to a declared inventory, not to "everything that ever existed in that account."

Declared scope unions:

- Local channel/thread mappings this deployment already knows, including hidden or soft-deleted channels.
- Local users and historical agent rows, including soft-deleted profiles, in bounded batches. A pair that returns zero threads is still recorded.
- IDs explicitly supplied (optional browser `openbot.bot-thread.<agentId>` hints and any authorized prior configuration). Browser IDs are not ownership proof.
- Paged source list results for those pairs, plus individually probed mapped or explicit IDs. Absence from a list page does not drop a mapped ID.

Archived source threads are in scope when the source API can return them for a declared pair. Mapped identities that no longer appear on today's roster stay in the inventory.

The manifest records schema/converter version, source namespace and origin, the confirmed project reference, selected actor/agent pairs, explicit IDs and evidence, pagination cursors, per-thread metadata/hashes/counts, destination mapping, statuses and diagnostics. It must not include the project key, join tokens, full messages, or raw provider error bodies in a user-downloadable summary.

## States, errors, and gaps

Statuses include not inventoried, unavailable source, staged, partial, validated, locally published, blocked, failed, and excluded, with evidence. Resource dimensions (messages, events, state, attachments, ownership, source stability) are reported separately.

- `inventoryCompleteForDeclaredScope` means every declared pair's cursor was exhausted and every explicit/mapped ID has a documented outcome. It says nothing about unknown user/agent pairs.
- `transcriptValidated` means the captured envelope, IDs, order, tool links and stored reread match. An empty transcript must be a verified empty source response, not a swallowed error.
- A technically finished job with failures is **completed-with-gaps**, not "all conversations imported."
- Optional events gaps do not hide validated messages, but they stay visible. Unrecoverable state may block safe continuation of a thread.

Do not treat checksums as proof the source never omitted data. Do not claim all old conversations were recovered without an inventory that covers the claimed scope.

## After import

Imported threads remain readable from this server with the source disconnected. Continuing a conversation is enabled only when its state and current Bot are safe to run; otherwise it stays read-only. New turns use current OpenBot access, model credentials and grants, not historical source entitlements. There is no periodic cloud synchronization.

The **Stored conversations** list loads in pages. Choose **Show more** to see older entries. If another page cannot be loaded, previously loaded entries remain available. Paging the list does not shorten any conversation: selecting a thread still reads its full stored records.

## Operator diagnostics

The API server writes structured `conversation-observation` records to its process logs. They describe committed-write timing, replay progress, stop requests, lease failures, and import phases, counts, retries and resource gaps. These records do not contain transcripts, source keys or URLs, raw source errors, state, tool arguments, or old approvals.

Correlation identifiers are one-way SHA-256 fingerprints, not raw conversation or job identifiers. Keep the log sink restricted to deployment operators. Active-run counts describe one API process, not the entire cluster. A stop marked `requested` records the durable request; a locally observed terminal result is reported separately as `settled`.

Import reports retain safe gap categories and counts. Detailed source state, including state attached to an incomplete response, stays in encrypted staging rather than plaintext coverage or logs. Operational observations are best-effort and never replace the authoritative PostgreSQL records.
