import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { StateStore } from "./state.ts";

const roots: string[] = [];

after(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function store() {
    const root = await mkdtemp(join(tmpdir(), "pocket-gateway-"));

    roots.push(root);

    return {
        root,
        db: join(root, "state.json"),
        state: await StateStore.open(join(root, "state.json")),
    };
}

test("task mappings persist across restart and isolate owners", async () => {
    const { db, state } = await store();
    const task = {
        id: "task-a",
        owner: "owner-a",
        idempotencyKey: "1234567890abcdef",
        conversationId: 42,
        requestId: "req-1",
        repositoryPath: "/tmp/repo",
        prompt: "",
        status: "running",
        createdAt: Date.now(),
    };

    await state.addTask(task);
    assert.equal(state.taskByIdempotency("owner-a", task.idempotencyKey)?.id, task.id);
    assert.equal(state.task(task.id, "owner-b"), undefined);
    const reopened = await StateStore.open(db);

    assert.equal(reopened.task(task.id, "owner-a")?.conversationId, 42);
    assert.equal(reopened.taskByIdempotency("owner-a", task.idempotencyKey)?.requestId, "req-1");
});

test("duplicate owner idempotency keys are rejected atomically", async () => {
    const { state } = await store();
    const task = {
        id: "task-a",
        owner: "owner-a",
        idempotencyKey: "1234567890abcdef",
        conversationId: 0,
        requestId: "req-a",
        repositoryPath: "/tmp/repo",
        prompt: "",
        status: "queued",
        createdAt: Date.now(),
    };

    await state.addTask(task);
    await assert.rejects(
        state.addTask({ ...task, id: "task-b", requestId: "req-b" }),
        /Duplicate idempotency/,
    );
    assert.equal(state.tasks("owner-a").length, 1);
});

test("rejects malformed state rather than resetting persisted mappings", async () => {
    const { db, state } = await store();

    await state.addTask({
        id: "task-a",
        owner: "owner-a",
        idempotencyKey: "1234567890abcdef",
        conversationId: 1,
        requestId: "req-a",
        repositoryPath: "/tmp/repo",
        prompt: "",
        status: "running",
        createdAt: Date.now(),
    });
    await state.flush();
    const { writeFile } = await import("node:fs/promises");

    await writeFile(db, "{ broken", { mode: 0o600 });
    await assert.rejects(StateStore.open(db), /invalid/);
});

test("writes state with private permissions and contains no cleared prompt", async () => {
    const { db, state } = await store();

    await state.addTask({
        id: "task-a",
        owner: "owner-a",
        idempotencyKey: "1234567890abcdef",
        conversationId: 1,
        requestId: "req-a",
        repositoryPath: "/tmp/repo",
        prompt: "",
        status: "running",
        createdAt: Date.now(),
    });
    const contents = await readFile(db, "utf8");

    assert.equal(contents.includes("secret prompt"), false);
});
