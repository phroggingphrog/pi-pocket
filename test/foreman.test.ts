import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentDoc, LiveDoc, type HookApi } from "@earendil-works/pi-durable";
import { ExtensionWebs } from "../src/server/extension-web.ts";
import type { PocketHost } from "../src/server/host.ts";
import createForeman, {
    foremanTransport,
    ForemanControl,
} from "../src/server/extensions/foreman.ts";
import { cleanUp, newSession, openApp, root, scriptedModel, work, context } from "./helpers.ts";

after(cleanUp);

function fixture(directory: string, response: unknown, delayMs = 0): string {
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "foreman-fixture.mjs");

    writeFileSync(
        file,
        `#!/usr/bin/env node\nlet input = ""; for await (const chunk of process.stdin) input += chunk;\n${delayMs ? `await new Promise((resolve) => setTimeout(resolve, ${delayMs}));\n` : ""}process.stdout.write(${JSON.stringify(JSON.stringify(response))});\n`,
    );
    chmodSync(file, 0o700);

    return file;
}

function webHarness(settings: Record<string, string | number | boolean> = {}) {
    const webs = new ExtensionWebs({ settings: () => settings });
    const { part, web } = webs.stage("foreman.ts", "/fixture", "Foreman");

    return { webs, part, web };
}

function fakeRuntime(response: (payload: Record<string, unknown>) => unknown) {
    const control = { workId: "stable-input", halt: "", continuations: 0, requests: 0 };
    const calls: Record<string, unknown>[] = [];
    let approvalCalls = 0;
    const memos = new Map<string, unknown>();
    let selected = true;
    const textEntry = { model: [{ role: "user", content: "Review this task." }] };
    const conversation = {
        entries: async () => ({ items: [{ id: 2, model: textEntry.model }] }),
        commit: async (
            change: (tx: {
                doc: (token: unknown, id: unknown) => Promise<typeof control>;
            }) => unknown,
        ) => change({ doc: async () => control }),
        agent: async () => ({ extensions: selected ? [{ name: "foreman" }] : [] }),
    };
    const harness = {
        conversation: async () => conversation,
        submission: async () => ({
            status: async () => ({ status: "placed", type: "input", entry: 2 }),
        }),
        abortTask: async () => "marked",
    };
    const host = {
        dataDir: "/tmp/pip-test-data",
        durableHarness: () => harness,
        defaultExtensionNames: () => ["coding-tools", "pocket-guard"],
        guard: { judge: async () => undefined },
        approvals: {
            request: async () => {
                approvalCalls += 1;

                return { allow: false, by: "denied" };
            },
        },
    } as unknown as PocketHost;
    const { webs, part, web } = webHarness({
        dataDirectory: root,
        provider: "jev",
        model: "fixture-model",
        executable: "fixture",
    });
    const createForemanExtension = createForeman(host, web, async (payload) => {
        calls.push(payload as unknown as Record<string, unknown>);

        return response(payload as unknown as Record<string, unknown>) as never;
    });

    webs.check(part);
    webs.commit(part, []);
    const api = {
        taskId: "task-1",
        conversationId: 1,
        snapshot: async (token: unknown) =>
            token === LiveDoc
                ? { run: { inputs: [10] } }
                : token === AgentDoc
                  ? {
                        cwd: work,
                        extensions: selected
                            ? { add: ["foreman"], remove: [] }
                            : { add: [], remove: ["foreman"] },
                    }
                  : token === ForemanControl
                    ? control
                    : undefined,
        memo: async (...args: unknown[]) => {
            const [name, value] = args as [string, unknown?, unknown?];

            if (args.length === 3) {
                memos.set(name, value);
            }

            return memos.get(name);
        },
    } as unknown as HookApi;
    const generation = createForemanExtension.hooks!.find((item) => item.task === "pi.generation")!;

    return {
        host,
        web,
        webs,
        extension: createForemanExtension,
        api,
        generation: generation.handlers as Record<string, (...args: never[]) => unknown>,
        control,
        calls,
        memos,
        setSelected: (value: boolean) => {
            selected = value;
        },
        approvalCalls: () => approvalCalls,
    };
}

test("transport accepts deterministic assessments, enforces evidence bounds, and cancels a fixture", async () => {
    const directory = join(root, "foreman-transport");
    const executable = fixture(directory, { action: "allow" }, 300);
    const payload = { session_id: "one", cwd: work, work_id: "1", event_id: "e", event: {} };

    assert.equal((await foremanTransport(payload, executable, directory)).action, "allow");
    await assert.rejects(
        foremanTransport(
            { ...payload, event: { body: "x".repeat(25_000) } },
            executable,
            directory,
        ),
        /request limit/,
    );
    const controller = new AbortController();
    const pending = foremanTransport(payload, executable, directory, controller.signal);

    controller.abort();
    await assert.rejects(pending, /cancelled/);
});

