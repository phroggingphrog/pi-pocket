# Conversation annotations and cache diagnostics

These features belong to TASK-390. They require the core browser APIs and cache telemetry in the `feature/cache-conversation-annotations` branch. They are not compatible with an unchanged Pocket 0.26.0 install in every respect.

## Annotation flow

Enable `conversation-annotations.ts` and its adjacent `conversation-annotations/` browser folder. The composer button opens a workspace text file. Select text, add a comment, preview the exact snapshot and add it to the composer. Multiple expandable draft notes survive reload in that browser for that person and conversation. They do not synchronize across devices.

The native message menu also offers Annotate for person messages and assistant replies. Selecting transcript text exposes a selection action. Ambiguous selections can be selected again in the annotation sheet. Sent notes contain source metadata, quoted text and the person's comment as ordinary message content. The original file is not reread during send. Clicking Send shares the quote with conversation participants and the configured model provider. No annotation is sent automatically.

File requests require an authorized steering user and conversation. Paths resolve within the session workspace. The reader rejects symlink escape, protected Pocket data/agent directories, non-regular files, invalid UTF-8, NUL bytes and files larger than 1 MiB. Single-session invitees are not supported by the extension client's current access model.

## Cache diagnostics

Enable `cache-diagnostics.ts` and its adjacent `cache-diagnostics.js` browser file from `docs/examples/`. The panel shows conversation usage, provider/model totals, cost components, bounded manual samples and new committed response/keeper-refresh observations. `/cache-diagnostics` provides a text summary. Recording a sample makes no model call and does not warm the cache.

The core retains the newest 100 aggregate observations per conversation. It stores counts, costs and IDs, not prompts. Observation storage follows usage storage in a separate commit: a crash in between can omit an observation. Compaction requests and historical request causes are not reconstructed. Missing provider information is unknown, not zero-cost proof. Costs follow the provider/model accounting and are not an invoice reconciliation.

No cache policy changes are included. There is no matched DSH/Pocket efficiency result yet. A real comparison must control model, upstream route and workload, and include refresh spending. Do not infer savings from cache read share alone.

## Release and rollback

The active owner-facing service is the global npm installation, not this worktree. Never edit that npm installation in place. A release must use the existing service and data folder, package these verified source changes, install the two drop-ins through the supported extension path, and restart only at a safe boundary. Do not start a second production server or copy live conversation data.

Keep the previous executable/service configuration and package revision before switching. Disable either extension independently in Menu → Extensions. Revert to the previous executable and restart to undo core changes; do not delete stored conversations or annotations. Cache documents can remain unused. Browser-local unsent notes remain local and sent snapshots remain ordinary messages.

A source-level test copy proves the tested build only. Verify the actual owner URL, active executable/revision, annotation action and diagnostics panel after release before calling the changes live.
