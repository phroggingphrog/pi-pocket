# Task gateway

## Requirements

### Requirement: OAuth-protected task MCP gateway

The system SHALL expose task tools through Streamable HTTP with OAuth 2.1 authorization code and PKCE. It SHALL publish protected-resource metadata and authorization-server metadata. It SHALL validate resource indicators, issuer, expiry, client, and granted scopes on every tool request. It SHALL reject missing or invalid authorization. The owner SHALL explicitly confirm a local OAuth consent step before a token is issued.

#### Scenario: valid authenticated client calls MCP

- **WHEN** an authorized OAuth client sends a valid access token with the required scope
- **THEN** the gateway SHALL execute only the requested task operation for the token owner

#### Scenario: invalid or missing token

- **WHEN** a request has no valid bearer token, expired token, wrong audience, or insufficient scope
- **THEN** the gateway SHALL reject the request without revealing task data

### Requirement: durable task identity and idempotency

The system SHALL persist each external task ID, owner, idempotency key, Pi Pocket conversation ID, and submission request ID before it reports successful admission. A retry with the same owner and idempotency key SHALL return the original task. A different owner SHALL NOT reuse or inspect that mapping. Restart recovery SHALL read the durable mapping and Pi Pocket task state without starting duplicate work.

#### Scenario: duplicate submission

- **WHEN** the same owner submits the same idempotency key again
- **THEN** the gateway SHALL return the original external task ID and SHALL NOT send a second Pi Pocket submission

#### Scenario: gateway restart

- **WHEN** the gateway restarts after successful task admission
- **THEN** it SHALL recover the mapping and report the Pi Pocket submission state without duplicating it

### Requirement: isolated owner-scoped tasks

The system SHALL accept only explicit repository paths under a configured canonical workspace root. It SHALL reject symlinks, traversal, missing paths, and paths outside that root. It SHALL create a separate Pi Pocket conversation per task. It SHALL use only the model already selected for that conversation by the person. It SHALL enforce prompt, request, task-count, and output limits.

#### Scenario: unsafe repository path

- **WHEN** the client supplies a path outside the configured root, a traversal path, or a symlink
- **THEN** the gateway SHALL reject the request before creating a session or submitting a task

#### Scenario: cross-owner access

- **WHEN** an authenticated owner requests another owner's external task ID
- **THEN** the gateway SHALL return no task state or result

### Requirement: safe task lifecycle tools

The system SHALL provide mutating `submit_task` and `cancel_task` tools, and read-only `get_task_status` and `get_task_result` tools. Cancellation SHALL use Pi Pocket's supported conversation abort interface and SHALL report actual cancellation state. Result retrieval SHALL require a bounded page size and cursor, and SHALL return a continuation cursor when data remains. The system SHALL never silently truncate. The MCP tools SHALL NOT approve Pi Pocket approvals, choose a model, merge changes, or deploy.

#### Scenario: human approval remains pending

- **WHEN** a task waits for a Pi Pocket approval
- **THEN** the gateway SHALL report its pending state and SHALL NOT create, answer, or bypass the approval

#### Scenario: paginated results

- **WHEN** a result has more content than one allowed page
- **THEN** the gateway SHALL return a bounded page and a cursor for the remaining content
