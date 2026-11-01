import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";
import type { GatewayConfig } from "./gateway.ts";
import type { PocketOAuthProvider } from "./oauth.ts";

const MAX_PAGE = 100;
const MAX_RESULT_BYTES = 48_000;

type Auth = { token: string; clientId: string; extra?: { owner?: string }; scopes: string[] };

export class PocketTaskGateway {
    readonly #config: GatewayConfig;
    readonly #oauth: PocketOAuthProvider;
    readonly #servers = new Map<
        string,
        { transport: StreamableHTTPServerTransport; server: McpServer; owner: string }
    >();

    constructor(config: GatewayConfig, oauth: PocketOAuthProvider) {
        this.#config = config;
        this.#oauth = oauth;
    }
    async ready() {
        await this.#oauth.ready();
    }

    async handle(
        req: IncomingMessage & { auth?: Auth },
        res: ServerResponse,
        parsedBody?: unknown,
    ): Promise<boolean> {
        if (new URL(req.url ?? "/", this.#config.publicUrl).pathname !== "/mcp") {
            return false;
        }

        const owner = String(req.auth?.extra?.owner ?? "");

        if (owner !== this.#config.ownerId) {
            res.writeHead(403).end();

            return true;
        }

        if (req.method === "POST") {
            const body = (parsedBody ?? {}) as any;
            const requiredScope =
                body.method === "tools/call"
                    ? (
                          {
                              submit_task: "task:submit",
                              get_task_status: "task:read",
                              get_task_result: "task:read",
                              cancel_task: "task:cancel",
                          } as Record<string, string>
                      )[body.params?.name ?? ""]
                    : undefined;

            if (requiredScope && !req.auth?.scopes.includes(requiredScope)) {
                res.writeHead(403).end();

                return true;
            }

            const id = String(req.headers["mcp-session-id"] ?? "");
            let slot = id ? this.#servers.get(id) : undefined;

            if (id && (!slot || slot.owner !== owner)) {
                res.writeHead(404).end();

                return true;
            }

            if (!slot) {
                if (body.method !== "initialize") {
                    res.writeHead(400).end();

                    return true;
                }

                const server = this.#mcp(owner),
                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => randomUUID(),
                        enableJsonResponse: true,
                    });

                slot = { transport, server, owner };
                await server.connect(transport);

                transport.onclose = () => {
                    if (transport.sessionId) {
                        this.#servers.delete(transport.sessionId);
                    }

                    void server.close();
                };
            }

            await slot.transport.handleRequest(req, res, parsedBody);

            if (slot.transport.sessionId) {
                this.#servers.set(slot.transport.sessionId, slot);
            }

            return true;
        }

        if (req.method === "GET" || req.method === "DELETE") {
            const slot = this.#servers.get(String(req.headers["mcp-session-id"] ?? ""));

            if (!slot || slot.owner !== owner) {
                res.writeHead(404).end();

                return true;
            }

            await slot.transport.handleRequest(req, res);

            return true;
        }

        res.writeHead(405).end();

        return true;
    }

    async close() {
        const slots = [...this.#servers.values()];

        this.#servers.clear();

        for (const { transport, server } of slots) {
            transport.onclose = undefined;
            await transport.close();
            await server.close();
        }
    }

    #mcp(owner: string) {
        const call = async (operation: string, args: Record<string, unknown>) =>
            this.#call(owner, operation, args);
        const server = new McpServer({ name: "pi-pocket-task-gateway", version: "0.1.0" });

        server.registerTool(
            "submit_task",
            {
                title: "Submit Pi Pocket task",
                description:
                    "Start an owner-authorized, session-scoped task. Pi Pocket controls model selection and every approval.",
                inputSchema: {
                    prompt: z.string().min(1).max(20_000),
                    repositoryPath: z.string().min(1).max(512),
                    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/),
                },
                annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
            },
            async (args) =>
                call("submit", {
                    prompt: args.prompt,
                    repositoryPath: args.repositoryPath,
                    idempotencyKey: args.idempotencyKey,
                }),
        );
        server.registerTool(
            "get_task_status",
            {
                title: "Get task status",
                description: "Read status and pending human approval state.",
                inputSchema: { taskId: z.string().uuid() },
                annotations: { readOnlyHint: true, openWorldHint: false },
            },
            async ({ taskId }) => call("status", { taskId }),
        );
        server.registerTool(
            "get_task_result",
            {
                title: "Get paginated task results",
                description: "Read bounded durable transcript entries. Use nextCursor to continue.",
                inputSchema: {
                    taskId: z.string().uuid(),
                    cursor: z.string().optional(),
                    limit: z.number().int().min(1).max(MAX_PAGE).default(50),
                },
                annotations: { readOnlyHint: true, openWorldHint: false },
            },
            async ({ taskId, cursor, limit }) =>
                call("results", { taskId, cursor, limit: limit ?? 50 }),
        );
        server.registerTool(
            "cancel_task",
            {
                title: "Cancel task",
                description: "Stop an owned task. This does not approve a human request.",
                inputSchema: { taskId: z.string().uuid() },
                annotations: {
                    readOnlyHint: false,
                    destructiveHint: true,
                    idempotentHint: true,
                    openWorldHint: false,
                },
            },
            async ({ taskId }) => call("cancel", { taskId }),
        );

        return server;
    }

    async #call(owner: string, operation: string, args: Record<string, unknown>) {
        const path = `/api/x/chatgpt-gateway/gateway/${encodeURIComponent(this.#config.sourceConversationId)}/${operation}`;
        const controller = new AbortController(),
            timer = setTimeout(() => controller.abort(), 10_000);

        try {
            const response = await fetch(new URL(path, `${this.#config.pocketApiUrl}/`), {
                method: "POST",
                headers: {
                    authorization: `Bearer ${this.#config.pocketOwnerToken}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    ...args,
                    bridgeToken: this.#config.bridgeToken,
                    bridgeOwner: owner,
                }),
                signal: controller.signal,
            });
            const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;

            if (!response.ok) {
                throw new Error(
                    typeof value.error === "string"
                        ? value.error
                        : `Pi Pocket returned HTTP ${response.status}.`,
                );
            }

            const text = JSON.stringify(value);

            if (Buffer.byteLength(text) > MAX_RESULT_BYTES + 1000) {
                throw new Error("Pi Pocket response exceeds the output limit.");
            }

            return { content: [{ type: "text" as const, text }], structuredContent: value };
        } finally {
            clearTimeout(timer);
        }
    }
}
