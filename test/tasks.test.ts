import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { type App, cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import { createHandler } from "../src/server/http.ts";
import { ConfigStore } from "../src/server/config.ts";
import { BUILT_IN_MODULES } from "../src/server/reload.ts";

let app: App;
let server: Server;
let base = "";
const data = mkdtempSync(join(root, "task-data-"));
const cookie = () => `pocket_auth=${encodeURIComponent(app.config.ownerToken)}`;
const request = (path: string, method = "GET", body?: unknown) =>
    fetch(`${base}${path}`, {
        method,
        headers: {
            "X-Pocket": "1",
            Cookie: cookie(),
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

test("task CRUD persists, links sessions, and requires owner access", async () => {
    // Use the real built-in routes and document, with a fresh test data folder.
    app = await openApp(scriptedModel(), data);
    const extInfo = app.loader.list().find((each) => each.file === "board.ts");

    assert.ok(extInfo, "Board task manager module is registered");
    await app.setExtensionEnabled(owner(app), "board.ts", true);
    const session = await newSession(app);

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const denied = await fetch(`${base}/api/x/board/tasks`, { headers: { "X-Pocket": "1" } });

    assert.equal(denied.status, 401);
    const created = await request("/api/x/board/tasks", "POST", {
        title: "Test task",
        goal: "Verify task persistence",
    });

    assert.equal(created.status, 200);
    const id = (await created.json()).task.id;

    assert.equal((await (await request("/api/x/board/tasks")).json()).tasks[0].title, "Test task");
    await request(`/api/x/board/tasks/${id}`, "PATCH", { title: "Edited", status: "review" });
    assert.equal((await (await request("/api/x/board/tasks")).json()).tasks[0].status, "review");
    const linked = await request(`/api/x/board/c/${session}/tasks/${id}/link`, "POST", {});

    assert.equal(linked.status, 200);
    assert.equal(
        (await (await request("/api/x/board/tasks")).json()).tasks[0].claim.conversationId,
        session,
    );
    const bad = await request(`/api/x/board/tasks/${id}`, "PATCH", { status: "invalid" });

    assert.equal(bad.status, 400);
});

test("Board is a built-in task-manager registration and legacy Board disable is retained", () => {
    assert.equal(BUILT_IN_MODULES.has("board"), true);
    const directory = mkdtempSync(join(root, "config-test-"));
    const config = new ConfigStore(directory);

    config.setExtensionEnabled("board.ts", false);
    assert.equal(config.extensionChoice("board.ts"), false);
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});
