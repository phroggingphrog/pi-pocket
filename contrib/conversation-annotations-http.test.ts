import { cleanUp, newSession, openApp, owner, root, scriptedModel } from "../test/helpers.ts";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
let conversation: number;
let other: number;
const tokens: Record<string, string> = {};

before(async () => {
    const data = join(root, "data");
    const dropIns = join(data, "extensions");
    const cwd = join(root, "workspace");

    mkdirSync(dropIns, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    cpSync(
        new URL("./conversation-annotations.ts", import.meta.url),
        join(dropIns, "conversation-annotations.ts"),
    );
    cpSync(
        new URL("./conversation-annotations", import.meta.url),
        join(dropIns, "conversation-annotations"),
        { recursive: true },
    );
    writeFileSync(join(cwd, "note.txt"), "safe snapshot");
    writeFileSync(join(root, "secret.txt"), "secret");
    symlinkSync(join(root, "secret.txt"), join(cwd, "escape"));
    app = await openApp(scriptedModel(), data);
    conversation = Number(await newSession(app, cwd));
    other = Number(await newSession(app, cwd));
    tokens.owner = app.config.ownerToken;
    tokens.guest = app.config.addUser("Guest", "guest").token;
    tokens.viewer = app.config.addUser("Viewer", "viewer").token;
    tokens.invited = app.config.addUser("Invited", "guest", [String(conversation)]).token;
    await app.setExtensionEnabled(owner(app), "conversation-annotations.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

function call(who: string | null, id: number, path: string, header = true) {
    return fetch(
        `${base}/api/x/conversation-annotations/files/${id}?path=${encodeURIComponent(path)}`,
        {
            headers: {
                ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}),
                ...(header ? { "x-pocket": "1" } : {}),
            },
        },
    );
}

test("HTTP route requires sign-in, extension access, and the session-bound route", async () => {
    const ok = await call("owner", conversation, "note.txt");

    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { path: "note.txt", text: "safe snapshot" });
    assert.equal((await call("guest", conversation, "note.txt")).status, 200);
    assert.notEqual((await call(null, conversation, "note.txt")).status, 200);
    assert.notEqual((await call("owner", conversation, "note.txt", false)).status, 200);
    assert.equal((await call("viewer", conversation, "note.txt")).status, 404);
    assert.equal((await call("invited", conversation, "note.txt")).status, 404);
    assert.equal((await call("invited", other, "note.txt")).status, 404);
    assert.equal((await call("owner", 99999999, "note.txt")).status, 404);
    assert.equal((await call("owner", conversation, "escape")).status, 404);
    assert.equal((await call("owner", conversation, "../secret.txt")).status, 404);
});
