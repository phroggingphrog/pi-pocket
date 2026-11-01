# ChatGPT task adapter

## Intent

Provide ChatGPT with a safe, authenticated way to submit and inspect work in the existing Pi Pocket Pi Durable runtime.

## Scope

Add remote MCP tools for task submission, status, bounded result retrieval, and cancellation. Persist task identity, requester ownership, and idempotency state. Recover without submitting duplicate work after restart. Preserve Pi Pocket authorization, human approvals, and runtime cancellation behavior.

## Constraints

- Use the existing Pi Pocket server and Pi Durable runtime. Do not deploy `disler/durable-pi`.
- Implement on the v0.27.0 integration base in a separate feature worktree. Do not overwrite other worktrees.
- Use Streamable HTTP and OAuth 2.1 authorization code with PKCE, with discovery, resource indicators, and explicit scopes. A static bearer token alone is not sufficient.
- Do not expose model selection, approvals, automatic merge, or deployment.
- A separate loopback-only gateway process is authorized in a disposable test environment. Do not expose a public endpoint, install a live service, change routing, or restart Pi Pocket.
- Do not include prompt content, credentials, or private work output in logs.
- License-check the reference design. Keep its notices if code is copied.

## Acceptance

- The adapter submits, polls, reads bounded paginated results, and cancels only tasks owned by the authenticated person.
- Submission IDs and idempotency keys persist. Recovery does not duplicate work.
- Task state tracks the existing durable runtime. Cancellation matches the runtime and reports its actual state.
- Explicit scopes, owner authorization, per-task isolation, request limits, and safe repository path validation block unauthorized work.
- Approval decisions remain person-controlled. MCP cannot grant approvals.
- Controlled local tests cover submission, polling, result pagination, cancellation, restart recovery, duplicate submissions, authentication, cross-owner denial, and approval blocking. Tests make no paid model calls.
- Setup, secret-free example configuration, ChatGPT connection steps, disposable pilot, and rollback are documented.
- Run full relevant checks, tests, and builds. Open a verified PR only in the owner's repository.

## External references

- Reference design: https://github.com/XiaoDuoYa/codex-with-chatgpt (MIT; no code copied at proposal time).
- OpenAI ChatGPT custom MCP connection: https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- OpenAI MCP authentication: https://developers.openai.com/plugins/build/auth
- OpenAI Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
