import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { CacheTelemetryDoc } from "../src/server/cache-telemetry.ts";

after(cleanUp);

test("owner routes serve durable diagnostics and deny other roles", async () => {
    const dataDir = join(root, "cache-http");
    const extensions = join(dataDir, "extensions");

    mkdirSync(extensions, { recursive: true });
    copyFileSync(
        new URL("../docs/examples/cache-diagnostics.ts", import.meta.url),
        join(extensions, "cache-diagnostics.ts"),
    );
    copyFileSync(
        new URL("../docs/examples/cache-diagnostics.js", import.meta.url),
        join(extensions, "cache-diagnostics.js"),
    );
    symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(extensions, "node_modules"));
    let app = await openApp(scriptedModel(), dataDir);

    await app.setExtensionEnabled(owner(app), "cache-diagnostics.ts", true);
    const id = await newSession(app);
    const guest = app.config.addUser("Guest", "guest").token;
    const ownerToken = app.config.ownerToken;

    await say(app, id, "Private content should not enter telemetry");
    await until(
        async () =>
            ((await app.harness.snapshot(CacheTelemetryDoc, id, context))?.observations.length ??
                0) > 0,
        "telemetry",
    );
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    async function call(token: string, path: string, post = false) {
        return fetch(`${base}/api/x/cache-diagnostics/${path}/${id}`, {
            method: post ? "POST" : "GET",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                ...(post ? { "content-type": "application/json" } : {}),
            },
            ...(post ? { body: "{}" } : {}),
        });
    }

    try {
        assert.equal((await call(guest, "usage")).status, 404);
        assert.equal((await call(guest, "sample", true)).status, 404);
        assert.equal((await call(ownerToken, "sample", true)).status, 200);
        const response = await call(ownerToken, "usage");

        assert.equal(response.status, 200);
        const data = (await response.json()) as { observations: unknown[]; samples: unknown[] };

        assert.ok(data.observations.length > 0);
        assert.equal(data.samples.length, 1);
        assert.equal(JSON.stringify(data).includes("Private content"), false);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
    }

    app = await openApp(scriptedModel(), dataDir);

    try {
        const observations = await app.harness.snapshot(CacheTelemetryDoc, id, context);

        assert.ok((observations?.observations.length ?? 0) > 0);
    } finally {
        await app.close();
    }
});
