# Foreman adapter pilot

The adapter targets Pi Durable 1.4.0. It uses Pi Pocket's runtime hooks. It does not load the upstream Pi bridge package. Keep the module disabled until the owner approves a pilot.

## Installation and setup

1. Create a disposable Pi Pocket checkout and data folder. Do not use live data.
2. Install the checkout's locked packages with `npm ci`.
3. Install Foreman core in a dedicated virtual environment or with `pipx`. The upstream bridge guide supports `pipx install 'foreman-core>=0.4.4'`.
4. Configure provider credentials in the pilot-only Foreman data folder. Jev uses `TYPESAFE_API_KEY`. OpenAI Decisions needs `FOREMAN_OPENAI_API_KEY` and `foreman-core[openai]`. Do not put credentials in Pi Pocket settings or chat text.
5. Enable `Foreman supervision` in Menu → Extensions. Set the executable, isolated Foreman data folder, provider, and model. The model field must be explicit. The adapter passes `FOREMAN_DECISION_PROVIDER` and `FOREMAN_DECISION_MODEL` to Foreman.
6. In only the disposable session, run `/foreman-session on`. Run `/foreman-session off` to deselect it. The initial default selection excludes Foreman.
7. Use a non-sensitive task. Check the evidence and provider use. Do not use production source, live credentials, or a deployment target. Do not enable merge, publish, release, or deployment operations.

## Evidence sent to the assessment provider

The JSON hook envelope contains the canonical Pi Pocket data-folder path and conversation ID as the stable session ID. It contains the working directory, durable input submission IDs, the text of submitted user prompts, and a lifecycle event. A tool event can include the tool name, arguments, and result. A completion event can include the last assistant answer. The envelope is limited to 24,000 bytes. Text values are limited to 4,000 characters.

The adapter does not copy Pi Pocket secrets into the payload or logs. It sends JSON over stdin. It ignores subprocess stderr and does not log evidence or response bodies. The child environment is limited to `PATH`, `HOME`, and Foreman settings. Foreman reads its provider credential from its own data folder. External assessment can cost money. A session permits at most 20 assessments and 2 continuation requests. Each process has a 15-second timeout and an 8,192-byte output limit. The adapter retries no provider request.

## Approval and action boundaries

The adapter cannot answer Pi Pocket approval requests. Lancet Guard and the person remain responsible for approvals. Foreman cannot approve a blocked call. Do not enable pull-request merging, deployment, release, publishing, or external repository changes in the pilot. Foreman output is treated as bounded feedback, not as shell input.

## Rollback

Run `/foreman-session off` in the pilot session. Disable `Foreman supervision` in Menu → Extensions. Stop the disposable server and retain or discard only disposable pilot data. Do not alter the production data folder or service. Revert the feature commit to remove code. A live release needs the owner-controlled normal Pi Pocket update and restart process; this task does not run it.