test("selected lifecycle checks prompt then records terminal feedback through a mocked assessment", async () => {
    const runtime = fakeRuntime(() => ({ action: "allow" }));
    const before = runtime.generation.beforeRequest as (
        request: unknown,
        api: HookApi,
        context: import("@earendil-works/chord").Context,
    ) => Promise<unknown>;

    await before(
        { messages: [{ role: "user", content: "Review this task." }] },
        runtime.api,
        context,
    );
    assert.equal(runtime.calls.length, 1);
    const sent = runtime.calls[0] as {
        event: Record<string, unknown>;
        session_id: string;
        work_id: string;
    };

    assert.equal(sent.event.prompt, "Review this task.");
    assert.equal(sent.session_id, JSON.stringify(["/tmp/pip-test-data", 1]));
    assert.equal(sent.work_id, "[10]");
    const after = runtime.generation.onYield as (
        answer: never,
        api: HookApi,
        context: import("@earendil-works/chord").Context,
    ) => Promise<unknown>;

    await after({ content: [{ type: "text", text: "completed" }] } as never, runtime.api, context);
    assert.equal((runtime.calls[1] as { event: { type: string } }).event.type, "onYield");
});

test("tool blocks and inject_context stop tool intent, and no outcome grants approval", async () => {
    const blocked = fakeRuntime(() => ({ action: "block", reason: "unsafe tool" }));
    const before = blocked.generation.beforeRequest as (
        request: never,
        api: HookApi,
        context: import("@earendil-works/chord").Context,
    ) => Promise<unknown>;

    await assert.rejects(
        before(
            { messages: [{ role: "user", content: "Review this task." }] } as never,
            blocked.api,
            context,
        ),
        /unsafe tool/,
    );
    assert.equal(blocked.control.halt, "unsafe tool");
    assert.equal(blocked.approvalCalls(), 0);

    const feedback = fakeRuntime(() => ({
        action: "inject_context",
        system_message: "Check the path.",
    }));
    const feedbackHook = feedback.generation.beforeRequest as (
        request: never,
        api: HookApi,
        context: import("@earendil-works/chord").Context,
    ) => Promise<{ messages: unknown[] } | undefined>;
    const changed = await feedbackHook(
        { messages: [{ role: "user", content: "Review this task." }] } as never,
        feedback.api,
        context,
    );

    assert.match(JSON.stringify(changed), /Check the path/);
    const intentHook = feedback.extension.hooks!.find((item) => item.task === "pi.tool")!
        .handlers as {
        beforeTool: (
            call: never,
            api: HookApi,
            context: import("@earendil-works/chord").Context,
        ) => Promise<{ block?: string } | undefined>;
    };
    const intent = await intentHook.beforeTool(
        { name: "bash", arguments: { command: "git status" } } as never,
        feedback.api,
        context,
    );

    assert.match(intent?.block ?? "", /Foreman requests a correction/);
    assert.equal(feedback.approvalCalls(), 0);
    assert.equal(feedback.calls.length, 2);
});

test("disabled session starts no assessment, and conversation control state does not cross sessions", async () => {
    const app = await openApp(scriptedModel(), join(root, "foreman-disabled"));

    try {
        const first = await newSession(app);
        const second = await newSession(app);
        const ext = (await (await app.harness.conversation(first, context))!.agent(context))
            .extensions;

        assert.equal(
            ext.some((item) => item.name === "foreman"),
            false,
        );
        await app.harness.commit(async (tx) => {
            (await tx.doc(ForemanControl, first)).requests = 3;
        }, context);
        assert.equal(
            (await app.harness.snapshot(ForemanControl, second, context))?.requests,
            undefined,
        );
    } finally {
        await app.close();
    }
});

test("restart recovery retains counters and session identity", async () => {
    const directory = join(root, "foreman-restart");
    const app = await openApp(scriptedModel(), directory);
    const id = await newSession(app);

    await app.harness.commit(async (tx) => {
        const control = await tx.doc(ForemanControl, id);

        control.workId = "stable-input";
        control.requests = 7;
        control.continuations = 1;
    }, context);
    await app.close();
    const reopened = await openApp(scriptedModel(), directory);

    try {
        const recovered = await reopened.harness.snapshot(ForemanControl, id, context);

        assert.equal(recovered?.workId, "stable-input");
        assert.equal(recovered?.requests, 7);
        assert.equal(recovered?.continuations, 1);
    } finally {
        await reopened.close();
    }
});

test("completion continuation stays bounded and memoized across hook replay", async () => {
    const runtime = fakeRuntime(() => ({ action: "inject_context", reason: "continue" }));
    const yieldHook = runtime.generation.onYield as (
        answer: never,
        api: HookApi,
        context: import("@earendil-works/chord").Context,
    ) => Promise<{ continue: { type: string; text: string } }>;
    const answer = { content: [{ type: "text", text: "done" }] } as never;
    const first = await yieldHook(answer, runtime.api, context);
    const second = await yieldHook(answer, runtime.api, context);

    assert.equal(first.continue, "continue");
    assert.equal(second.continue, "continue");
    assert.equal(runtime.control.continuations, 1);
    const stopped = await yieldHook(answer, runtime.api, context);

    assert.deepEqual(stopped, { continue: "continue" });
    assert.equal(runtime.control.continuations, 1);
    assert.equal(
        runtime.calls.filter(
            (item) => (item as { event: { type: string } }).event.type === "onYield",
        ).length,
        1,
    );
});
