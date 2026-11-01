/** Owner-only task routes for the loopback MCP bridge. Disabled by default. */
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createHash, timingSafeEqual } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationWebRequest, ExtensionWeb, PocketHost } from "../host.ts";

export const pocketApi = 2;
const TaskDoc = defineDoc<{
    tasks: {
        id: string;
        owner: string;
        source: number;
        key: string;
        conversationId: number;
        address: string;
        status: string;
        createdAt: number;
        cwd: string;
    }[];
}>({
    kind: "x.chatgpt-gateway.tasks",
    version: 1,
    scope: "session",
    checkpointWhen: () => false,
    initial: () => ({ tasks: [] }),
});
const MAX_PROMPT = 20_000;
const MAX_ACTIVE = 5;
const MAX_PAGE = 100;
const MAX_OUTPUT_BYTES = 48_000;
const bridgeToken = process.env.PI_POCKET_CHATGPT_BRIDGE_TOKEN ?? "";

const equal = (a: string, b: string) => {
    const x = Buffer.from(a),
        y = Buffer.from(b);

    return x.length === y.length && timingSafeEqual(x, y);
};

const stableId = (owner: string, source: number, key: string) => {
    const b = createHash("sha256").update(`${owner}:${source}:${key}`).digest().subarray(0, 16);

    b[6] = (b[6]! & 15) | 0x50;
    b[8] = (b[8]! & 63) | 0x80;
    const h = b.toString("hex");

    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export default function chatgptGateway(host: PocketHost, web: ExtensionWeb) {
    web.settings([
        {
            name: "enabled",
            type: "boolean",
            default: false,
            label: "Enable the local ChatGPT MCP bridge",
        },
        {
            name: "workspaceRoot",
            type: "text",
            default: "/tmp/pi-pocket-gateway-workspace",
            label: "Allowed repository root",
        },
    ]);
    const enabled = () => host.settingFor(web.module, "enabled") === true;

    const check = (request: ConversationWebRequest) => {
        if (!enabled()) {
            throw web.error(503, "The task bridge is disabled.");
        }

        if (!bridgeToken || !equal(String(request.body.bridgeToken ?? ""), bridgeToken)) {
            throw web.error(401, "Invalid local bridge credentials.");
        }

        if (request.user.role !== "owner" || host.roleOf(request.user.id) !== "owner") {
            throw web.error(403, "Owner authorization is required.");
        }

        const meta = host.sessionMeta(request.conversation.id);
        const sourceOwner = meta?.linkedFrom
            ? host.sessionCatalogue()[String(meta.linkedFrom.id)]?.createdBy
            : meta?.createdBy;

        if (String(request.body.bridgeOwner ?? "") !== request.user.id) {
            throw web.error(403, "The bridge owner does not match the signed-in owner.");
        }

        if (!meta || sourceOwner !== request.user.id) {
            throw web.error(403, "The owner must own the source session.");
        }
    };

    const rows = async (request: ConversationWebRequest) =>
        (await request.snapshot(TaskDoc, request.context))?.tasks ?? [];
    const get = async (request: ConversationWebRequest, id: string) =>
        (await rows(request)).find(
            (task) =>
                task.id === id &&
                task.owner === request.user.id &&
                task.source === Number(request.conversation.id),
        );
    const update = async (
        request: ConversationWebRequest,
        id: string,
        fn: (task: NonNullable<Awaited<ReturnType<typeof get>>>) => void,
    ) =>
        request.commit(async (tx) => {
            const task = (await tx.doc(TaskDoc)).tasks.find(
                (row) =>
                    row.id === id &&
                    row.owner === request.user.id &&
                    row.source === Number(request.conversation.id),
            );

            if (task) {
                fn(task as NonNullable<Awaited<ReturnType<typeof get>>>);
            }
        });

    web.internalServiceRoute(
        "POST",
        "gateway/:source/submit",
        async (request: ConversationWebRequest) => {
            check(request);
            const { prompt, repositoryPath, idempotencyKey } = request.body;

            if (
                typeof prompt !== "string" ||
                !prompt.trim() ||
                prompt.length > MAX_PROMPT ||
                typeof repositoryPath !== "string" ||
                typeof idempotencyKey !== "string" ||
                !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)
            ) {
                throw web.error(400, "Invalid task input.");
            }

            const source = Number(request.conversation.id),
                owner = request.user.id,
                all = await rows(request);
            const prior = all.find(
                (task) =>
                    task.owner === owner && task.source === source && task.key === idempotencyKey,
            );

            if (prior?.conversationId) {
                const live = (await request.linkedSessions.list()).find(
                    (item) => item.address === prior.address,
                );

                if (live) {
                    return { taskId: prior.id, status: prior.status, duplicate: true };
                }
            }

            if (
                all.filter(
                    (task) =>
                        task.owner === owner &&
                        task.source === source &&
                        ["creating", "running", "waiting"].includes(task.status),
                ).length >= MAX_ACTIVE
            ) {
                throw web.error(429, "Active task limit reached.");
            }

            const rootValue = host.settingFor(web.module, "workspaceRoot");

            if (typeof rootValue !== "string" || !rootValue) {
                throw web.error(503, "Workspace root is not configured.");
            }

            const root = host.workspace.checkDirectory(rootValue),
                candidate = resolve(root, repositoryPath),
                rel = relative(root, candidate);

            if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
                throw web.error(400, "Repository path must be a child of the workspace root.");
            }

            const cwd = host.workspace.checkDirectory(candidate),
                canonicalRel = relative(root, cwd);

            if (!canonicalRel || canonicalRel === ".." || canonicalRel.startsWith(`..${sep}`)) {
                throw web.error(400, "Repository path must resolve inside the workspace root.");
            }

            const id = prior?.id ?? stableId(owner, source, idempotencyKey);

            if (!prior && (await rows(request)).some((task) => task.id === id)) {
                return { taskId: id, status: "creating", duplicate: true };
            }

            if (!prior) {
                await request.commit(async (tx) => {
                    const doc = await tx.doc(TaskDoc);

                    if (
                        doc.tasks.some(
                            (task) =>
                                task.owner === owner &&
                                task.source === source &&
                                task.key === idempotencyKey,
                        )
                    ) {
                        return;
                    }

                    if (
                        doc.tasks.filter(
                            (task) =>
                                task.owner === owner &&
                                task.source === source &&
                                ["creating", "running", "waiting"].includes(task.status),
                        ).length >= MAX_ACTIVE
                    ) {
                        throw web.error(429, "Active task limit reached.");
                    }

                    {
                        doc.tasks.push({
                            id,
                            owner,
                            source,
                            key: idempotencyKey,
                            conversationId: 0,
                            address: "",
                            status: "creating",
                            createdAt: Date.now(),
                            cwd,
                        });
                    }
                });
            }

            if (prior?.conversationId) {
                const existingLink = (await request.linkedSessions.list()).find(
                    (item) => item.address === prior.address,
                );

                if (existingLink) {
                    return { taskId: prior.id, status: prior.status, duplicate: true };
                }
            }

            const linked = await request.linkedSessions.start(
                { title: `ChatGPT task ${id.slice(0, 8)}`, message: prompt, cwd },
                `chatgpt-task:${owner}:${source}:${idempotencyKey}`,
            );

            await update(request, id, (task) => {
                task.address = linked.address;
                task.conversationId = Number(linked.session);
                task.status = "running";
            });

            return { taskId: id, status: "running", duplicate: Boolean(prior) };
        },
    );

    web.internalServiceRoute(
        "POST",
        "gateway/:source/status",
        async (request: ConversationWebRequest) => {
            check(request);
            const id = String(request.body.taskId ?? ""),
                task = await get(request, id);

            if (!task || !task.conversationId) {
                throw web.error(404, "Task not found.");
            }

            const linked = await request.linkedSessions.list(),
                session = linked.find((item) => item.address === task.address);
            const approvalPending = host.approvals
                .all()
                .some((item) => Number(item.conversationId) === task.conversationId);
            const status =
                task.status === "cancelled"
                    ? "cancelled"
                    : approvalPending
                      ? "waiting"
                      : !session
                        ? task.status
                        : session.busy
                          ? "running"
                          : session.archived
                            ? "archived"
                            : "completed";

            if (status !== task.status) {
                await update(request, id, (record) => {
                    record.status = status;
                });
            }

            return { taskId: id, status, approvalPending };
        },
    );

    web.internalServiceRoute(
        "POST",
        "gateway/:source/results",
        async (request: ConversationWebRequest) => {
            check(request);
            const id = String(request.body.taskId ?? ""),
                task = await get(request, id);

            if (!task || !task.conversationId) {
                throw web.error(404, "Task not found.");
            }

            let after = Number(request.body.after ?? 0);
            const limit = Math.min(
                MAX_PAGE,
                Math.max(1, Math.floor(Number(request.body.limit ?? 50))),
            );

            if (!Number.isSafeInteger(after) || after < 0) {
                throw web.error(400, "Invalid result cursor.");
            }

            const conversation = await host.conversation(task.conversationId as ConversationId),
                entries: unknown[] = [];
            let cursor: any,
                hasMore = false,
                bytes = 0;

            do {
                const page = await conversation.entries(
                    after ? { minEntryId: (after + 1) as never } : {},
                    256,
                    cursor,
                    request.context,
                );

                for (const entry of page.items) {
                    const safe = { id: Number(entry.id), kind: entry.kind, data: entry.data },
                        size = Buffer.byteLength(JSON.stringify(safe));

                    if (entries.length >= limit || bytes + size > MAX_OUTPUT_BYTES) {
                        hasMore = true;
                        break;
                    }

                    entries.push(safe);
                    bytes += size;
                    after = Number(entry.id);
                }

                cursor = page.next;

                if (hasMore || !cursor) {
                    break;
                }
            } while (true);

            return { taskId: id, entries, nextCursor: hasMore ? after : null, hasMore };
        },
    );

    web.internalServiceRoute(
        "POST",
        "gateway/:source/cancel",
        async (request: ConversationWebRequest) => {
            check(request);
            const id = String(request.body.taskId ?? ""),
                task = await get(request, id);

            if (!task) {
                throw web.error(404, "Task not found.");
            }

            if (task.conversationId && ["running", "waiting"].includes(task.status)) {
                await host.taskGateway.abort(task.conversationId as ConversationId, task.owner);
            }

            await update(request, id, (record) => {
                record.status = "cancelled";
            });

            return { taskId: id, status: "cancelled" };
        },
    );

    const help = defineTool({
        name: "chatgpt_task_gateway_help",
        description: "Explain local gateway safety.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async () => ({
            output: [
                {
                    type: "text" as const,
                    text: "The local MCP task bridge is disabled by default. It cannot approve actions.",
                },
            ],
        }),
    });

    return defineExtension({ name: "chatgpt-task-gateway", tools: [help] });
}
