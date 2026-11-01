/** Pi Pocket's durable task manager. It replaces the legacy Board module without changing its stored task document. */
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { ExtensionWeb, PocketHost } from "../host.ts";

const STATUSES = ["open", "working", "review", "done"] as const;

type Status = (typeof STATUSES)[number];
type Claim = { conversationId: number; by: string; at: number } | null;
type Task = {
    id: string;
    title: string;
    goal: string;
    acceptance: string[];
    status: Status;
    claim: Claim;
    note: string;
    createdAt: number;
    updatedAt: number;
};
type TaskStore = { tasks: Task[]; next: number };

// Preserve the Board document kind and schema. Existing tasks remain readable after this module replaces Board.
export const TasksDoc = defineDoc<TaskStore>({
    kind: "x.phrog-board.tasks",
    version: 1,
    scope: "session",
    checkpointWhen: () => false,
    initial: () => ({ tasks: [], next: 1 }),
});

const ABANDONED_MS = 6 * 60 * 60 * 1000;
const validStatus = (value: unknown): value is Status =>
    typeof value === "string" && STATUSES.includes(value as Status);

function age(task: Task): "live" | "abandoned" | "none" {
    if (task.status !== "working" || task.claim === null) {
        return "none";
    }

    return Date.now() - task.claim.at > ABANDONED_MS ? "abandoned" : "live";
}

function heldBy(task: Task): string {
    if (task.claim === null) {
        return "nobody";
    }

    return `${task.claim.by}${age(task) === "abandoned" ? ", abandoned" : ""}`;
}

function cleanText(value: unknown, name: string, max: number): string {
    if (typeof value !== "string") {
        throw new Error(`${name} must be text.`);
    }

    const text = value.trim();

    if (text.length === 0 || text.length > max) {
        throw new Error(`${name} must contain 1 to ${max} characters.`);
    }

    return text;
}

function find(store: TaskStore, id: string): Task {
    const task = store.tasks.find((each) => each.id === id.trim().toUpperCase());

    if (task === undefined) {
        throw new Error(`No task has id ${id.trim().toUpperCase()}.`);
    }

    return task;
}

export const TasksGuide = section(
    "pocket-tasks-guide",
    () =>
        "Use task_list to view tasks. Use task_add to create one, task_edit to change its details, and task_status to change its status. The task manager stores data in Pi Pocket.",
);

export function makeTaskTools() {
    const list = defineTool({
        name: "task_list",
        description: "List Pi Pocket tasks and their status.",
        parameters: Type.Object({ status: Type.Optional(Type.String()) }),
        replay: "safe",
        execute: async (args, api, context) => {
            const tasks = (await api.snapshot(TasksDoc, context))?.tasks ?? [];
            const filtered =
                args.status === undefined
                    ? tasks
                    : tasks.filter((task) => task.status === args.status);

            return {
                output: [
                    {
                        type: "text" as const,
                        text: filtered.length
                            ? filtered
                                  .map((t) => `${t.id} [${t.status}] ${t.title} · ${heldBy(t)}`)
                                  .join("\n")
                            : "No tasks match.",
                    },
                ],
            };
        },
    });
    const add = defineTool({
        name: "task_add",
        description: "Create a task in Pi Pocket.",
        parameters: Type.Object({
            title: Type.String(),
            goal: Type.String(),
            acceptance: Type.Optional(Type.Array(Type.String())),
        }),
        replay: "unsafe",
        execute: async (args, api, context) => {
            let task!: Task;

            await api.commit(async (tx) => {
                const store = await tx.doc(TasksDoc);
                const now = Date.now();

                task = {
                    id: `TASK-${store.next}`,
                    title: cleanText(args.title, "Title", 200),
                    goal: cleanText(args.goal, "Goal", 4000),
                    acceptance: (args.acceptance ?? []).map((x) =>
                        cleanText(x, "Acceptance criterion", 500),
                    ),
                    status: "open",
                    claim: null,
                    note: "",
                    createdAt: now,
                    updatedAt: now,
                };
                store.tasks = [...store.tasks, task];
                store.next += 1;
            }, context);

            return {
                output: [{ type: "text" as const, text: `Created ${task.id}: ${task.title}.` }],
            };
        },
    });
    const edit = defineTool({
        name: "task_edit",
        description: "Edit a task title, goal, acceptance criteria, or note.",
        parameters: Type.Object({
            id: Type.String(),
            title: Type.Optional(Type.String()),
            goal: Type.Optional(Type.String()),
            acceptance: Type.Optional(Type.Array(Type.String())),
            note: Type.Optional(Type.String()),
        }),
        replay: "unsafe",
        execute: async (args, api, context) => {
            await api.commit(async (tx) => {
                const store = await tx.doc(TasksDoc);
                const task = find(store, args.id);

                store.tasks = store.tasks.map((each) =>
                    each.id !== task.id
                        ? each
                        : {
                              ...each,
                              ...(args.title === undefined
                                  ? {}
                                  : { title: cleanText(args.title, "Title", 200) }),
                              ...(args.goal === undefined
                                  ? {}
                                  : { goal: cleanText(args.goal, "Goal", 4000) }),
                              ...(args.acceptance === undefined
                                  ? {}
                                  : {
                                        acceptance: args.acceptance.map((x) =>
                                            cleanText(x, "Acceptance criterion", 500),
                                        ),
                                    }),
                              ...(args.note === undefined
                                  ? {}
                                  : { note: args.note.trim().slice(0, 1000) }),
                              updatedAt: Date.now(),
                          },
                );
            }, context);

            return {
                output: [
                    { type: "text" as const, text: `Updated ${args.id.trim().toUpperCase()}.` },
                ],
            };
        },
    });
    const status = defineTool({
        name: "task_status",
        description: "Change a task status to open, working, review, or done.",
        parameters: Type.Object({
            id: Type.String(),
            status: Type.String(),
            note: Type.Optional(Type.String()),
        }),
        replay: "unsafe",
        execute: async (args, api, context) => {
            if (!validStatus(args.status)) {
                throw new Error(`Status must be one of ${STATUSES.join(", ")}.`);
            }

            await api.commit(async (tx) => {
                const store = await tx.doc(TasksDoc);
                const task = find(store, args.id);
                const claim = args.status === "working" ? task.claim : null;

                store.tasks = store.tasks.map((each) =>
                    each.id !== task.id
                        ? each
                        : {
                              ...each,
                              status: args.status as Status,
                              claim,
                              note:
                                  args.note === undefined
                                      ? each.note
                                      : args.note.trim().slice(0, 1000),
                              updatedAt: Date.now(),
                          },
                );
            }, context);

            return {
                output: [
                    {
                        type: "text" as const,
                        text: `${args.id.trim().toUpperCase()} is ${args.status}.`,
                    },
                ],
            };
        },
    });
    const show = defineTool({
        name: "task_show",
        description: "Show task details and its linked session, if any.",
        parameters: Type.Object({ id: Type.String() }),
        replay: "safe",
        execute: async (args, api, context) => {
            const task = find(
                { tasks: (await api.snapshot(TasksDoc, context))?.tasks ?? [], next: 1 },
                args.id,
            );

            return {
                output: [
                    {
                        type: "text" as const,
                        text: `${task.id} [${task.status}] ${task.title}\nGoal: ${task.goal}\nAcceptance: ${task.acceptance.join("; ") || "none"}\nSession: ${task.claim?.conversationId ?? "none"}\n${task.note}`,
                    },
                ],
            };
        },
    });

    return [list, add, edit, status, show];
}

