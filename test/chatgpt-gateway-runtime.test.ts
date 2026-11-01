import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { cleanUp, newSession, openApp, owner, scriptedModel, until, type App } from "./helpers.ts";
import { createServer } from "node:http";
import { createHandler } from "../src/server/http.ts";
import { PocketOAuthProvider, SCOPES } from "../contrib/chatgpt-task-gateway/oauth.ts";
import { StateStore } from "../contrib/chatgpt-task-gateway/state.ts";
import { PocketTaskGateway } from "../contrib/chatgpt-task-gateway/runtime.ts";
import { configFrom } from "../contrib/chatgpt-task-gateway/gateway.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";

const target = mkdtempSync(join(tmpdir(), "chatgpt-gateway-runtime-"));
const workspace = join(target, "workspace");

mkdirSync(workspace);
mkdirSync(join(workspace, "repo"));
mkdirSync(join(workspace, "repo-2"));
let app: App;
let source: ConversationId;
let pocketServer: ReturnType<typeof createServer>;
let gatewayServer: ReturnType<typeof createServer>;
let gateway: PocketTaskGateway;
let oauth: PocketOAuthProvider;
let pocketPort = 0;
let accessToken = "";
let calls = 0;

const scripted = async (ctx: any) => {
    calls++;
    const messages = JSON.stringify(ctx.messages);

    if (messages.includes("approval-trigger")) {
        const { fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");

        return fauxAssistantMessage([
            fauxToolCall("approval-tool", {
                id: "approval-call",
                name: "approval-tool",
                arguments: {
                    command: "touch blocked.txt",
                    cwd: process.cwd(),
                },
            }),
        ]);
    }

    return fauxAssistantMessage([fauxText(`mocked-result-${calls}`)]);
};

before(async () => {
    process.env.PI_POCKET_CHATGPT_BRIDGE_TOKEN = "local-test-bridge-token-0123456789";
    app = await openApp(scriptedModel(scripted as any), join(target, "pocket-data"));
    source = await newSession(app, workspace);
    app.config.setExtensionEnabled("chatgpt-gateway.ts", true);
    await app.close();
    app = await openApp(scriptedModel(scripted as any), join(target, "pocket-data"));
    const person = owner(app);

    app.config.setExtensionSettings("chatgpt-gateway", { enabled: true, workspaceRoot: workspace });
    await app.setExtensionEnabled(person, "chatgpt-gateway.ts", true);
    const pocketApi = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    pocketServer = pocketApi;
    await new Promise<void>((resolve) => pocketApi.listen(0, "127.0.0.1", resolve));
    pocketPort = (pocketApi.address() as { port: number }).port;
    const config = configFrom({
        POCKET_API_URL: `http://127.0.0.1:${pocketPort}`,
        POCKET_OWNER_TOKEN: app.config.ownerToken,
        GATEWAY_PUBLIC_URL: "http://127.0.0.1:18787",
        GATEWAY_CLIENT_ID: "test-client",
        GATEWAY_CLIENT_SECRET: "x".repeat(32),
        GATEWAY_APPROVAL_SECRET: "y".repeat(24),
        GATEWAY_OWNER_ID: person.id,
        GATEWAY_WORKSPACE_ROOT: workspace,
        GATEWAY_BIND: "127.0.0.1",
        GATEWAY_PORT: "18787",
        GATEWAY_STATE_PATH: join(target, "gateway-state.json"),
        GATEWAY_SOURCE_SESSION: String(source),
        PI_POCKET_CHATGPT_BRIDGE_TOKEN: process.env.PI_POCKET_CHATGPT_BRIDGE_TOKEN,
    });
    const state = await StateStore.open(config.statePath);

    oauth = new PocketOAuthProvider({
        store: state,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        resource: `${config.publicUrl}/mcp`,
        approvalSecret: config.approvalSecret,
    });

    await oauth.ready();
    gateway = new PocketTaskGateway(config, oauth);
    const { createMcpExpressApp } = await import("@modelcontextprotocol/sdk/server/express.js");
    const { mcpAuthRouter } = await import("@modelcontextprotocol/sdk/server/auth/router.js");
    const { requireBearerAuth } =
        await import("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");
    const http = createMcpExpressApp({ host: "127.0.0.1" });

    http.use(
        "/",
        mcpAuthRouter({
            provider: oauth,
            issuerUrl: new URL(config.publicUrl),
            baseUrl: new URL(config.publicUrl),
            resourceServerUrl: new URL(`${config.publicUrl}/mcp`),
            scopesSupported: [...SCOPES],
        }),
    );
    http.use(
        "/mcp",
        requireBearerAuth({
            verifier: oauth,
            resourceMetadataUrl: `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`,
        }),
    );
    http.post("/mcp", (req: any, res: any) => void gateway.handle(req, res, req.body));
    http.get("/mcp", (req: any, res: any) => void gateway.handle(req, res));
    http.delete("/mcp", (req: any, res: any) => void gateway.handle(req, res));
    gatewayServer = createServer(http);
    await new Promise<void>((resolve) => gatewayServer.listen(0, "127.0.0.1", resolve));
    const oauthClient = oauth.client(config.clientId)!;
    const verifier = "test-verifier-12345678901234567890123456789012";
    const { createHash } = await import("node:crypto");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let consentHtml = "";
    const consentResponse = {
        status() {
            return this;
        },
        type() {
            return this;
        },
        set() {
            return this;
        },
        send(text: string) {
            consentHtml = text;

            return this;
        },
        redirect() {
            return this;
        },
    } as any;

    await oauth.authorize(
        oauthClient as never,
        {
            redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
            codeChallenge: challenge,
            state: "local-state",
            scopes: [...SCOPES],
            resource: new URL(`${config.publicUrl}/mcp`),
        } as never,
        consentResponse,
    );
    const requestId = consentHtml.match(/name="request" value="([^"]+)"/)![1]!;
    let location = "";
    const redirectResponse = {
        status() {
            return this;
        },
        type() {
            return this;
        },
        send() {
            return this;
        },
        redirect(_code: number, url: string) {
            location = url;

            return this;
        },
    } as any;

    await oauth.completeConsent(
        requestId,
        config.approvalSecret,
        true,
        person.id,
        config.publicUrl,
        redirectResponse,
    );
    const code = new URL(location).searchParams.get("code")!;

    accessToken = (
        await oauth.exchangeAuthorizationCode(
            oauthClient as never,
            code,
            verifier,
            "https://chatgpt.com/connector_platform_oauth_redirect",
            new URL(`${config.publicUrl}/mcp`),
        )
    ).access_token;
});

