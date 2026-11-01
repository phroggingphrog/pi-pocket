# Design: Foreman supervision in Pi Pocket

## Runtime boundary

Pi Pocket creates one `Harness` and one extension registry in `PocketApp.#open()`. Add a narrow session-aware extension-selection function to `HarnessSettings.extensions`. Preserve the current set for all conversations unless both the opt-in setting and the selected-conversation allowlist match.

The adapter factory receives a stable `sessionId` derived from the canonical Pi Pocket data directory, the real conversation ID, its configured working directory, the runtime `Harness` accessor, explicit Foreman executable/data directory, selected provider/model settings, and hard limits. Do not infer activation from the mere presence of configuration.

## Persistence and recovery

The bridge's durable control document uses conversation scope and latest history. Add a per-conversation persisted record for enabled state, validated model reference, remaining continuation allowance, and last stable work identity. Keep provider credentials outside documents and logs. Use Pi Durable memo for replayed decision responses. Reject missing or changed identities where replay could repeat a charge or side effect.

## Decision and approval policy

Validate every external response against an allowlist of actions. The supervisor may permit normal flow, add bounded feedback, block a proposed tool, or halt. It cannot approve or release an approval request. Keep `pocket-guard` and human approval calls unchanged. Fail closed on transport errors, malformed responses, or budget exhaustion. Do not treat supervisor output as a command or execute repository-provided instructions.

## Evidence limits

Construct payloads from explicit lifecycle fields only. Cap prompt, tool arguments, tool results, assistant completion text, and total JSON bytes. Exclude environment values, credentials, user records, chat history beyond the submitted work, and unrelated sessions. Redact configured secrets before transport and never log request or response bodies. The owner must choose the decision provider and model. Require explicit model configuration before creating a live transport.

## Operational bounds

Use fixed maximum continuation count, one bounded retry only for explicitly safe transport failures, request timeout, subprocess kill on timeout or cancellation, maximum output bytes, and a per-session request/token budget. Do not allow automatic merge, deployment, release, or external publishing. Do not retry side effects. Preserve Foreman's original outcome text only after size and content checks.

## Tests

Use faux model providers and a local fixture process. Assert exact envelopes and identity, no process start when disabled, isolated conversation documents, block/allow/feedback behavior, no approval grant path, bounded completion continuation, canceled process termination, timeout fail-closed behavior, restart replay with no duplicate assessment, oversized evidence rejection, and no sensitive strings in logs. Test against the installed Pi Durable package contract from the lockfile and the exact 1.4.0 runtime.
