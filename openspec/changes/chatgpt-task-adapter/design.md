# Design: ChatGPT task adapter

## Separate gateway architecture

The owner has authorized a separate gateway process in a disposable test environment. The gateway MUST bind to loopback in this prototype. It MUST NOT expose a public endpoint, install a live service, change routing, or restart Pi Pocket.

The gateway uses MCP TypeScript SDK `1.25.2`, which implements MCP `2025-11-25`. It provides Streamable HTTP, OAuth authorization-code and PKCE handling, OAuth discovery metadata, scoped tokens, and local fixture tests. OAuth consent requires an explicit local owner secret. The design does not copy source code from the reference repository. The reference repository has an MIT license.

The requested ChatGPT integration needs HTTPS reachability. The owner did not authorize a public endpoint or tunnel. Therefore, this branch can test the local protocol and OAuth flow only. It cannot connect ChatGPT to the loopback server.

## Runtime integration status

Pi Pocket v0.27.0 does not expose a supported in-process MCP server hook to a separate process. The standard `web.route` extension API only serves authenticated Pi Pocket users. It does not provide a public MCP endpoint, Streamable HTTP session transport, or OAuth discovery and authorization. The prototype has a proposed durable adapter file, but the sidecar does not load it through a supported Pi Pocket capability.

The sidecar's current task operations use a Pi Pocket owner API token. The sidecar does not prove that its configured owner matches an authenticated Pi Pocket user. It does not safely authorize distinct external people. It must not run task operations against a real instance.

## Durable task operations

The proposed adapter uses stable idempotency keys, per-owner mappings, a bounded active-task count, validated workspace paths, and Pi Pocket linked sessions. It preserves Pi Pocket approvals and selected models. It does not provide approval, merge, or deployment tools.

The adapter has not been integrated into the gateway. Submission, task status, cancellation, result retrieval, recovery, and restart behavior have not been tested through the adapter. Acceptance remains incomplete.

## Current local tests

Local tests verify OAuth discovery, authorization code and PKCE exchange, scope and resource binding, refresh-token rotation, revocation, missing-token rejection, cross-owner denial, duplicate-key storage, state restart loading, and the official SDK Streamable HTTP transport. They do not prove real Pi Pocket task behavior.

## Sources

- MCP OAuth 2.1 and authorization requirements: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- MCP Streamable HTTP requirements: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- OpenAI OAuth requirements: https://developers.openai.com/plugins/build/auth
- OpenAI ChatGPT MCP connection requirements: https://developers.openai.com/plugins/deploy/connect-chatgpt
