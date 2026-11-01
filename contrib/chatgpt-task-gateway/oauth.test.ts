import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PocketOAuthProvider, SCOPES } from "./oauth.ts";
import { StateStore } from "./state.ts";

const roots: string[] = [];

after(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "gateway-oauth-"));

    roots.push(root);
    const store = await StateStore.open(join(root, "state.json"));
    const clientSecret = "client-secret-012345678901234567890123456789";
    const oauth = new PocketOAuthProvider({
        store,
        clientId: "client",
        clientSecret,
        resource: "http://127.0.0.1:8787/mcp",
        approvalSecret: "owner-secret-012345678901234567890123",
    });

    await oauth.ready();

    return { root, store, oauth, client: store.client("client")! };
}

const callback = "https://chatgpt.com/connector_platform_oauth_redirect";

function responseCapture() {
    const result: {
        statusCode?: number;
        body?: string;
        headers: Record<string, string>;
        redirected?: string;
    } = { headers: {} };
    const res = {
        status(code: number) {
            result.statusCode = code;

            return this;
        },
        type(value: string) {
            result.headers["content-type"] = value;

            return this;
        },
        set(name: string, value: string) {
            result.headers[name.toLowerCase()] = value;

            return this;
        },
        send(value: string) {
            result.body = value;

            return this;
        },
        redirect(code: number, url: string) {
            result.statusCode = code;
            result.redirected = url;

            return this;
        },
    };

    return { res, result };
}

function requestId(body: string | undefined) {
    const value = body?.match(/name="request" value="([^"]+)"/)?.[1];

    assert.ok(value);

    return value;
}

test("full OAuth consent, authorization code, PKCE, scope, resource, refresh and revocation", async () => {
    const { store, oauth, client } = await fixture();
    const verifier = "test-verifier-012345678901234567890123456789";
    const params = {
        state: "csrf-state",
        scopes: ["task:read"],
        codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
        redirectUri: callback,
        resource: new URL("http://127.0.0.1:8787/mcp"),
    };
    const capture = responseCapture();

    await oauth.authorize(client as never, params, capture.res as never);
    const id = requestId(capture.result.body);

    assert.equal(capture.result.statusCode, 200);
    assert.match(capture.result.body ?? "", /task:read/);
    await oauth.completeConsent(
        id,
        "owner-secret-012345678901234567890123",
        true,
        "owner-a",
        "http://127.0.0.1:8787",
        capture.res as never,
    );
    assert.equal(capture.result.statusCode, 302);
    const redirected = new URL(capture.result.redirected!);

    assert.equal(redirected.searchParams.get("state"), "csrf-state");
    assert.equal(redirected.searchParams.get("iss"), "http://127.0.0.1:8787");
    const code = redirected.searchParams.get("code")!;
    const tokens = await oauth.exchangeAuthorizationCode(
        client as never,
        code,
        verifier,
        callback,
        params.resource,
    );
    const auth = await oauth.verifyAccessToken(tokens.access_token);

    assert.equal(auth.extra?.owner, "owner-a");
    assert.deepEqual(auth.scopes, ["task:read"]);
    assert.equal(auth.resource?.href, params.resource.href);
    await assert.rejects(
        oauth.exchangeAuthorizationCode(client as never, code, verifier, callback, params.resource),
        /invalid/,
    );
    const refreshed = await oauth.exchangeRefreshToken(
        client as never,
        tokens.refresh_token!,
        ["task:read"],
        params.resource,
    );

    assert.equal((await oauth.verifyAccessToken(refreshed.access_token)).extra?.owner, "owner-a");
    await oauth.revokeToken(client as never, { token: refreshed.access_token } as never);
    await assert.rejects(oauth.verifyAccessToken(refreshed.access_token), /invalid/);
    assert.equal(SCOPES.includes("task:read" as never), true);
    assert.ok(store.client("client"));
});

test("OAuth refuses bad redirects, missing resources, denied consent, and wrong PKCE verifiers", async () => {
    const { oauth, client } = await fixture();
    const params = {
        state: "csrf",
        scopes: ["task:read"],
        codeChallenge: "challenge",
        redirectUri: "https://attacker.invalid/callback",
        resource: new URL("http://127.0.0.1:8787/mcp"),
    };

    await assert.rejects(
        oauth.authorize(client as never, params, responseCapture().res as never),
        /redirect/,
    );
    await assert.rejects(
        oauth.authorize(
            client as never,
            { ...params, redirectUri: callback, resource: undefined },
            responseCapture().res as never,
        ),
        /resource/,
    );

    for (const { secret, approve } of [
        { secret: "bad-owner-secret-01234567890123", approve: true },
        { secret: "owner-secret-012345678901234567890123", approve: false },
    ]) {
        const capture = responseCapture();

        await oauth.authorize(
            client as never,
            { ...params, redirectUri: callback },
            capture.res as never,
        );
        await oauth.completeConsent(
            requestId(capture.result.body),
            secret,
            approve,
            "owner-a",
            "http://127.0.0.1:8787",
            capture.res as never,
        );
        assert.notEqual(capture.result.statusCode, 302);
    }

    const verifier = "test-verifier-012345678901234567890123456789";
    const capture = responseCapture();

    await oauth.authorize(
        client as never,
        {
            ...params,
            redirectUri: callback,
            codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
        },
        capture.res as never,
    );
    await oauth.completeConsent(
        requestId(capture.result.body),
        "owner-secret-012345678901234567890123",
        true,
        "owner-a",
        "http://127.0.0.1:8787",
        capture.res as never,
    );
    const code = new URL(capture.result.redirected!).searchParams.get("code")!;

    await assert.rejects(
        oauth.exchangeAuthorizationCode(
            client as never,
            code,
            "incorrect-verifier-012345678901234567890123",
            callback,
            new URL("http://127.0.0.1:8787/mcp"),
        ),
        /invalid/,
    );
});