export default function createTasks(host: PocketHost, web?: ExtensionWeb) {
    if (!web) {
        return;
    }

    web.client("board", { access: "owner" });
    const options = { conversation: "conversation", access: "owner" } as const;

    web.route("GET", "tasks", async (request) => ({
        tasks: ((await request.snapshot(TasksDoc, request.context))?.tasks ?? []).map((task) => ({
            ...task,
            age: age(task),
            heldBy: heldBy(task),
        })),
        statuses: STATUSES,
        sessions: request.sessions(),
    }));
    web.route("POST", "tasks", async (request) => {
        const title = cleanText(request.body.title, "Title", 200);
        const goal = cleanText(request.body.goal, "Goal", 4000);
        const acceptance = Array.isArray(request.body.acceptance)
            ? request.body.acceptance.map((x: unknown) => cleanText(x, "Acceptance criterion", 500))
            : [];
        let created!: Task;

        await request.commit(async (tx) => {
            const store = await tx.doc(TasksDoc);
            const now = Date.now();

            created = {
                id: `TASK-${store.next}`,
                title,
                goal,
                acceptance,
                status: "open",
                claim: null,
                note: "",
                createdAt: now,
                updatedAt: now,
            };
            store.tasks = [...store.tasks, created];
            store.next += 1;
        });

        return { task: created };
    });
    web.route("PATCH", "tasks/:id", async (request) => {
        const id = request.params.id;

        if (!id) {
            throw web.error(400, "A task id is required.");
        }

        const patch = request.body;

        if (patch.status !== undefined && !validStatus(patch.status)) {
            throw web.error(400, `Status must be one of ${STATUSES.join(", ")}.`);
        }

        let result!: Task;

        await request.commit(async (tx) => {
            const store = await tx.doc(TasksDoc);
            const existing = find(store, id);
            const status = patch.status === undefined ? existing.status : (patch.status as Status);

            result = {
                ...existing,
                ...(patch.title === undefined
                    ? {}
                    : { title: cleanText(patch.title, "Title", 200) }),
                ...(patch.goal === undefined ? {} : { goal: cleanText(patch.goal, "Goal", 4000) }),
                ...(patch.acceptance === undefined
                    ? {}
                    : {
                          acceptance: Array.isArray(patch.acceptance)
                              ? patch.acceptance.map((x: unknown) =>
                                    cleanText(x, "Acceptance criterion", 500),
                                )
                              : (() => {
                                    throw web.error(400, "Acceptance must be a list.");
                                })(),
                      }),
                ...(patch.note === undefined
                    ? {}
                    : {
                          note:
                              typeof patch.note === "string"
                                  ? patch.note.trim().slice(0, 1000)
                                  : existing.note,
                      }),
                status,
                claim: status === "working" ? existing.claim : null,
                updatedAt: Date.now(),
            };
            store.tasks = store.tasks.map((each) => (each.id === existing.id ? result : each));
        });

        return { task: result };
    });
    web.conversationRoute(
        "POST",
        "c/:conversation/tasks/:id/link",
        async (request) => {
            const id = request.params.id;

            if (!id) {
                throw web.error(400, "A task id is required.");
            }

            const linkedId = request.conversation.id;
            const linkedTitle = request.conversation.title;
            let result!: Task;

            await request.commit(async (tx) => {
                const store = await tx.doc(TasksDoc);
                const existing = find(store, id);

                result = {
                    ...existing,
                    status: "working",
                    claim: { conversationId: Number(linkedId), by: linkedTitle, at: Date.now() },
                    updatedAt: Date.now(),
                };
                store.tasks = store.tasks.map((each) => (each.id === existing.id ? result : each));
            });

            return { task: result };
        },
        options,
    );

    web.route("GET", "tasks", async (request) => ({
        tasks: ((await request.snapshot(TasksDoc, request.context))?.tasks ?? []).map((task) => ({
            ...task,
            age: age(task),
            heldBy: heldBy(task),
        })),
        statuses: STATUSES,
        sessions: request.sessions(),
    }));
    web.route("POST", "tasks", async (request) => {
        const title = cleanText(request.body.title, "Title", 200);
        const goal = cleanText(request.body.goal, "Goal", 4000);
        const acceptance = Array.isArray(request.body.acceptance)
            ? request.body.acceptance.map((x: unknown) => cleanText(x, "Acceptance criterion", 500))
            : [];
        let created!: Task;

        await request.commit(async (tx) => {
            const store = await tx.doc(TasksDoc);
            const now = Date.now();

            created = {
                id: `TASK-${store.next}`,
                title,
                goal,
                acceptance,
                status: "open",
                claim: null,
                note: "",
                createdAt: now,
                updatedAt: now,
            };
            store.tasks = [...store.tasks, created];
            store.next += 1;
        });

        return { task: created };
    });
    web.route("PATCH", "tasks/:id", async (request) => {
        const id = request.params.id;

        if (id === undefined) {
            throw web.error(400, "A task id is required.");
        }

        const normalizedId = id.toUpperCase();
        const patch = request.body;

        if (patch.status !== undefined && !validStatus(patch.status)) {
            throw web.error(400, `Status must be one of ${STATUSES.join(", ")}.`);
        }

        let result!: Task;

        await request.commit(async (tx) => {
            const store = await tx.doc(TasksDoc);
            const task = find(store, normalizedId);
            const status = patch.status === undefined ? task.status : (patch.status as Status);

            result = {
                ...task,
                ...(patch.title === undefined
                    ? {}
                    : { title: cleanText(patch.title, "Title", 200) }),
                ...(patch.goal === undefined ? {} : { goal: cleanText(patch.goal, "Goal", 4000) }),
                ...(patch.acceptance === undefined
                    ? {}
                    : {
                          acceptance: Array.isArray(patch.acceptance)
                              ? patch.acceptance.map((x: unknown) =>
                                    cleanText(x, "Acceptance criterion", 500),
                                )
                              : (() => {
                                    throw web.error(400, "Acceptance must be a list.");
                                })(),
                      }),
                ...(patch.note === undefined
                    ? {}
                    : {
                          note:
                              typeof patch.note === "string"
                                  ? patch.note.trim().slice(0, 1000)
                                  : task.note,
                      }),
                status,
                claim: status === "working" ? task.claim : null,
                updatedAt: Date.now(),
            };
            store.tasks = store.tasks.map((each) => (each.id === task.id ? result : each));
        });

        return { task: result };
    });
    web.conversationRoute(
        "POST",
        "c/:conversation/tasks/:id/link",
        async (request) => {
            const rawId = request.params.id;

            if (rawId === undefined) {
                throw web.error(400, "A task id is required.");
            }

            const id = rawId.toUpperCase();
            const conversationId = Number(request.conversation.id);
            let task!: Task;

            await request.commit(async (tx) => {
                const store = await tx.doc(TasksDoc);
                const found = find(store, id);

                task = {
                    ...found,
                    status: "working",
                    claim: { conversationId, by: request.conversation.title, at: Date.now() },
                    updatedAt: Date.now(),
                };
                store.tasks = store.tasks.map((each) => (each.id === found.id ? task : each));
            });

            return { task };
        },
        options,
    );

    return defineExtension({
        name: "pocket-tasks",
        tools: makeTaskTools(),
        sections: [TasksGuide],
    });
}