after(async () => {
    gatewayServer?.closeAllConnections();
    gatewayServer?.close();
    pocketServer?.closeAllConnections();
    pocketServer?.close();
    await gateway?.close();
    await app?.close();
    rmSync(target, { recursive: true, force: true });
    cleanUp();
});

async function mcp(method: string, params?: unknown, session?: string) {
    const response = await fetch(
        `http://127.0.0.1:${(gatewayServer.address() as { port: number }).port}/mcp`,
        {
            method: "POST",
            headers: {
                authorization: `Bearer ${accessToken}`,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                ...(session ? { "mcp-session-id": session } : {}),
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: Math.floor(Math.random() * 1e8),
                method,
                ...(params === undefined ? {} : { params }),
            }),
        },
    );

    return { response, json: (await response.json().catch(() => ({}))) as any };
}

async function initialize() {
    const { response } = await mcp("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "local-test", version: "1" },
    });

    assert.equal(response.status, 200);
    const session = response.headers.get("mcp-session-id");

    assert.ok(session);
    await fetch(`http://127.0.0.1:${(gatewayServer.address() as { port: number }).port}/mcp`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-session-id": session,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    return session;
}

async function tool(session: string, name: string, args: Record<string, unknown>) {
    return mcp("tools/call", { name, arguments: args }, session);
}

function content<T>(result: any): T {
    assert.equal(result.response.status, 200);
    const text = result.json.result.content[0].text;

    return JSON.parse(text) as T;
}

