import { cleanUp, context, newSession, openApp, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { CacheTelemetry, CacheTelemetryDoc, observation } from "../src/server/cache-telemetry.ts";

after(cleanUp);

const message = {
    role: "assistant",
    content: [{ type: "text", text: "private text must not be stored" }],
    provider: "example",
    model: "example",
    api: "openai-completions",
    timestamp: 123,
    stopReason: "stop",
    usage: {
        input: 2,
        output: 3,
        cacheRead: 4,
        cacheWrite: 5,
        totalTokens: 14,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
} as const;

test("the running app stores a response from the actual commit listener", async () => {
    const app = await openApp(scriptedModel());

    try {
        const id = await newSession(app);

        await say(app, id, "A private test message");
        await until(
            async () =>
                ((await app.harness.snapshot(CacheTelemetryDoc, id, context))?.observations
                    .length ?? 0) > 0,
            "response telemetry",
        );
        const result = await app.harness.snapshot(CacheTelemetryDoc, id, context);

        assert.equal(result?.observations[0]?.source, "response");
        assert.equal(JSON.stringify(result).includes("private test message"), false);
    } finally {
        await app.close();
    }
});

test("committed entries store bounded aggregates and deduplicate entry IDs", async () => {
    const doc = { observations: [] as any[] };
    const harness = { commit: async (f: any) => f({ doc: async () => doc }) };
    const telemetry = new CacheTelemetry(harness as never, () => assert.fail("unexpected error"));
    const entry = { id: 1, conversationId: 42, kind: AssistantEntry.kind, model: [message] };
    const publication = { changes: [{ type: "entry", value: entry }] };

    telemetry.committed(publication as never);
    telemetry.committed(publication as never);

    for (let i = 0; i < 101; i++) {
        telemetry.record(42 as never, observation(`refresh-${i}`, "refresh", message as never));
    }

    await telemetry.close();
    assert.equal(doc.observations.length, 100);
    assert.equal(doc.observations[0].id, "refresh-1");
    assert.equal(doc.observations[99].source, "refresh");
    assert.equal(JSON.stringify(doc).includes("private text"), false);
});

test("a committed response uses its stable entry ID and provider usage", async () => {
    const doc = { observations: [] as any[] };
    const telemetry = new CacheTelemetry(
        { commit: async (f: any) => f({ doc: async () => doc }) } as never,
        () => assert.fail(),
    );
    const entry = { id: 19, conversationId: 42, kind: AssistantEntry.kind, model: [message] };

    telemetry.committed({ changes: [{ type: "entry", value: entry }] } as never);
    telemetry.committed({ changes: [{ type: "entry", value: entry }] } as never);
    await telemetry.close();
    assert.equal(doc.observations.length, 1);
    assert.equal(doc.observations[0].id, "19");
    assert.equal(doc.observations[0].cacheRead, 4);
    assert.equal(doc.observations[0].costWrite, 4);
});
