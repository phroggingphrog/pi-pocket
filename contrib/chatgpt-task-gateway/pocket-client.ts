import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import type { PocketApp } from "../../src/server/app.ts";
import type { User } from "../../src/server/config.ts";
import type { GatewayTask } from "./state.ts";

type PersistentTasks = { tasks: GatewayTask[] };
const PersistentTasksDoc = defineDoc<PersistentTasks>({
    kind: "x.chatgpt-task-gateway.tasks",
    version: 1,
    scope: "session",
    checkpointWhen: () => false,
    initial: () => ({ tasks: [] }),
});
const context = BACKGROUND_CONTEXT;

export class PocketClient {
    readonly #app: PocketApp;
    readonly #root: string;
    constructor(app: PocketApp, root: string) {
        this.#app = app;
        this.#root = root;
    }
    #owner(id: string): User {
        const owner = this.#app.config.userById(id);

        if (!owner || owner.role !== "owner") {
            throw new Error("Owner authorization failed.");
        }

        return owner;
    }
    async #lookup(id: string, owner: string): Promise<GatewayTask | undefined> {
        const document = await this.#app.harness.snapshot(PersistentTasksDoc, context);

        return document?.tasks.find((item) => item.id === id && item.owner === owner);
    }
    async #commit(update: (tasks: GatewayTask[]) => void) {
        await this.#app.harness.commit(
            async (tx) => update((await tx.doc(PersistentTasksDoc)).tasks),
            context,
        );
    }
    async submit(owner: string, cwd: string, prompt: string, key: string): Promise<GatewayTask> {
        const user = this.#owner(owner);
        const known = (await this.#app.harness.snapshot(PersistentTasksDoc, context))?.tasks.find(
            (item) => item.owner === owner && item.idempotencyKey === key,
        );

        if (known) {
            return known;
        }

        const canonical = this.#app.workspace.checkDirectory(cwd);
        const id = `g-${randomUUID()}`;
        const requestId = `chatgpt-${key}`;
        const row: GatewayTask = {
            id,
            owner,
            idempotencyKey: key,
            conversationId: 0,
            requestId,
            repositoryPath: canonical,
            prompt,
            status: "creating",
            createdAt: Date.now(),
        };

        await this.#commit((tasks) => {
            if (!tasks.some((item) => item.owner === owner && item.idempotencyKey === key)) {
                tasks.push(row);
            }
        });
        const created = await this.#app.commands.createSession(user, {
            cwd: canonical,
            title: `ChatGPT task ${id}`,
        });

        await this.#commit((tasks) => {
            const task = tasks.find((item) => item.id === id && item.owner === owner);

            if (task) {
                task.conversationId = Number(created.id);
                task.status = "submitting";
            }
        });
        const submission = await this.#app.commands.submit(created.id, user, {
            text: prompt,
            requestId,
            mode: "followUp",
        });

        await this.#commit((tasks) => {
            const task = tasks.find((item) => item.id === id && item.owner === owner);

            if (task) {
                task.status = "running";
                task.prompt = "";
                task.submissionId = Number(submission.submissionId);
            }
        });

        return {
            ...row,
            conversationId: Number(created.id),
            status: "running",
            prompt: "",
            submissionId: Number(submission.submissionId),
        };
    }
    async get(id: string, owner: string): Promise<GatewayTask | undefined> {
        this.#owner(owner);
        const task = await this.#lookup(id, owner);

        if (!task) {
            return undefined;
        }

        const session = this.#app.sessionMeta(task.conversationId as ConversationId);

        if (!session || session.createdBy !== owner) {
            return undefined;
        }

        const status = this.#app.isBusy(task.conversationId as ConversationId)
            ? "running"
            : task.status === "cancelled"
              ? "cancelled"
              : "idle";

        if (status !== task.status) {
            await this.#commit((tasks) => {
                const current = tasks.find((item) => item.id === id && item.owner === owner);

                if (current) {
                    current.status = status;
                }
            });
        }

        return { ...task, status };
    }
    async cancel(id: string, owner: string): Promise<boolean> {
        const task = await this.get(id, owner);

        if (!task) {
            return false;
        }

        if (task.status !== "idle" && task.status !== "cancelled") {
            await this.#app.commands.abort(
                task.conversationId as ConversationId,
                this.#owner(owner),
            );
        }

        await this.#commit((tasks) => {
            const current = tasks.find((item) => item.id === id && item.owner === owner);

            if (current) {
                current.status = "cancelled";
            }
        });

        return true;
    }
    async results(id: string, owner: string, cursor: string | undefined, limit: number) {
        const task = await this.get(id, owner);

        if (!task) {
            return undefined;
        }

        let scan: import("@earendil-works/pi-durable").Cursor | undefined;

        if (cursor) {
            try {
                scan = JSON.parse(
                    Buffer.from(cursor, "base64url").toString(),
                ) as import("@earendil-works/pi-durable").Cursor;
            } catch {
                throw new Error("Invalid result cursor.");
            }
        }

        const conversation = await this.#app.conversation(task.conversationId as ConversationId);
        const page = await conversation.entries(
            { order: "ascending" },
            Math.min(Math.max(limit, 1), 100),
            scan,
            context,
        );
        const entries = page.items.map((entry) => ({
            id: Number(entry.id),
            kind: entry.kind,
            text:
                entry.model
                    ?.flatMap((message) =>
                        typeof message.content === "string"
                            ? [message.content]
                            : Array.isArray(message.content)
                              ? message.content
                                    .filter(
                                        (part) =>
                                            typeof part === "object" &&
                                            part !== null &&
                                            "type" in part &&
                                            part.type === "text" &&
                                            "text" in part,
                                    )
                                    .map((part) => String((part as { text: unknown }).text))
                              : [],
                    )
                    .join("\n") ?? "",
        }));

        return {
            entries,
            nextCursor: page.next
                ? Buffer.from(JSON.stringify(page.next)).toString("base64url")
                : null,
            hasMore: Boolean(page.next),
        };
    }
}
