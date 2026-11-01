/** Pi Pocket task manager. It preserves Board's durable task document while providing one full task interface. */
import type { ExtensionWeb, PocketHost } from "../host.ts";
import { defineExtension } from "@earendil-works/pi-durable";
import { makeTaskTools, TasksDoc, TasksGuide } from "./_tasks.ts";

export default function createBoard(_host: PocketHost, web?: ExtensionWeb) {
    if (!web) {
        return;
    }

    web.client("board", { access: "owner" });
    web.route("GET", "tasks", async (request) => ({
        tasks: ((await request.snapshot(TasksDoc, request.context))?.tasks ?? []).map((task) => ({
            ...task,
            age:
                task.status === "working" &&
                task.claim &&
                Date.now() - task.claim.at > 6 * 60 * 60 * 1000
                    ? "abandoned"
                    : task.status === "working" && task.claim
                      ? "live"
                      : "none",
            heldBy: task.claim?.by ?? "nobody",
        })),
        statuses: ["open", "working", "review", "done"],
        sessions: request.sessions(),
    }));
    web.route("POST", "tasks", async (request) => {
        const title = request.body.title;
        const goal = request.body.goal;

        if (
            typeof title !== "string" ||
            !title.trim() ||
            typeof goal !== "string" ||
            !goal.trim()
        ) {
            throw web.error(400, "Title and goal are required.");
        }

        const acceptance = Array.isArray(request.body.acceptance)
            ? request.body.acceptance.filter((x): x is string => typeof x === "string")
            : [];
        let task;

        await request.commit(async (tx) => {
            const store = await tx.doc(TasksDoc);
            const now = Date.now();

            task = {
                id: `TASK-${store.next}`,
                title: title.trim(),
                goal: goal.trim(),
                acceptance,
                status: "open" as const,
                claim: null,
                note: "",
                createdAt: now,
                updatedAt: now,
            };
            store.tasks = [...store.tasks, task];
            store.next += 1;
        });

        return { task };
    });
    web.route("PATCH", "tasks/:id", async (request) => {
        const id = request.params.id;

        if (!id) {
            throw web.error(400, "A task id is required.");
        }

        let task;

        await request.commit(async (tx) => {
            const store = await tx.doc(TasksDoc);
            const existing = store.tasks.find((each) => each.id === id.toUpperCase());

            if (!existing) {
                throw web.error(404, `No task has id ${id.toUpperCase()}.`);
            }

            const status = request.body.status;

            if (
                status !== undefined &&
                !["open", "working", "review", "done"].includes(String(status))
            ) {
                throw web.error(400, "Invalid task status.");
            }

            task = {
                ...existing,
                ...(typeof request.body.title === "string"
                    ? { title: request.body.title.trim() }
                    : {}),
                ...(typeof request.body.goal === "string"
                    ? { goal: request.body.goal.trim() }
                    : {}),
                ...(Array.isArray(request.body.acceptance)
                    ? {
                          acceptance: request.body.acceptance.filter(
                              (x): x is string => typeof x === "string",
                          ),
                      }
                    : {}),
                ...(typeof request.body.note === "string"
                    ? { note: request.body.note.trim() }
                    : {}),
                ...(status === undefined
                    ? {}
                    : {
                          status: status as typeof existing.status,
                          claim: status === "working" ? existing.claim : null,
                      }),
                updatedAt: Date.now(),
            };
            store.tasks = store.tasks.map((each) => (each.id === existing.id ? task! : each));
        });

        return { task };
    });
    web.conversationRoute(
        "POST",
        "c/:conversation/tasks/:id/link",
        async (request) => {
            const id = request.params.id;

            if (!id) {
                throw web.error(400, "A task id is required.");
            }

            let taskId: string | undefined;

            const linkedSession = request.conversation.id;
            const linkedTitle = request.conversation.title;

            await request.commit(async (tx) => {
                const store = await tx.doc(TasksDoc);
                const existing = store.tasks.find((each) => each.id === id.toUpperCase());

                if (!existing) {
                    throw web.error(404, `No task has id ${id.toUpperCase()}.`);
                }

                const task = {
                    ...existing,
                    status: "working" as const,
                    claim: {
                        conversationId: Number(linkedSession),
                        by: linkedTitle,
                        at: Date.now(),
                    },
                    updatedAt: Date.now(),
                };

                store.tasks = store.tasks.map((each) => (each.id === existing.id ? task : each));
                taskId = task.id;
            });

            return {
                task: (await request.snapshot(TasksDoc, request.context))?.tasks.find(
                    (each) => each.id === taskId,
                ),
            };
        },
        { conversation: "conversation", access: "owner" },
    );
    const tools = makeTaskTools();

    return defineExtension({ name: "pocket-tasks", tools, sections: [TasksGuide] });
}
