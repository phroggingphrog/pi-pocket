import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import register, { readWorkspaceFile } from "./conversation-annotations.ts";

const withWorkspace = async (run: (root: string, outside: string) => Promise<void>) => {
    const temp = await mkdtemp(join(tmpdir(), "annotations-"));

    try {
        const root = join(temp, "workspace");
        const outside = join(temp, "outside");

        await mkdir(root);
        await mkdir(outside);
        await run(root, outside);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
};

test("reads text inside workspace and rejects traversal and symlink escape", async () => {
    await withWorkspace(async (root, outside) => {
        await writeFile(join(root, "note.txt"), "inside\n😀");
        await writeFile(join(outside, "secret.txt"), "outside");
        await symlink(join(outside, "secret.txt"), join(root, "escape"));
        await symlink(join(outside), join(root, "escape-dir"));
        assert.equal(await readWorkspaceFile(root, "note.txt", []), "inside\n😀");
        await assert.rejects(readWorkspaceFile(root, "../outside/secret.txt", []));
        await assert.rejects(readWorkspaceFile(root, join(outside, "secret.txt"), []));
        await assert.rejects(readWorkspaceFile(root, "escape", []));
        await assert.rejects(readWorkspaceFile(root, "escape-dir/secret.txt", []));
    });
});

test("rejects directories, binary data, invalid UTF-8, and oversized files", async () => {
    await withWorkspace(async (root) => {
        await writeFile(join(root, "binary"), Buffer.from([1, 0, 2]));
        await writeFile(join(root, "invalid"), Buffer.from([0xff]));
        await writeFile(join(root, "large"), Buffer.alloc(1024 * 1024 + 1, 97));

        for (const path of [".", "binary", "invalid", "large", "missing"]) {
            await assert.rejects(readWorkspaceFile(root, path, []));
        }
    });
});

test("blocks custom Pocket data and agent directories inside the workspace", async () => {
    await withWorkspace(async (root) => {
        const dataDir = join(root, "custom-data");
        const agentDir = join(root, "custom-agent");

        await mkdir(dataDir);
        await mkdir(agentDir);
        await writeFile(join(dataDir, "config.json"), "private");
        await writeFile(join(agentDir, "auth.json"), "private");
        await symlink(dataDir, join(root, "alias"));
        const protectedRoots = [dataDir, agentDir];

        await assert.rejects(readWorkspaceFile(root, "custom-data/config.json", protectedRoots));
        await assert.rejects(readWorkspaceFile(root, "custom-agent/auth.json", protectedRoots));
        await assert.rejects(readWorkspaceFile(root, "alias/config.json", protectedRoots));
    });
});

test("registers a session-bound steer-only file route and client", async () => {
    await withWorkspace(async (root) => {
        await writeFile(join(root, "note.txt"), "snapshot");
        const calls: any[] = [];
        const web = {
            conversationRoute: (...args: any[]) => calls.push(args),
            client: (...args: any[]) => calls.push(args),
            error: (status: number, message: string) =>
                Object.assign(new Error(message), { status }),
        };

        register({ dataDir: join(root, "data"), agentDir: join(root, "agent") }, web);
        assert.equal(calls[0][0], "GET");
        assert.deepEqual(calls[0][3], { conversation: "conversation", access: "steer" });
        assert.deepEqual(calls[1], ["conversation-annotations", { access: "steer" }]);
        const request = {
            conversation: { cwd: root },
            query: new URLSearchParams({ path: "note.txt" }),
        };

        assert.deepEqual(await calls[0][2](request), { path: "note.txt", text: "snapshot" });
        await assert.rejects(
            calls[0][2]({ ...request, query: new URLSearchParams({ path: "../secret" }) }),
            { status: 404 },
        );
        await assert.rejects(calls[0][2]({ ...request, query: new URLSearchParams() }), {
            status: 400,
        });
    });
});
