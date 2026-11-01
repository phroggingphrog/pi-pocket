/**
 * Show conversation cache usage and record manual, aggregate-only timeline samples. Copy this file and
 * cache-diagnostics.js to the extensions folder, then turn it on in Menu → Extensions. It makes no model requests.
 */
import { defineDoc, UsageDoc, type UsageState } from "@earendil-works/pi-durable";
import type { Web } from "../../types/pocket.d.ts";

type Totals = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costInput: number;
    costOutput: number;
    costRead: number;
    costWrite: number;
    costTotal: number;
};
type Sample = { at: string; totals: Totals };

type Observation = Totals & {
    id: string;
    at: number;
    source: "response" | "refresh";
    outcome: string;
};
const Observations = defineDoc<{ observations: Observation[] }>({
    kind: "x.cache-diagnostics.observations",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    checkpointWhen: () => false,
    initial: () => ({ observations: [] }),
});

const Timeline = defineDoc<{ samples: Sample[] }>({
    kind: "x.cache-diagnostics.timeline",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ samples: [] }),
    checkpointWhen: () => false,
});

export function totalsOf(usage: UsageState | null | undefined): Totals {
    const total: Totals = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costInput: 0,
        costOutput: 0,
        costRead: 0,
        costWrite: 0,
        costTotal: 0,
    };

    for (const value of Object.values(usage?.models ?? {})) {
        total.input += value.input;
        total.output += value.output;
        total.cacheRead += value.cacheRead;
        total.cacheWrite += value.cacheWrite;
        total.costInput += value.cost.input;
        total.costOutput += value.cost.output;
        total.costRead += value.cost.cacheRead;
        total.costWrite += value.cost.cacheWrite;
        total.costTotal += value.cost.total;
    }

    return total;
}

function money(value: number): string {
    return `$${value.toFixed(6)}`;
}

function format(t: Totals): string {
    const prompt = t.input + t.cacheRead + t.cacheWrite;
    const rate = prompt > 0 ? `${((100 * t.cacheRead) / prompt).toFixed(1)}%` : "unavailable";

    return `uncached ${t.input}, read ${t.cacheRead}, write ${t.cacheWrite}, output ${t.output}; read share ${rate}; cost input ${money(t.costInput)}, read ${money(t.costRead)}, write ${money(t.costWrite)}, output ${money(t.costOutput)}, total ${money(t.costTotal)}`;
}

export function report(totals: Totals, samples: readonly Sample[]): string {
    const lines = [
        "Conversation model usage (provider-reported; excludes tools and other conversations)",
        `Current totals: ${format(totals)}`,
        "Timeline: manual cumulative samples, oldest first. Refresh records a sample; it does not warm the cache.",
    ];

    if (samples.length === 0) {
        lines.push("No samples yet. Run /cache-diagnostics refresh to record one.");
    }

    for (const sample of samples) {
        lines.push(`${sample.at}: ${format(sample.totals)}`);
    }

    lines.push(
        "Samples do not identify individual requests, cache expiry, refresh causes, or unreported provider usage.",
    );

    return lines.join("\n");
}

export default function createCacheDiagnostics(_host: unknown, web: Web) {
    if (typeof web.conversationRoute !== "function") {
        throw new Error("Cache diagnostics needs Pi Pocket 0.19.0 or newer.");
    }

    web.conversationRoute(
        "GET",
        "usage/:source",
        async (request) => {
            const usage = await request.snapshot(
                UsageDoc,
                request.conversation.id,
                request.context,
            );
            const timeline = await request.snapshot(
                Timeline,
                request.conversation.id,
                request.context,
            );
            const observations = await request.snapshot(
                Observations,
                request.conversation.id,
                request.context,
            );

            return {
                totals: totalsOf(usage),
                models: Object.entries(usage?.models ?? {}).map(([model, value]) => ({
                    model,
                    totals: totalsOf({ models: { model: value }, tools: {} }),
                })),
                samples: timeline?.samples ?? [],
                observations: observations?.observations ?? [],
            };
        },
        { conversation: "source", access: "owner" },
    );
    web.conversationRoute(
        "POST",
        "sample/:source",
        async (request) => {
            return request.commit(async (tx) => {
                const totals = totalsOf(await tx.doc(UsageDoc, request.conversation.id));
                const timeline = await tx.doc(Timeline, request.conversation.id);

                timeline.samples.push({ at: new Date().toISOString(), totals });

                if (timeline.samples.length > 12) {
                    timeline.samples.splice(0, timeline.samples.length - 12);
                }

                return { ok: true };
            });
        },
        { conversation: "source", access: "owner" },
    );
    web.client("cache-diagnostics.js");
    web.command("cache-diagnostics", {
        description: "Show conversation cache totals and manual timeline samples",
        args: "[refresh]",
        scope: "conversation",
        handler: async (args, ctx) => {
            const action = args.trim();

            if (action !== "" && action !== "refresh") {
                throw web.error(400, "Use /cache-diagnostics or /cache-diagnostics refresh.");
            }

            ctx.signal.throwIfAborted();

            if (action === "refresh") {
                const result = await ctx.commit(async (tx) => {
                    const totals = totalsOf(await tx.doc(UsageDoc, ctx.conversationId));
                    const timeline = await tx.doc(Timeline, ctx.conversationId);

                    timeline.samples.push({ at: new Date().toISOString(), totals });

                    if (timeline.samples.length > 12) {
                        timeline.samples.splice(0, timeline.samples.length - 12);
                    }

                    return {
                        totals,
                        samples: timeline.samples.map((sample) => ({
                            at: sample.at,
                            totals: { ...sample.totals },
                        })),
                    };
                });

                return { type: "card", output: report(result.totals, result.samples) };
            }

            const usage = await ctx.snapshot(UsageDoc, ctx.conversationId, ctx.context);
            const timeline = await ctx.snapshot(Timeline, ctx.conversationId, ctx.context);

            return { type: "card", output: report(totalsOf(usage), timeline?.samples ?? []) };
        },
    });
}
