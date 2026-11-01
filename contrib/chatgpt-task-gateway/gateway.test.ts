import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { configFrom } from "./gateway.ts";
import { SCOPES } from "./oauth.ts";
import { StateStore } from "./state.ts";
import { startGateway } from "./gateway.ts";
const roots: string[] = [];

after(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
const env = (
    root: string,
    port = 18787 + Math.floor(Math.random() * 10000),
): NodeJS.ProcessEnv => ({
    POCKET_API_URL: "http://127.0.0.1:4000",
    POCKET_OWNER_TOKEN: "local-test-token",
    GATEWAY_PUBLIC_URL: `http://127.0.0.1:${port}`,
    GATEWAY_CLIENT_ID: "local-test",
    GATEWAY_CLIENT_SECRET: "x".repeat(32),
    GATEWAY_APPROVAL_SECRET: "y".repeat(24),
    GATEWAY_OWNER_ID: "owner",
    GATEWAY_SOURCE_SESSION: "1",
    PI_POCKET_CHATGPT_BRIDGE_TOKEN: "bridge-token-test-1234567890",
    GATEWAY_WORKSPACE_ROOT: root,
    GATEWAY_BIND: "127.0.0.1",
    GATEWAY_PORT: String(port),
    GATEWAY_STATE_PATH: join(root, "state.json"),
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "gateway-"));

    roots.push(root);
    await mkdir(join(root, "repo"));
    const config = configFrom(env(root));
    const state = await StateStore.open(config.statePath);

    return { root, config, state };
}

test("configuration refuses non-loopback listeners and upstreams", async () => {
    const { root } = await fixture();

    assert.equal(configFrom(env(root)).bind, "127.0.0.1");
    assert.throws(() => configFrom({ ...env(root), GATEWAY_BIND: "0.0.0.0" }), /loopback/);
    assert.throws(
        () => configFrom({ ...env(root), POCKET_API_URL: "http://192.168.1.2:4000" }),
        /loopback/,
    );
});
test("OAuth discovery publishes protected resource and S256 metadata", async () => {
    const { root, config, state } = await fixture();
    const running = await startGateway(config, { state, api: async () => [] });

    try {
        const base = `http://127.0.0.1:${config.port}`;
        const response = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);

        assert.equal(response.status, 200);
        const metadata = (await response.json()) as any;

        assert.deepEqual(metadata.scopes_supported, SCOPES);
        assert.deepEqual(metadata.authorization_servers, [`${base}/`]);
        const asResponse = await fetch(`${base}/.well-known/oauth-authorization-server`);

        assert.equal(asResponse.status, 200);
        const as = (await asResponse.json()) as any;

        assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
        assert.ok([undefined, true].includes(as.authorization_response_iss_parameter_supported));
        assert.equal(as.registration_endpoint, undefined);
        const unauth = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
            },
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

        assert.equal(unauth.status, 401);
        assert.match(unauth.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);
    } finally {
        await running.close();
    }
});
