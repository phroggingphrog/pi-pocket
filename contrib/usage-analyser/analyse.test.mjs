import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { analyse, refresh, reportLabel } from "./analyse.mjs";
import { catalogAliases } from "./usage-analyser.ts";

const temp = await mkdtemp(join(tmpdir(), "usage-alias-test-"));

after(() => rm(temp, { recursive: true, force: true }));

const event = (id, provider, model, input, output, cost, extra = {}) => ({
    k: "r",
    id,
    c: 1,
    s: 1_760_000_000_000 + id * 1000,
    d: 1000,
    ti: input,
    tr: 3,
    tw: 2,
    to: output,
    w1: 0,
    rs: 0,
    ci: cost,
    cr: 0,
    cw: 0,
    co: 0,
    ck: 1,
    m: model,
    p: provider,
    x: "stop",
    ...extra,
});

test("configured report aliases change labels, not provider namespace or token totals", () => {
    const cache = {
        version: 1,
        lastEntry: 0,
        lastConv: 0,
        owners: {},
        events: [
            event(1, "omni", "claude/sonnet", 100, 20, 0.25),
            event(2, "claude", "claude-sonnet-5-5", 100, 20, 0.25),
        ],
    };
    const aliases = {
        "omni/claude/sonnet": "Claude Sonnet",
        "claude/claude-sonnet-5-5": "Claude Sonnet",
    };
    const report = analyse(cache, { aliases });

    assert.equal(report.models.length, 2);
    assert.deepEqual(report.models.map((model) => [model.p, model.m]).sort(), [
        ["claude", "Claude Sonnet"],
        ["omni", "Claude Sonnet"],
    ]);
    assert.equal(
        report.models.reduce((sum, model) => sum + model.req, 0),
        2,
    );
    assert.equal(
        report.models.reduce((sum, model) => sum + model.to, 0),
        40,
    );
    assert.equal(report.totals.t.i, 200);
    assert.equal(report.totals.t.o, 40);
    assert.equal(report.totals.req, 2);
    assert.equal(report.totals.cost, 0.5);
});

test("unmapped identifiers keep their provider and model labels", () => {
    assert.equal(reportLabel("omni", "new-combo"), "new-combo");
    assert.equal(reportLabel("omni", "new-combo", { "other/new-combo": "Other" }), "new-combo");
});

test("catalog aliases use the catalog display labels and retain provider keys", () => {
    const aliases = catalogAliases((spec) => ({ name: `catalog:${spec}` }));

    assert.equal(aliases["omni/claude/opus"], "catalog:omni/claude/opus");
    assert.equal(aliases["omni/claude/sonnet"], "catalog:omni/claude/sonnet");
    assert.equal(aliases["omni/openai/sol"], "catalog:omni/openai/sol");
    assert.equal(aliases["claude/claude-sonnet-5-5"], undefined);
});

test("catalog aliases load first and explicit overrides win", async () => {
    const catalogPath = join(temp, "catalog-aliases.json");
    const overridesPath = join(temp, "override-aliases.json");

    await writeFile(catalogPath, JSON.stringify({ "omni/claude/sonnet": "Claude Sonnet" }));
    await writeFile(overridesPath, JSON.stringify({ "omni/claude/sonnet": "Sonnet Combo" }));
    const { readFile } = await import("node:fs/promises");
    const aliases = {
        ...JSON.parse(await readFile(catalogPath, "utf8")),
        ...JSON.parse(await readFile(overridesPath, "utf8")),
    };

    assert.equal(reportLabel("omni", "claude/sonnet", aliases), "Sonnet Combo");
});

