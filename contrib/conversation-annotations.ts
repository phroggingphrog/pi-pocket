/** Annotate text from a conversation's workspace and messages. */
import { constants } from "node:fs";
import { open, realpath, stat, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_FILE = 1024 * 1024;

function inside(root: string, file: string): boolean {
    const part = relative(root, file);

    return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

/** Read a bounded regular file under the session folder, including after a symlink swap. */
export async function readWorkspaceFile(
    cwd: string,
    path: string,
    privateRoots: readonly string[],
): Promise<string> {
    if (typeof path !== "string" || !path.trim() || path.includes("\0")) {
        throw new Error("Invalid path");
    }

    const root = await realpath(cwd);
    const target = await realpath(resolve(root, path));
    const protectedPaths = await Promise.all(
        privateRoots.map(async (dir) => realpath(dir).catch(() => resolve(dir))),
    );

    if (!inside(root, target) || protectedPaths.some((dir) => inside(dir, target))) {
        throw new Error("Not found");
    }

    const expected = await stat(target);
    const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );

    try {
        const actual = await handle.stat();

        if (
            !actual.isFile() ||
            actual.dev !== expected.dev ||
            actual.ino !== expected.ino ||
            actual.size > MAX_FILE
        ) {
            throw new Error("Not found or file too large");
        }

        // On Linux, also reject a parent-directory swap that changed the opened path.
        const openedPath = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);

        if (openedPath !== null && openedPath !== target) {
            throw new Error("Not found");
        }

        const bytes = Buffer.alloc(MAX_FILE + 1);
        let length = 0;

        while (length < bytes.length) {
            const result = await handle.read(bytes, length, bytes.length - length, length);

            if (!result.bytesRead) {
                break;
            }

            length += result.bytesRead;
        }

        if (length > MAX_FILE || bytes.subarray(0, length).includes(0)) {
            throw new Error("File is too large or not text");
        }

        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } finally {
        await handle.close();
    }
}

export default function annotations(host: { dataDir: string; agentDir: string }, web: any) {
    if (typeof web.conversationRoute !== "function") {
        throw new Error("Conversation routes are required");
    }

    web.conversationRoute(
        "GET",
        "files/:conversation",
        async (request: any) => {
            const path = request.query.get("path");

            if (!path || path.length > 4096) {
                throw web.error(400, "A file path is required");
            }

            try {
                return {
                    path,
                    text: await readWorkspaceFile(request.conversation.cwd, path, [
                        host.dataDir,
                        host.agentDir,
                    ]),
                };
            } catch {
                throw web.error(404, "File not found, not text, or too large");
            }
        },
        { conversation: "conversation", access: "steer" },
    );
    web.client("conversation-annotations", { access: "steer" });
}