test("disposable faux-model runtime verifies idempotency, session scope, pagination, approval blocking, cancel, and restart recovery", async () => {
    await until(() => !!accessToken, "OAuth token");
    let session = await initialize();
    const key = "local-test-idempotency-0001";
    const submitted = content<{ taskId: string; status: string }>(
        await tool(session, "submit_task", {
            prompt: "Run a safe test and report the result.",
            repositoryPath: "repo",
            idempotencyKey: key,
        }),
    );

    assert.equal(submitted.status, "running");
    await until(async () => {
        const status = content<{ status: string }>(
            await tool(session, "get_task_status", { taskId: submitted.taskId }),
        );

        return status.status === "completed";
    }, "mocked task completion");
    const repeated = content<{ taskId: string; duplicate: boolean }>(
        await tool(session, "submit_task", {
            prompt: "This retry must not submit twice.",
            repositoryPath: "repo",
            idempotencyKey: key,
        }),
    );

    assert.equal(repeated.taskId, submitted.taskId);
    assert.equal(repeated.duplicate, true);
    const foreign = content<{ taskId: string }>(
        await tool(session, "submit_task", {
            prompt: "Another isolated task.",
            repositoryPath: "repo-2",
            idempotencyKey: "local-test-idempotency-0002",
        }),
    );

    assert.notEqual(foreign.taskId, submitted.taskId);
    const status = content<{ status: string; approvalPending: boolean }>(
        await tool(session, "get_task_status", { taskId: submitted.taskId }),
    );

    assert.equal(status.approvalPending, false);
    const page = content<{ entries: unknown[] }>(
        await tool(session, "get_task_result", { taskId: submitted.taskId, limit: 10 }),
    );

    assert.ok(page.entries.length > 0);
    assert.ok(calls > 0);
    const taskOwner = owner(app!);
    const records = app!.sessionCatalogue();
    const taskSession = Object.entries(records).find(
        ([id, meta]) => id !== String(source) && meta.createdBy === taskOwner.id,
    )![0];

    const pendingApproval = app!.approvals.request(
        {
            id: `gateway-approval-${Date.now()}`,
            conversationId: Number(taskSession) as ConversationId,
            taskId: "local-test-task" as never,
            callId: "local-test-call",
            tool: "bash",
            subject: "touch blocked.txt",
            reason: "Test approval remains person controlled.",
            createdAt: Date.now(),
        },
        (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT,
    );
    const approvals = app!.approvals.all();

    assert.ok(approvals.some((item) => Number(item.conversationId) === Number(taskSession)));
    const approvalState = content<{ approvalPending: boolean; status: string }>(
        await tool(session, "get_task_status", { taskId: submitted.taskId }),
    );

    assert.equal(approvalState.approvalPending, true);
    assert.equal(approvalState.status, "waiting");
    assert.equal(app!.approvals.all().length, 1);
    gatewayServer.closeAllConnections();
    await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
    await gateway.close();
    pocketServer.closeAllConnections();
    await new Promise<void>((resolve) => pocketServer.close(() => resolve()));
    await app!.close();
    app = await openApp(scriptedModel(scripted as any), join(target, "pocket-data"));
    const recovered = app.sessionCatalogue();

    assert.ok(Object.keys(recovered).length > 1);
    app.config.setExtensionSettings("chatgpt-gateway", { enabled: true, workspaceRoot: workspace });
    await app.setExtensionEnabled(owner(app), "chatgpt-gateway.ts", true);
    pocketServer = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: pocketPort }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => pocketServer.listen(pocketPort, "127.0.0.1", resolve));
    gateway = new PocketTaskGateway(
        configFrom({
            POCKET_API_URL: `http://127.0.0.1:${pocketPort}`,
            POCKET_OWNER_TOKEN: app.config.ownerToken,
            GATEWAY_PUBLIC_URL: "http://127.0.0.1:18787",
            GATEWAY_CLIENT_ID: "test-client",
            GATEWAY_CLIENT_SECRET: "x".repeat(32),
            GATEWAY_APPROVAL_SECRET: "y".repeat(24),
            GATEWAY_OWNER_ID: owner(app).id,
            GATEWAY_WORKSPACE_ROOT: workspace,
            GATEWAY_BIND: "127.0.0.1",
            GATEWAY_PORT: "18787",
            GATEWAY_STATE_PATH: join(target, "gateway-state.json"),
            GATEWAY_SOURCE_SESSION: String(source),
            PI_POCKET_CHATGPT_BRIDGE_TOKEN: process.env.PI_POCKET_CHATGPT_BRIDGE_TOKEN,
        }),
        oauth,
    );
    const restartedHttp = (
        await import("@modelcontextprotocol/sdk/server/express.js")
    ).createMcpExpressApp({ host: "127.0.0.1" });
    const { requireBearerAuth } =
        await import("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");

    restartedHttp.use(
        "/mcp",
        requireBearerAuth({
            verifier: oauth,
            resourceMetadataUrl: "http://127.0.0.1:18787/.well-known/oauth-protected-resource/mcp",
        }),
    );
    restartedHttp.post("/mcp", (req: any, res: any) => void gateway!.handle(req, res, req.body));
    restartedHttp.get("/mcp", (req: any, res: any) => void gateway!.handle(req, res));
    restartedHttp.delete("/mcp", (req: any, res: any) => void gateway!.handle(req, res));
    gatewayServer = createServer(restartedHttp);
    await new Promise<void>((resolve) => gatewayServer.listen(0, "127.0.0.1", resolve));
    session = await initialize();
    const recoveredStatus = content<{ status: string }>(
        await tool(session, "get_task_status", { taskId: submitted.taskId }),
    );

    assert.ok(["running", "completed", "waiting"].includes(recoveredStatus.status));
    const cancelled = content<{ status: string }>(
        await tool(session, "cancel_task", { taskId: submitted.taskId }),
    );

    assert.equal(cancelled.status, "cancelled");
    const sourceTwo = await newSession(app!, workspace);
    const token = app!.config.ownerToken;
    const routeResponse = await fetch(
        `http://127.0.0.1:${pocketPort}/api/x/chatgpt-gateway/gateway/${sourceTwo}/status`,
        {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                taskId: submitted.taskId,
                bridgeToken: "local-test-bridge-token-0123456789",
                bridgeOwner: owner(app!).id,
            }),
        },
    );

    assert.equal(routeResponse.status, 404);
    assert.deepEqual(await routeResponse.json(), { error: "Task not found." });
    void pendingApproval;
});
