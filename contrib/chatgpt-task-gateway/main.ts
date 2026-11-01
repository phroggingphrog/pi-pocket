import { readFile } from "node:fs/promises";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { configFrom } from "./gateway.ts";
import { PocketOAuthProvider, SCOPES } from "./oauth.ts";
import { StateStore } from "./state.ts";
import { PocketTaskGateway } from "./runtime.ts";
import { createServer } from "node:http";

const envFile = new URL("./.env", import.meta.url);
const local = Object.fromEntries(
    (await readFile(envFile, "utf8")).split(/\r?\n/).flatMap((line) => {
        const text = line.trim();
        const index = text.indexOf("=");

        return !text || text.startsWith("#") || index < 1
            ? []
            : [[text.slice(0, index), text.slice(index + 1)]];
    }),
);
const env = { ...local, ...process.env };
const config = configFrom(env);

if (env.GATEWAY_ENABLED !== "true") {
    throw new Error(
        "Gateway is disabled. Set GATEWAY_ENABLED=true only for an isolated local test.",
    );
}

const pocketApiUrl = new URL(config.pocketApiUrl);
const pocketPort = String(env.PI_POCKET_PORT ?? "8788");

if (
    !new Set(["127.0.0.1", "localhost", "::1"]).has(pocketApiUrl.hostname) ||
    pocketApiUrl.port !== pocketPort
) {
    throw new Error("The Pocket API must use the configured loopback test port.");
}

const store = await StateStore.open(config.statePath);
const resource = `${config.publicUrl}/mcp`;
const sourceSession = config.sourceConversationId;

if (!/^[1-9]\d*$/.test(sourceSession)) {
    throw new Error("GATEWAY_SOURCE_SESSION must be a positive session id.");
}

if (!config.bridgeToken || config.bridgeToken.length < 24) {
    throw new Error("PI_POCKET_CHATGPT_BRIDGE_TOKEN must contain at least 24 characters.");
}

const oauth = new PocketOAuthProvider({
    store,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    resource,
    approvalSecret: config.approvalSecret,
});

await oauth.ready();
const { PocketApp } = await import("../../src/server/app.ts");
const { createHandler } = await import("../../src/server/http.ts");
const pocket = await PocketApp.open({
    dataDir: process.env.PI_POCKET_DATA_DIR ?? "",
    defaultCwd: process.cwd(),
    supervised: false,
    log: () => {},
});
const owner = pocket.config.userByToken(config.pocketOwnerToken);

if (!owner || owner.role !== "owner" || owner.id !== config.ownerId) {
    await pocket.close();

    throw new Error("The Pocket credential does not match the configured owner.");
}

if (Number(env.PI_POCKET_PORT ?? 8788) === config.port) {
    await pocket.close();

    throw new Error("Pocket test API and MCP gateway must use different ports.");
}

const sourceMeta = pocket.sessionMeta(Number(sourceSession) as never);
const sourceOwner = sourceMeta?.linkedFrom
    ? pocket.sessionCatalogue()[String(sourceMeta.linkedFrom.id)]?.createdBy
    : sourceMeta?.createdBy;

if (!sourceMeta || sourceOwner !== owner.id) {
    await pocket.close();

    throw new Error("GATEWAY_SOURCE_SESSION must belong to the configured owner.");
}

const runtime = new PocketTaskGateway(config, oauth);

await runtime.ready();
const pocketServer = createServer(
    createHandler({
        app: pocket,
        listen: { host: "127.0.0.1", port: Number(env.PI_POCKET_PORT ?? 8788) },
        restart: () => {},
    }),
);

await new Promise<void>((resolve, reject) => {
    pocketServer.once("error", reject);
    pocketServer.listen(Number(env.PI_POCKET_PORT ?? 8788), "127.0.0.1", () => {
        pocketServer.off("error", reject);
        resolve();
    });
});
const app = createMcpExpressApp({ host: config.bind });

app.use(
    "/",
    mcpAuthRouter({
        provider: oauth,
        issuerUrl: new URL(config.publicUrl),
        baseUrl: new URL(config.publicUrl),
        resourceServerUrl: new URL(resource),
        scopesSupported: [...SCOPES],
        resourceName: "Pi Pocket task gateway",
    }),
);
app.post("/consent", async (req, res) =>
    oauth.completeConsent(
        String(req.body?.request ?? ""),
        String(req.body?.secret ?? ""),
        req.body?.approve === "yes",
        config.ownerId,
        config.publicUrl,
        res,
    ),
);
app.use(
    "/mcp",
    requireBearerAuth({
        verifier: oauth,
        resourceMetadataUrl: `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`,
    }),
);
app.post("/mcp", async (req, res) => {
    if (!(await runtime.handle(req as never, res, req.body))) {
        res.status(404).end();
    }
});
app.get("/mcp", async (req, res) => {
    if (!(await runtime.handle(req as never, res))) {
        res.status(404).end();
    }
});
app.delete("/mcp", async (req, res) => {
    if (!(await runtime.handle(req as never, res))) {
        res.status(404).end();
    }
});
const server = createServer(app);

server.requestTimeout = 60_000;
server.headersTimeout = 30_000;
await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bind, () => {
        server.off("error", reject);
        resolve();
    });
});

const stop = async () => {
    await runtime.close();
    await new Promise<void>((resolve) => pocketServer.close(() => resolve()));
    await pocket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
};

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
