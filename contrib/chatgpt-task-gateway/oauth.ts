import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
    OAuthClientInformationFull,
    OAuthTokenRevocationRequest,
    OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";
import type { StateStore } from "./state.ts";

export const SCOPES = ["task:submit", "task:read", "task:cancel"] as const;
const ACCESS_TTL = 900;
const REFRESH_TTL = 2_592_000;
const token = () => randomBytes(32).toString("base64url");
const challenge = (value: string) => createHash("sha256").update(value).digest("base64url");

export type ConsentRequest = {
    client: OAuthClientInformationFull;
    params: {
        state?: string;
        scopes?: string[];
        codeChallenge: string;
        redirectUri: string;
        resource?: URL;
    };
};
type StoredAuthorization = ConsentRequest & { owner: string; code: string; expiresAt: number };

export class PocketOAuthProvider implements OAuthServerProvider {
    readonly #store: StateStore;
    readonly #clientId: string;
    readonly #clientSecret: string;
    readonly #resource: string;
    readonly #approvalSecret: string;
    readonly #pending = new Map<string, StoredAuthorization>();
    readonly #clients: OAuthRegisteredClientsStore;
    constructor(options: {
        store: StateStore;
        clientId: string;
        clientSecret: string;
        resource: string;
        approvalSecret: string;
    }) {
        this.#store = options.store;
        this.#clientId = options.clientId;
        this.#clientSecret = options.clientSecret;
        this.#resource = options.resource;
        this.#approvalSecret = options.approvalSecret;
        this.#clients = {
            getClient: async (id) =>
                this.#store.client(id) as OAuthClientInformationFull | undefined,
        };
    }
    get clientsStore(): OAuthRegisteredClientsStore {
        return this.#clients;
    }
    async ready(): Promise<void> {
        const existing = this.#store.client(this.#clientId);

        if (existing && !timingSafeText(existing.client_secret ?? "", this.#clientSecret)) {
            throw new Error("Configured OAuth client credentials do not match saved credentials.");
        }

        if (!existing) {
            await this.#store.addClient({
                client_id: this.#clientId,
                client_secret: this.#clientSecret,
                client_secret_expires_at: 0,
                redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "client_secret_post",
                scope: SCOPES.join(" "),
            });
        }
    }
    client(id: string) {
        return this.#store.client(id) as OAuthClientInformationFull | undefined;
    }
    async authorize(
        client: OAuthClientInformationFull,
        params: ConsentRequest["params"],
        res: Response,
    ): Promise<void> {
        const registered = this.#store.client(client.client_id);

        if (
            !registered ||
            !registered.redirect_uris.includes(params.redirectUri) ||
            new URL(params.redirectUri).protocol !== "https:"
        ) {
            throw new Error("OAuth client or redirect URI is not allowed.");
        }

        if (params.resource?.href !== this.#resource) {
            throw new Error("The OAuth resource does not match this gateway.");
        }

        const scopes = [...new Set(params.scopes ?? [])];

        if (
            !scopes.length ||
            scopes.some((scope) => !SCOPES.includes(scope as (typeof SCOPES)[number]))
        ) {
            throw new Error("Requested scopes are not allowed.");
        }

        const requestId = token();

        this.#pending.set(requestId, {
            client,
            params: { ...params, scopes },
            owner: "",
            code: token(),
            expiresAt: Date.now() + 5 * 60_000,
        });
        const path = new URL("/consent", this.#resource).pathname;
        const escape = (value: string) =>
            value.replace(
                /[&<>"']/g,
                (char) =>
                    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
                        char
                    ]!,
            );

        res.status(200)
            .type("html")
            .set("cache-control", "no-store")
            .send(
                `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Pi Pocket</title><h1>Authorize ChatGPT</h1><p>Approve scopes: ${escape(scopes.join(", "))}</p><form method="post" action="${path}"><input type="hidden" name="request" value="${escape(requestId)}"><label>Owner approval secret <input name="secret" type="password" autocomplete="current-password" required></label><button name="approve" value="yes">Approve</button><button name="approve" value="no">Deny</button></form>`,
            );
    }
    async completeConsent(
        id: string,
        secret: string,
        approved: boolean,
        owner: string,
        issuer: string,
        res: Response,
    ): Promise<void> {
        const auth = this.#pending.get(id);

        this.#pending.delete(id);

        if (
            !auth ||
            auth.expiresAt < Date.now() ||
            !approved ||
            !timingSafeText(secret, this.#approvalSecret) ||
            !owner
        ) {
            res.status(403).type("text").send("Authorization denied.");

            return;
        }

        const resource = auth.params.resource?.href;

        if (!resource || resource !== this.#resource) {
            res.status(400).type("text").send("Invalid resource.");

            return;
        }

        await this.#store.putCode(auth.code, {
            clientId: auth.client.client_id,
            redirectUri: auth.params.redirectUri,
            challenge: auth.params.codeChallenge,
            scopes: auth.params.scopes ?? [],
            resource,
            owner,
            expiresAt: auth.expiresAt,
        });
        const redirect = new URL(auth.params.redirectUri);

        redirect.searchParams.set("code", auth.code);

        if (auth.params.state) {
            redirect.searchParams.set("state", auth.params.state);
        }

        redirect.searchParams.set("iss", issuer);
        res.redirect(302, redirect.href);
    }
    async challengeForAuthorizationCode(
        client: OAuthClientInformationFull,
        code: string,
    ): Promise<string> {
        const value = this.#store.code(code);

        if (!value || value.clientId !== client.client_id || value.expiresAt < Date.now()) {
            throw new Error("Authorization code is invalid.");
        }

        return value.challenge;
    }
    async exchangeAuthorizationCode(
        client: OAuthClientInformationFull,
        code: string,
        verifier?: string,
        redirectUri?: string,
        resource?: URL,
    ): Promise<OAuthTokens> {
        const data = await this.#store.takeCode(code);

        if (
            !data ||
            data.clientId !== client.client_id ||
            data.expiresAt < Date.now() ||
            data.redirectUri !== redirectUri ||
            data.resource !== resource?.href ||
            !verifier ||
            !timingSafeText(challenge(verifier), data.challenge)
        ) {
            throw new Error("Authorization code is invalid.");
        }

        return this.#issue(client.client_id, data.owner, data.scopes, data.resource);
    }
    async exchangeRefreshToken(
        client: OAuthClientInformationFull,
        refresh: string,
        scopes?: string[],
        resource?: URL,
    ): Promise<OAuthTokens> {
        const data = this.#store.token(refresh);

        if (
            !data ||
            data.clientId !== client.client_id ||
            data.expiresAt < Date.now() ||
            data.resource !== resource?.href ||
            scopes?.some((scope) => !data.scopes.includes(scope))
        ) {
            throw new Error("Refresh token is invalid.");
        }

        await this.#store.revoke(refresh);

        return this.#issue(
            client.client_id,
            data.owner,
            scopes?.length ? scopes : data.scopes,
            data.resource,
        );
    }
    async verifyAccessToken(access: string): Promise<AuthInfo> {
        const data = this.#store.token(access);

        if (!data || data.expiresAt < Date.now() || data.resource !== this.#resource) {
            throw new Error("Access token is invalid.");
        }

        return {
            token: access,
            clientId: data.clientId,
            scopes: data.scopes,
            expiresAt: Math.floor(data.expiresAt / 1000),
            resource: new URL(data.resource),
            extra: { owner: data.owner },
        };
    }
    async revokeToken(
        _client: OAuthClientInformationFull,
        request: OAuthTokenRevocationRequest,
    ): Promise<void> {
        await this.#store.revoke(request.token);
    }
    #issue(
        clientId: string,
        owner: string,
        scopes: string[],
        resource: string,
    ): Promise<OAuthTokens> {
        const access = token();
        const refresh = token();
        const now = Date.now();

        return Promise.all([
            this.#store.putToken(access, {
                clientId,
                owner,
                scopes,
                resource,
                expiresAt: now + ACCESS_TTL * 1000,
            }),
            this.#store.putToken(refresh, {
                clientId,
                owner,
                scopes,
                resource,
                expiresAt: now + REFRESH_TTL * 1000,
            }),
        ]).then(() => ({
            access_token: access,
            token_type: "bearer",
            expires_in: ACCESS_TTL,
            refresh_token: refresh,
            scope: scopes.join(" "),
        }));
    }
}

function timingSafeText(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);

    return a.length === b.length && timingSafeEqual(a, b);
}