test("two identifiers with one explicit alias aggregate once per request", () => {
    const cache = {
        version: 1,
        lastEntry: 0,
        lastConv: 0,
        owners: {},
        events: [
            event(1, "omni", "old-combo", 5, 2, 0.1),
            event(2, "omni", "custom-combo", 7, 3, 0.2),
        ],
    };
    const report = analyse(cache, {
        aliases: { "omni/old-combo": "Canonical", "omni/custom-combo": "Canonical" },
    });

    assert.equal(report.models.length, 1);
    assert.deepEqual(report.models[0].ids.sort(), ["custom-combo", "old-combo"]);
    assert.equal(report.models[0].req, 2);
    assert.equal(report.models[0].to, 5);
    assert.equal(report.totals.req, 2);
    assert.equal(report.totals.t.o, 5);
    assert.ok(Math.abs(report.models[0].cost - 0.3) < 1e-12);
});

test("provider namespaces do not collide when model names match", () => {
    const cache = {
        version: 1,
        lastEntry: 0,
        lastConv: 0,
        owners: {},
        events: [event(1, "omni", "shared", 5, 2, 0.1), event(2, "direct", "shared", 7, 3, 0.2)],
    };
    const report = analyse(cache, {
        aliases: { "omni/shared": "Shared label", "direct/shared": "Shared label" },
    });

    assert.deepEqual(report.models.map(({ p, m }) => [p, m]).sort(), [
        ["direct", "Shared label"],
        ["omni", "Shared label"],
    ]);
    assert.equal(report.models.length, 2);
    assert.equal(report.totals.req, 2);
});

test("missing usage cost remains unknown and aliases do not supply prices", () => {
    const cache = {
        version: 1,
        lastEntry: 0,
        lastConv: 0,
        owners: {},
        events: [event(1, "omni", "claude/sonnet", 11, 4, 0, { ck: 0 })],
    };
    const report = analyse(cache, { aliases: { "omni/claude/sonnet": "Claude Sonnet" } });

    assert.equal(report.models[0].cost, null);
    assert.equal(report.models[0].costKnown, false);
    assert.equal(report.totals.cost, null);
    assert.equal(report.totals.costKnown, false);
    assert.equal(report.days[0].cost, null);
    assert.equal(report.days[0].costKnown, false);
    assert.equal(report.sessions[0].cost, null);
    assert.equal(report.sessions[0].costKnown, false);
    assert.equal(report.models[0].req, 1);
    assert.equal(report.models[0].to, 4);
});

test("historical cached events keep their original identifiers and receive current labels", async () => {
    const dbPath = join(temp, "history.sqlite");
    const cachePath = join(temp, "cache.json");
    const aliasPath = join(temp, "aliases.json");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);

    db.exec(
        "CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER, record TEXT); CREATE TABLE conversations (id INTEGER PRIMARY KEY, record TEXT);",
    );
    const record = {
        kind: "pi.assistant",
        model: [
            {
                timestamp: 1_760_000_000_000,
                provider: "omni",
                model: "claude/sonnet",
                stopReason: "stop",
                durationMs: 1000,
                usage: {
                    input: 20,
                    output: 5,
                    cacheRead: 2,
                    cacheWrite: 1,
                    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
                },
            },
        ],
    };

    db.prepare("INSERT INTO entries VALUES (1, 1, ?)").run(JSON.stringify(record));
    db.close();
    await writeFile(aliasPath, JSON.stringify({ "omni/claude/sonnet": "Claude Sonnet" }));
    const historicalCache = await refresh(dbPath, cachePath, true);
    const original = historicalCache.events.find((item) => item.k === "r");
    const before = JSON.stringify(original);
    const report = analyse(historicalCache, {
        aliases: JSON.parse(await (await import("node:fs/promises")).readFile(aliasPath, "utf8")),
    });

    assert.equal(original.m, "claude/sonnet");
    assert.equal(original.p, "omni");
    assert.equal(JSON.stringify(original), before);
    assert.equal(report.models[0].m, "Claude Sonnet");
    assert.equal(report.models[0].p, "omni");
    assert.equal(report.models[0].to, 5);
    assert.ok(Math.abs(report.models[0].cost - 0.3) < 1e-12);
});
