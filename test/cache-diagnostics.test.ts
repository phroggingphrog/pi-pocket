import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageDoc } from "@earendil-works/pi-durable";
import createCacheDiagnostics, { report, totalsOf } from "../docs/examples/cache-diagnostics.ts";

const usage = {
    models: {
        "provider/model": {
            input: 10,
            output: 3,
            cacheRead: 70,
            cacheWrite: 20,
            totalTokens: 103,
            cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        },
    },
    tools: {},
};

test("aggregate totals show the provider ledger without transcript or tool data", () => {
    const totals = totalsOf(usage);
    const output = report(totals, []);

    assert.match(output, /uncached 10, read 70, write 20, output 3; read share 70\.0%/);
    assert.match(output, /cost input \$1\.000000, read \$3\.000000, write \$4\.000000/);
    assert.match(output, /No samples yet/);
    assert.doesNotMatch(output, /provider\/model/);
    assert.match(report(totalsOf(undefined), []), /read share unavailable/);
});

test("refresh stores bounded aggregate samples, and show reads only the current conversation", async () => {
    let command: any;
    const routes: Record<string, { handler: any; options: any }> = {};
    const timeline = { samples: [] as any[] };
    const web = {
        command: (_name: string, definition: unknown) => {
            command = definition;
        },
        conversationRoute: (method: string, path: string, handler: unknown, options: unknown) => {
            routes[`${method} ${path}`] = { handler, options };
        },
        client: () => {},
        error: (_status: number, message: string) => new Error(message),
    };

    createCacheDiagnostics(undefined, web as never);
    assert.equal(command.scope, "conversation");
    assert.deepEqual(routes["GET usage/:source"]!.options, {
        conversation: "source",
        access: "owner",
    });
    assert.deepEqual(routes["POST sample/:source"]!.options, {
        conversation: "source",
        access: "owner",
    });
    const context = {
        conversationId: 42,
        context: {},
        signal: new AbortController().signal,
        snapshot: async (doc: unknown, id: number) => {
            assert.equal(id, 42);

            return doc === UsageDoc ? usage : timeline;
        },
        commit: async (fn: (tx: unknown) => Promise<unknown>) =>
            fn({
                doc: async (doc: unknown, id: number) => {
                    assert.equal(id, 42);

                    return doc === UsageDoc ? usage : timeline;
                },
            }),
    };

    const request = { ...context, conversation: { id: 42 } };
    const initial = await routes["GET usage/:source"]!.handler(request);

    assert.equal(initial.totals.cacheRead, 70);
    assert.deepEqual(initial.observations, []);
    await routes["POST sample/:source"]!.handler(request);
    assert.equal(timeline.samples.length, 1);

    for (let i = 0; i < 14; i++) {
        await command.handler("refresh", context);
    }

    assert.equal(timeline.samples.length, 12);
    assert.deepEqual(Object.keys(timeline.samples[0]).sort(), ["at", "totals"]);
    const result = await command.handler("", context);

    assert.match(result.output, /manual cumulative samples/);
    assert.equal(
        result.output.split("\n").filter((line: string) => /Z: uncached/.test(line)).length,
        12,
    );
    await assert.rejects(command.handler("reset", context), /Use \/cache-diagnostics/);
    context.signal = AbortSignal.abort();
    await assert.rejects(command.handler("refresh", context));
    assert.equal(timeline.samples.length, 12);
});
