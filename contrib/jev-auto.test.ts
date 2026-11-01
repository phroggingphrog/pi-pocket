import assert from "node:assert/strict";
import { test } from "node:test";
import {
    fallback,
    forwardRequest,
    parseEfforts,
    shapeForwarded,
    validateDecision,
    MODELS,
} from "./jev-auto.ts";

const capabilities = {
    cheap: ["low", "medium"],
    work: ["medium", "high"],
    hard: ["high", "max"],
} as const;
const options = {
    minimumConfidence: 0.5,
    timeoutMs: 250,
    fallbackTier: "work" as const,
    capabilities: {
        cheap: [...capabilities.cheap],
        work: [...capabilities.work],
        hard: [...capabilities.hard],
    },
};

test("accepts a Jev tier and effort only when the backend supports it", () => {
    assert.deepEqual(validateDecision({ tier: "hard", effort: "max" }, 0.8, options), {
        tier: "hard",
        effort: "max",
        source: "jev",
        why: "Jev selected hard tier and max effort (80% confidence)",
    });
    assert.equal(validateDecision({ tier: "hard", effort: "low" }, 0.9, options), undefined);
    assert.equal(validateDecision({ tier: "odd", effort: "max" }, 0.9, options), undefined);
    assert.equal(validateDecision({ tier: "hard", effort: "max" }, 0.4, options), undefined);
});

test("uses deterministic local tier and effort fallback for bad or unavailable Jev output", () => {
    assert.deepEqual(fallback("Please audit this migration", 0, "work", options.capabilities), {
        tier: "hard",
        effort: "high",
        source: "rules",
        why: "local rules",
    });
    assert.deepEqual(fallback("Format the list", 0, "work", options.capabilities), {
        tier: "cheap",
        effort: "low",
        source: "rules",
        why: "local rules",
    });
    assert.deepEqual(fallback("ordinary task", 0, "work", options.capabilities), {
        tier: "work",
        effort: "medium",
        source: "rules",
        why: "local rules",
    });
});

test("does not forward unsupported effort, and forwards supported OpenAI-compatible reasoning_effort", () => {
    const body = {
        model: "auto",
        messages: [],
        reasoning_effort: "high",
        thinking: "high",
        output_config: { effort: "high" },
    };
    const supported = shapeForwarded(
        body,
        { tier: "hard", effort: "max", source: "jev", why: "ok" },
        options.capabilities,
    );

    assert.equal(supported.forwarded.model, MODELS.hard);
    assert.equal(supported.forwarded.reasoning_effort, "max");
    assert.equal(supported.effectiveEffort, "max");
    assert.equal("thinking" in supported.forwarded, false);
    const unsupported = shapeForwarded(
        body,
        { tier: "cheap", effort: "high", source: "jev", why: "bad" },
        options.capabilities,
    );

    assert.equal("reasoning_effort" in unsupported.forwarded, false);
    assert.equal(unsupported.effectiveEffort, "off");
});

test("settings effort lists ignore invalid entries and use configured defaults", () => {
    assert.deepEqual(parseEfforts("low,high,magic", ["medium"]), ["low", "high"]);
    assert.deepEqual(parseEfforts("bad", ["medium"]), []);
    assert.deepEqual(parseEfforts(undefined, ["medium"]), ["medium"]);
});

test("forwarding preserves supported effort, rewrites tier, and streams the response", async () => {
    let sent: Record<string, unknown> | undefined;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode("data: mock\\n\\n"));
            controller.close();
        },
    });
    const result = await forwardRequest(
        { model: "auto", messages: [], reasoning_effort: "low" },
        { tier: "hard", effort: "max", source: "jev", why: "test" },
        options.capabilities,
        "local-test-key",
        "http://127.0.0.1:20128/mock",
        async (_url, init) => {
            sent = JSON.parse(String(init?.body)) as Record<string, unknown>;

            return new Response(stream, {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            });
        },
    );

    assert.equal(sent?.model, MODELS.hard);
    assert.equal(sent?.reasoning_effort, "max");
    assert.equal(result.contentType, "text/event-stream");
    assert.equal(await new Response(result.body).text(), "data: mock\\n\\n");
});

test("missing upstream credentials are rejected before any network request", async () => {
    const { readKey } = await import("./jev-auto.ts");

    assert.equal(readKey("/definitely/missing/file", "OMNIROUTE_KEY"), "");
    let called = false;
    const key = readKey("/definitely/missing/file", "OMNIROUTE_KEY");

    if (key) {
        await forwardRequest(
            {},
            fallback("brief", 0, "work", options.capabilities),
            options.capabilities,
            key,
            "http://127.0.0.1",
            async () => {
                called = true;

                throw new Error("unexpected");
            },
        );
    }

    assert.equal(called, false);
});

test("missing decision credentials skip the Jev request", async () => {
    let called = false;
    const result = await import("./jev-auto.ts").then(({ askJev }) =>
        askJev("brief", 0, options, "", async () => {
            called = true;

            throw new Error("unexpected");
        }),
    );

    assert.equal(result, undefined);
    assert.equal(called, false);
});

test("Jev timeout uses the deterministic fallback at the caller", async () => {
    const { askJev } = await import("./jev-auto.ts");
    const result = await askJev("brief", 0, options, "test-only", async (_url, init) => {
        assert.equal(init?.signal instanceof AbortSignal, true);
        await new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), {
                once: true,
            }),
        );

        throw new Error("timeout");
    });

    assert.equal(result, undefined);
    assert.equal(fallback("brief", 0, "work", options.capabilities).source, "rules");
});
