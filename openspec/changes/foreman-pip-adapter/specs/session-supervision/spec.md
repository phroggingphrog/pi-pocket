# Spec Delta

## Purpose

Provide optional semantic supervision for explicitly selected Pi Pocket sessions. Keep assessment bounded, private by default, and separate from human approval authority.

## ADDED Requirements

### Requirement: Supervision is disabled by default

The system MUST keep Foreman supervision inactive unless the owner enables it and explicitly selects a conversation.

#### Scenario: Default runtime

- **WHEN** Foreman settings are absent or disabled
- **THEN** no Foreman process starts and no Foreman extension runs in any conversation

#### Scenario: Non-selected conversation

- **WHEN** the owner enables Foreman but does not select a conversation
- **THEN** that conversation runs without Foreman hooks

### Requirement: Assessment configuration is explicit

The system MUST refuse live assessments unless the owner explicitly configures a supported provider and model.

#### Scenario: Missing model

- **WHEN** a selected conversation starts work without a configured assessment model
- **THEN** supervision fails closed before sending evidence externally

### Requirement: Supervision identities are isolated

The system MUST give each conversation a stable identity and separate durable supervision state from every other conversation.

#### Scenario: Two selected conversations

- **WHEN** both conversations submit work
- **THEN** their work identities and persisted Foreman control state do not overlap

#### Scenario: Restart recovery

- **WHEN** the server restarts during supervised work
- **THEN** replay uses the same stable work identity and does not consume a continuation allowance twice

### Requirement: Evidence is bounded and disclosed

The system MUST send only explicitly selected, size-limited work evidence to the configured external assessment provider. It MUST NOT log credentials or evidence content.

#### Scenario: Oversized evidence

- **WHEN** the evidence exceeds the configured hard limit
- **THEN** the system halts supervision without truncating evidence or calling Foreman

#### Scenario: External assessment

- **WHEN** an assessment runs
- **THEN** only the configured prompt, tool event, completion feedback, and bounded result fields are sent

### Requirement: Supervision cannot grant approval

The system MUST leave tool approvals to Pi Pocket's existing human-controlled approval path. Foreman MUST NOT approve a blocked or pending call.

#### Scenario: Human approval is pending

- **WHEN** Pi Pocket waits for a person to approve or deny a tool call
- **THEN** Foreman cannot change that decision or resolve the request

#### Scenario: Supervisor returns an allow action

- **WHEN** Foreman returns an allow action
- **THEN** the normal Pi Pocket guard and person-controlled approval checks still run

### Requirement: Continuation and transport are bounded

The system MUST enforce fixed limits for continuation attempts, retries, assessment time, subprocess output, and per-session assessment budget.

#### Scenario: Continuation limit

- **WHEN** Foreman requests continuation beyond the configured maximum
- **THEN** the run halts and receives no further continuation

#### Scenario: Timeout or cancellation

- **WHEN** an assessment times out or its task is cancelled
- **THEN** the subprocess stops and the supervised operation fails closed

### Requirement: External actions remain prohibited

The adapter MUST reject supervisor actions that would approve, merge, deploy, publish, or execute repository instructions.

#### Scenario: External action requested

- **WHEN** a supervisor response requests approval, merge, deployment, publishing, or execution of repository instructions
- **THEN** the adapter halts the supervised operation without performing that action
