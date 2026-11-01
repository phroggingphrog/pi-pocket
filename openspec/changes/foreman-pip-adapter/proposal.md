# Proposal

## Why

Pi Pocket runs Pi Durable 1.4.0, but Foreman's current bridge supports only Pi Durable 1.0.x. A version-matched, opt-in integration can supervise selected sessions while retaining Pi Pocket's own controls.

## What Changes

- Add a narrow adapter at Pi Pocket's harness integration point.
- Keep supervision off by default and require explicit per-conversation selection.
- Require the owner to configure a decision provider and model before external assessment.
- Bound assessment count, payload size, timeout, retry, output, and continuation.
- Keep approval decisions with people. Do not allow approval, merge, deployment, or repository-instruction execution through Foreman.
- Add deterministic tests and isolated pilot, evidence, setup, and rollback documentation.

## Capabilities

### New Capabilities

- `session-supervision`: Optional, selected-session semantic supervision with bounded evidence and no approval authority.

### Modified Capabilities

## Impact

- Pi Pocket's harness settings and extension registry.
- Pi Durable 1.4.0 hooks and durable conversation documents.
- The Foreman hook subprocess and its selected assessment provider.
- Automated tests and extension documentation. No live data, configuration, provider credentials, or service changes.
