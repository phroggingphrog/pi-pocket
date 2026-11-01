import { realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { PocketHost } from "../../src/server/host.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { HttpError } from "../../src/server/errors.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";

type StoredTask = {
    id: string;
    owner: string;
    idempotencyKey: string;
    conversationId: number;
    requestId: string;
    repositoryPath: string;
    status: string;
    createdAt: number;
};
type TaskStore = { tasks: StoredTask[] };
export const ChatGPTTasksDoc = defineDoc<TaskStore>({
    kind: "x.chatgpt-task-gateway.tasks",
    version: 1,
    scope: "session",
    checkpointWhen: () => false,
    initial: () => ({ tasks: [] }),
});
const context = BACKGROUND_CONTEXT;

export function createTaskAdapter(host: PocketHost) {
    const find = async (id: string, owner: string) =>
        (await host.harness.snapshot(ChatGPTTasksDoc, context))?.tasks.find(
            (task) => task.id === id && task.owner === owner,
        );

    return {
        async submit(
            owner: string,
            root: string,
            relativePath: string,
            prompt: string,
            key: string,
        ) {
            if (host.roleOf(owner) !== "owner") {
                throw new HttpError(403, "Only the owner can submit tasks.");
            }

            if (
                !/^[A-Za-z0-9._:-]{16,128}$/.test(key) ||
                prompt.length < 1 ||
                prompt.length > 20_000
            ) {
                throw new HttpError(400, "Invalid prompt or idempotency key.");
            }

            const prior = (await host.harness.snapshot(ChatGPTTasksDoc, context))?.tasks.find(
                (task) => task.owner === owner && task.idempotencyKey === key,
            );

            if (prior) {
                return {
                    id: prior.id,
                    conversationId: prior.conversationId,
                    status: prior.status,
                    duplicate: true,
                };
            }

            const canonicalRoot = await realpath(root);
            const candidate = resolve(canonicalRoot, relativePath);
            const rel = relative(canonicalRoot, candidate);

            if (rel === ".." || rel.startsWith(`..${sep}`) || candidate === canonicalRoot) {
                throw new HttpError(
                    400,
                    "Repository path must name a child directory under the workspace root.",
                );
            }

            const cwd = await realpath(candidate);
            const inside = relative(canonicalRoot, cwd);

            if (
                inside === ".." ||
                inside.startsWith(`..${sep}`) ||
                !(await stat(cwd)).isDirectory()
            ) {
                throw new HttpError(
                    400,
                    "Repository path must be a real directory under the workspace root.",
                );
            }

            const user = { id: owner, name: "Owner", role: "owner" as const };
            const id = `g-${key}`;
            const requestId = `chatgpt-${key}`;
            const created = await host.commands.createSession(user, {
                cwd,
                title: `ChatGPT task ${key.slice(0, 12)}`,
            });
            const row: StoredTask = {
                id,
                owner,
                idempotencyKey: key,
                conversationId: Number(created.id),
                requestId,
                repositoryPath: cwd,
                status: "submitting",
                createdAt: Date.now(),
            };

            await host.harness.commit(async (tx) => {
                const doc = await tx.doc(ChatGPTTasksDoc);
                const same = doc.tasks.find(
                    (task) => task.owner === owner && task.idempotencyKey === key,
                );

                if (!same) {
                    doc.tasks.push(row);
                }
            }, context);
            await host.commands.submit(created.id, user, {
                text: prompt,
                requestId,
                mode: "followUp",
            });
            await host.harness.commit(async (tx) => {
                const doc = await tx.doc(ChatGPTTasksDoc);
                const task = doc.tasks.find((item) => item.id === id && item.owner === owner);

                if (task) {
                    task.status = "running";
                }
            }, context);

            return { id, conversationId: Number(created.id), status: "running", duplicate: false };
        },
        async get(id: string, owner: string) {
            if (host.roleOf(owner) !== "owner") {
                throw new HttpError(403, "Only the owner can read tasks.");
            }

            const task = await find(id, owner);

            if (!task) {
                return undefined;
            }

            const session = host.sessionCatalogue()[String(task.conversationId)];

            if (!session || session.createdBy !== owner) {
                return undefined;
            }

            const status = host.isBusy(task.conversationId as ConversationId)
                ? "running"
                : task.status === "cancelled"
                  ? "cancelled"
                  : "idle";

            if (task.status !== status) {
                await host.harness.commit(async (tx) => {
                    const doc = await tx.doc(ChatGPTTasksDoc);
                    const item = doc.tasks.find(
                        (entry) => entry.id === id && entry.owner === owner,
                    );

                    if (item) {
                        item.status = status;
                    }
                }, context);
            }

            return { taskId: id, status, updatedAt: session.updatedAt };
        },
        async cancel(id: string, owner: string) {
            const task = await find(id, owner);

            if (!task || !(await this.get(id, owner))) {
                return false;
            }

            await host.commands.abort(task.conversationId as ConversationId, {
                id: owner,
                name: "Owner",
                role: "owner",
            });
            await host.harness.commit(async (tx) => {
                const doc = await tx.doc(ChatGPTTasksDoc);
                const item = doc.tasks.find((entry) => entry.id === id && entry.owner === owner);

                if (item) {
                    item.status = "cancelled";
                }
            }, context);

            return true;
        },
        async results(id: string, owner: string, cursor: string | undefined, limit: number) {
            const task = await find(id, owner);

            if (!task || !(await this.get(id, owner))) {
                return undefined;
            }

            let scanCursor: any;

            if (cursor) {
                try {
                    scanCursor = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
                } catch {
                    throw new HttpError(400, "Invalid result cursor.");
                }
            }

            const conversation = await host.conversation(task.conversationId as ConversationId);
            const page = await conversation.entries(
                { order: "ascending" },
                Math.min(Math.max(1, limit), 100),
                scanCursor,
                context,
            );
            const entries = page.items.map((entry) => ({
                id: Number(entry.id),
                kind: entry.kind,
                text:
                    entry.model
                        ?.map((message) => message.content)
                        .flat()
                        .filter((part: any) => part?.type === "text")
                        .map((part: any) => part.text)
                        .join("\n") ?? "",
            }));

            return {
                entries,
                nextCursor: page.next
                    ? Buffer.from(JSON.stringify(page.next)).toString("base64url")
                    : null,
                hasMore: Boolean(page.next),
            };
        },
    };
}
