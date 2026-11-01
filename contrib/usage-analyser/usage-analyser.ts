/**
 * Usage analyser (experimental): token, cost, cache and time findings; ideas for other analyses are welcome. An
 * owner-only page runs a child process that reads Pi Pocket records, never keeps or shows message text, and stores
 * a cache in <data>/usage-analyser/. Ask PiP sends findings to PiP. sessions() is experimental; /pip.js and the
 * pocket.sqlite record shapes are internal and can change in any release. The analyser makes no network requests;
 * PiP may send findings to its model provider.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Host, Web } from "./_pocket.d.ts";

const RANGES = new Set(["7", "30", "90", "0"]);
const MODEL_SPECS = [
    "omni/claude/opus",
    "omni/claude/sonnet",
    "omni/claude/haiku",
    "omni/openai/sol",
    "omni/openai/luna",
    "omni/openai/terra",
    "omni/glm-flash",
    "omni/muse-spark-contributor",
    "omni/deepseek-flash",
    "omni/xiaomi-mimo-pro",
];

export function catalogAliases(modelInfo: (spec: string) => { name: string } | undefined) {
    const aliases: Record<string, string> = {};

    for (const spec of MODEL_SPECS) {
        const info = modelInfo(spec);

        if (info) {
            aliases[spec] = info.name;
        }
    }

    return aliases;
}

export default function createUsageAnalyser(host: Host, web: Web) {
    const core = join(import.meta.dirname, "usage-analyser", "analyse.mjs");
    const db = join(host.dataDir, "pocket.sqlite");
    const cache = join(host.dataDir, "usage-analyser", "cache.json");
    const aliasConfig = join(host.dataDir, "usage-analyser", "catalog-aliases.json");
    const aliasOverrides = join(host.dataDir, "usage-analyser", "aliases.json");
    const aliases = catalogAliases(host.modelInfo);

    async function run(days: string, signal: AbortSignal) {
        await mkdir(join(host.dataDir, "usage-analyser"), { recursive: true, mode: 0o700 });
        await writeFile(aliasConfig, JSON.stringify(aliases), { mode: 0o600 });

        return new Promise<any>((resolve, reject) => {
            const range = days === "0" ? ["--all"] : ["--days", days];

            execFile(
                process.execPath,
                [
                    "--no-warnings",
                    core,
                    ...range,
                    "--json",
                    "--db",
                    db,
                    "--cache",
                    cache,
                    "--aliases",
                    aliasConfig,
                    "--alias-overrides",
                    aliasOverrides,
                ],
                {
                    maxBuffer: 64 * 1024 * 1024,
                    timeout: 120_000,
                    signal,
                    env: { HOME: process.env.HOME },
                },
                (error, stdout, stderr) => {
                    if (error) {
                        reject(new Error(stderr || error.message));

                        return;
                    }

                    try {
                        resolve(JSON.parse(stdout));
                    } catch (failure) {
                        reject(failure);
                    }
                },
            );
        });
    }

    web.route("GET", "report", async ({ query, sessions, signal }) => {
        const days = query.get("days") ?? "30";

        if (!RANGES.has(days)) {
            throw web.error(400, "days must be 7, 30, 90 or 0");
        }

        const report = await run(days, signal);
        const known = new Map(sessions().map((each) => [each.id, each]));
        const name = (id: number) => known.get(id)?.title || `#${id}`;

        for (const each of report.sessions) {
            each.title = name(each.id);
            each.archived = known.get(each.id)?.archived ?? false;
        }

        for (const tip of report.tips) {
            for (const each of tip.sessions) {
                each.title = name(each.id);
                each.quotedTitle = host.text.quoted(each.title, 80);
                each.quotedDetail = host.text.quoted(each.detail, 160);
            }
        }

        // Quote the executable path for a shell, including data folders that contain spaces or quotes.
        report.command = `node '${core.replaceAll("'", "'\\''")}' ${days === "0" ? "--all" : `--days ${days}`} --json --db '${db.replaceAll("'", "'\\''")}' --cache '${cache.replaceAll("'", "'\\''")}' --aliases '${aliasConfig.replaceAll("'", "'\\''")}' --alias-overrides '${aliasOverrides.replaceAll("'", "'\\''")}'`;

        return report;
    });

    web.client("usage-analyser");
}
