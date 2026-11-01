import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { configFrom } from "./gateway.ts";
import { PocketOAuthProvider, SCOPES } from "./oauth.ts";
import { StateStore } from "./state.ts";

const roots: string[] = [];

after(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "gateway-protocol-"));

    roots.push(root);
    await mkdir(join(root, "repo"));
    const workspace = await realpath(root);
    const net = await import("node:net");
    const probe = net.createServer();

    await new Promise<void>((resolve, reject) => probe.listen(0, "127.0.0.1", () => resolve()));
    const address = probe.address();

    if (!address || typeof address === "string") {
        throw new Error("Port unavailable.");
    }

    const port = address.port;

    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const config = configFrom({
        POCKET_API_URL: "http://127.0.0.1:4000",
        POCKET_OWNER_TOKEN: "local-test-owner-token",
        GATEWAY_PUBLIC_URL: `http://127.0.0.1:${port}`,
        GATEWAY_CLIENT_ID: "local-test",
        GATEWAY_CLIENT_SECRET: "x".repeat(32),
        GATEWAY_APPROVAL_SECRET: "y".repeat(24),
        GATEWAY_OWNER_ID: "owner-a",
        GATEWAY_SOURCE_SESSION: "1",
        PI_POCKET_CHATGPT_BRIDGE_TOKEN: "bridge-token-test-1234567890",
        GATEWAY_WORKSPACE_ROOT: workspace,
        GATEWAY_BIND: "127.0.0.1",
        GATEWAY_PORT: String(port),
        GATEWAY_STATE_PATH: join(root, "state.json"),
    });

    return { root, config, state: await StateStore.open(config.statePath) };
}

