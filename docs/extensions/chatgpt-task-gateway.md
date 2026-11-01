# ChatGPT task gateway

This branch contains a local MCP gateway and a Pi Pocket task adapter. The gateway uses the official MCP TypeScript SDK. It implements OAuth 2.1 authorization and Streamable HTTP.

The owner authorized a separate gateway process in a disposable test environment. The gateway MUST bind to loopback. It MUST NOT expose a public endpoint, install a live service, change routing, or restart Pi Pocket.

## Integration status

The gateway connects to Pi Pocket through owner-authenticated, session-bound extension routes. Pi Pocket owns durable task records and starts linked sessions through its existing runtime. The extension is off by default. An owner must enable it in the extension settings and set an allowed workspace root. The sidecar also needs a local bridge token and an owner OAuth consent secret.

The four MCP tools submit, inspect status, cancel, and read bounded transcript pages. Idempotency keys prevent duplicate session starts after retries or recovery. The gateway is owner-only. The task record is scoped to its source session. Owner authorization is checked for each route. Repository paths must resolve under the configured root. Cancellation cannot answer an approval. Approval requests remain with the person in Pi Pocket.

Disposable-instance tests use the faux provider. They make no paid model calls. They verify task submission, retry idempotency, session isolation, cancellation, pagination, recovery after restart, and approval blocking. They do not verify a ChatGPT connection or a public HTTPS endpoint.

## Local tests

Run the root checks with `npm run check`, `npm run lint`, and `npm test`.

Run sidecar tests from `contrib/chatgpt-task-gateway` with `npm ci` and `npm test`.

Run the durable integration test with `node --experimental-strip-types --test test/chatgpt-gateway-runtime.test.ts`.

The owner explicitly authorized a disposable local instance. The tests use temporary data folders, loopback listeners, and mocked model responses. They do not use live credentials or services.

## Local sidecar setup

Copy `.env.example` to `.env`. Set the local owner token, owner ID, workspace path, bridge token, OAuth client secret, approval secret, state path, and a disposable source session. Set `GATEWAY_ENABLED=true` only for a disposable local test. Keep `.env` private and out of source control. The example file contains placeholders only.

The owner must turn on `chatgpt-gateway.ts` in Pi Pocket's Extensions settings. Its `enabled` setting defaults to `false`. The bridge binds to loopback and must remain local.

## ChatGPT reachability

The ChatGPT connector requires an HTTPS-reachable MCP endpoint. This task does not authorize a tunnel or public endpoint. Do not connect ChatGPT until the owner separately approves an HTTPS endpoint and the required security review.

## Protocol sources

- MCP authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- MCP Streamable HTTP: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- OpenAI authentication: https://developers.openai.com/plugins/build/auth
- OpenAI connect and test: https://developers.openai.com/plugins/deploy/connect-chatgpt
- MCP SDK release: https://www.npmjs.com/package/@modelcontextprotocol/sdk

The reference repository uses the MIT license. This branch copies no code from that repository.

## Rollback

Stop the disposable local gateway and Pocket test process. Turn off the `chatgpt-gateway.ts` extension in the disposable instance. Remove only the disposable test data when no longer needed. Do not alter live Pi Pocket data or configuration.