test("OAuth middleware rejects missing tokens, cross-owner tokens, and wrong scopes", async () => {
    const { config, state } = await fixture();
    const resource = `${config.publicUrl}/mcp`;
    const oauth = new PocketOAuthProvider({
        store: state,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        resource,
        approvalSecret: config.approvalSecret,
    });

    await oauth.ready();
    const access = randomUUID();
    const wrongOwner = randomUUID();
    const wrongScope = randomUUID();
    const refresh = randomUUID();

    await state.putToken(access, {
        clientId: config.clientId,
        owner: config.ownerId,
        scopes: [...SCOPES],
        resource,
        expiresAt: Date.now() + 60_000,
    });
    await state.putToken(wrongOwner, {
        clientId: config.clientId,
        owner: "different-owner",
        scopes: [...SCOPES],
        resource,
        expiresAt: Date.now() + 60_000,
    });
    await state.putToken(wrongScope, {
        clientId: config.clientId,
        owner: config.ownerId,
        scopes: ["task:read"],
        resource,
        expiresAt: Date.now() + 60_000,
    });
    await state.putToken(refresh, {
        clientId: config.clientId,
        owner: config.ownerId,
        scopes: [...SCOPES],
        resource,
        expiresAt: Date.now() + 60_000,
    });
    const app = createMcpExpressApp({ host: "127.0.0.1" });

    app.use(
        mcpAuthMetadataRouter({
            oauthMetadata: {
                issuer: config.publicUrl,
                authorization_endpoint: `${config.publicUrl}/authorize`,
                token_endpoint: `${config.publicUrl}/token`,
                response_types_supported: ["code"],
                code_challenge_methods_supported: ["S256"],
            },
            resourceServerUrl: new URL(resource),
            scopesSupported: [...SCOPES],
        }),
    );
    app.use(
        "/mcp",
        requireBearerAuth({
            verifier: oauth,
            resourceMetadataUrl: `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`,
        }),
    );
    const sessions = new Map<
        string,
        { transport: StreamableHTTPServerTransport; server: McpServer; owner: string }
    >();

    app.post("/mcp", async (req, res) => {
        const owner = String(req.auth?.extra?.owner ?? "");

        if (owner !== config.ownerId) {
            res.status(404).end();

            return;
        }

        const body = req.body as any;
        const name = body?.params?.name;
        const required =
            name === "submit_task"
                ? "task:submit"
                : name === "cancel_task"
                  ? "task:cancel"
                  : name === "get_task_status" || name === "get_task_result"
                    ? "task:read"
                    : undefined;

        if (required && !req.auth?.scopes.includes(required)) {
            res.status(403).end();

            return;
        }

        let record = sessions.get(req.header("mcp-session-id") ?? "");

        if (record && record.owner !== owner) {
            res.status(404).end();

            return;
        }

        if (!record && req.header("mcp-session-id")) {
            res.status(404).end();

            return;
        }

        if (!record) {
            if (body?.method !== "initialize") {
                res.status(400).end();

                return;
            }

            const server = new McpServer({ name: "test-gateway", version: "1" });

            server.registerTool(
                "get_task_status",
                { description: "Read status", inputSchema: {} },
                async () => ({ content: [{ type: "text", text: "idle" }] }),
            );
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                enableJsonResponse: true,
            });

            record = { transport, server, owner };
            await server.connect(transport);

            transport.onclose = () => {
                if (transport.sessionId) {
                    sessions.delete(transport.sessionId);
                }
            };

            if (transport.sessionId) {
                sessions.set(transport.sessionId, record);
            }
        }

        await record.transport.handleRequest(req, res, req.body);

        if (record.transport.sessionId) {
            sessions.set(record.transport.sessionId, record);
        }
    });
    const server = await new Promise<import("node:http").Server>((resolveServer) => {
        const listening = app.listen(config.port, "127.0.0.1", () => resolveServer(listening));
    });
    const base = config.publicUrl;
    const standard = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
    };

    try {
        const discovery = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);

        assert.equal(discovery.status, 200);
        assert.deepEqual(((await discovery.json()) as any).scopes_supported, SCOPES);
        const noAuth = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: standard,
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-11-25",
                    capabilities: {},
                    clientInfo: { name: "test", version: "1" },
                },
            }),
        });

        assert.equal(noAuth.status, 401);
        const other = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: { ...standard, authorization: `Bearer ${wrongOwner}` },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "initialize",
                params: {
                    protocolVersion: "2025-11-25",
                    capabilities: {},
                    clientInfo: { name: "test", version: "1" },
                },
            }),
        });

        assert.equal(other.status, 404);
        const readToken = { ...standard, authorization: `Bearer ${wrongScope}` };
        const init = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: { ...readToken, prefer: "respond-async" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "initialize",
                params: {
                    protocolVersion: "2025-11-25",
                    capabilities: {},
                    clientInfo: { name: "test", version: "1" },
                },
            }),
        });

        assert.equal(init.status, 200);
        const sid = init.headers.get("mcp-session-id");

        assert.ok(sid);
        const initReply = (await init.json()) as any;

        assert.equal(initReply.result.protocolVersion, "2025-11-25");
        const common = {
            ...readToken,
            "mcp-session-id": sid!,
            "mcp-protocol-version": "2025-11-25",
            prefer: "respond-async",
        };
        const list = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: { ...common, prefer: "respond-async" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
        });

        assert.equal(list.status, 200);
        assert.equal(((await list.json()) as any).result.tools[0].name, "get_task_status");
        const denied = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: { ...common, prefer: "respond-async" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 5,
                method: "tools/call",
                params: { name: "submit_task", arguments: {} },
            }),
        });

        assert.equal(denied.status, 403);
        const accepted = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
                ...readToken,
                "mcp-session-id": sid!,
                "mcp-protocol-version": "2025-11-25",
                prefer: "respond-async",
            },
            redirect: "manual",
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 6,
                method: "tools/call",
                params: { name: "get_task_status", arguments: {} },
            }),
        });

        assert.equal(accepted.status, 200, await accepted.text());
    } finally {
        for (const record of sessions.values()) {
            await record.transport.close();
            await record.server.close();
        }

        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
});
