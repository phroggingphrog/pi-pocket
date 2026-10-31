/** Jev Auto selects a configured model tier and a supported reasoning effort for each request. */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host, Web } from "../types/pocket.d.ts";

const PORT = Number(process.env.JEV_AUTO_PORT ?? 19878);
const UPSTREAM = process.env.JEV_AUTO_UPSTREAM ?? "http://127.0.0.1:20128/v1/chat/completions";
const JEV = "https://api.commandcode.ai/provider/v1/systemone";
const TIERS = ["cheap", "work", "hard"] as const;
const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type Tier = (typeof TIERS)[number];
type Effort = (typeof EFFORTS)[number];
type Decision = { tier: Tier; effort: Effort; source: "jev" | "rules"; why: string };
type Options = {
    minimumConfidence: number;
    timeoutMs: number;
    fallbackTier: Tier;
    capabilities: Record<Tier, Effort[]>;
};

/** Existing routes and their model identifiers remain unchanged. */
export const MODELS: Record<Tier, string> = {
    cheap: "openai/luna",
    work: "deepseek-flash",
    hard: "openai/terra",
};
const DEFAULT_CAPABILITIES: Record<Tier, Effort[]> = {
    cheap: ["low"],
    work: ["medium"],
    hard: ["high"],
};
const HARD =
    /\b(design|architect|architecture|review|audit|secur|prove|verify|debug|diagnos|plan|migrat|refactor|concurren|race|trade-?off)\b/i;
const MECHANICAL =
    /\b(rename|format|tidy|lint|list|count|grep|find|sort|move|copy|bump|changelog|summar(y|ise|ize)?)\b/i;

export function fallback(
    text: string,
    tools: number,
    tier: Tier,
    capabilities: Record<Tier, Effort[]>,
): Decision {
    const selected: Tier =
        HARD.test(text) || text.length > 4000
            ? "hard"
            : MECHANICAL.test(text) && text.length < 600 && tools < 6
              ? "cheap"
              : tier;
    const preferred: Effort =
        selected === "hard"
            ? "high"
            : selected === "cheap"
              ? "low"
              : tools > 8 || text.length > 1200
                ? "high"
                : "medium";

    return {
        tier: selected,
        effort: capabilities[selected].includes(preferred)
            ? preferred
            : (capabilities[selected][0] ?? "off"),
        source: "rules",
        why: "local rules",
    };
}

export function validateDecision(
    value: unknown,
    confidence: number,
    options: Options,
): Decision | undefined {
    if (confidence < options.minimumConfidence || value === null || typeof value !== "object") {
        return undefined;
    }

    const candidate = value as { tier?: unknown; effort?: unknown };

    if (!TIERS.includes(candidate.tier as Tier) || !EFFORTS.includes(candidate.effort as Effort)) {
        return undefined;
    }

    const tier = candidate.tier as Tier;
    const effort = candidate.effort as Effort;

    if (!options.capabilities[tier].includes(effort)) {
        return undefined;
    }

    return {
        tier,
        effort,
        source: "jev",
        why: `Jev selected ${tier} tier and ${effort} effort (${Math.round(confidence * 100)}% confidence)`,
    };
}

export function shapeForwarded(
    body: Record<string, unknown>,
    decision: Decision,
    capabilities: Record<Tier, Effort[]>,
) {
    const supported = capabilities[decision.tier].includes(decision.effort);
    const forwarded: Record<string, unknown> = { ...body, model: MODELS[decision.tier] };

    delete forwarded.thinking;
    delete forwarded.output_config;

    if (supported && decision.effort !== "off") {
        forwarded.reasoning_effort = decision.effort;
    } else {
        delete forwarded.reasoning_effort;
    }

    return { forwarded, effectiveEffort: supported ? decision.effort : ("off" as Effort) };
}

export function parseEfforts(value: unknown, fallbackValues: Effort[]): Effort[] {
    const values =
        typeof value === "string" ? value.split(",").map((each) => each.trim()) : fallbackValues;
    const valid = values.filter((each): each is Effort => EFFORTS.includes(each as Effort));

    return [...new Set(valid)];
}

export function readKey(file: string, name: string): string {
    try {
        return (
            readFileSync(file, "utf8")
                .split("\n")
                .map((line) => line.trim())
                .find((line) => line.startsWith(`${name}=`))
                ?.slice(name.length + 1)
                .replace(/^['"]|['"]$/g, "") ?? ""
        );
    } catch {
        return "";
    }
}

function lastWords(body: Record<string, unknown>): string {
    const messages = Array.isArray(body.messages)
        ? (body.messages as { role?: string; content?: unknown }[])
        : [];

    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];

        if (message?.role !== "user") {
            continue;
        }

        if (typeof message.content === "string") {
            return message.content;
        }

        if (Array.isArray(message.content)) {
            return message.content
                .map((item) =>
                    (item as { type?: string; text?: string }).type === "text"
                        ? ((item as { text?: string }).text ?? "")
                        : "",
                )
                .join(" ");
        }
    }

    return "";
}

function toolCount(body: Record<string, unknown>): number {
    return Array.isArray(body.tools) ? body.tools.length : 0;
}

export async function askJev(
    text: string,
    tools: number,
    options: Options,
    key: string,
    fetcher = fetch,
): Promise<Decision | undefined> {
    if (!key) {
        return undefined;
    }

    try {
        const answer = await fetcher(JEV, {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({
                model: "typesafe/jev",
                state: { request: text.slice(0, 4000), tool_count: tools },
                questions: {
                    tier: {
                        type: "choice",
                        instructions: "Which configured backend tier should answer?",
                        criteria: {
                            cheap: "small configured backend",
                            work: "working configured backend",
                            hard: "strongest configured backend",
                        },
                    },
                    effort: {
                        type: "choice",
                        instructions:
                            "Which supported reasoning effort should the selected backend use? This is a setting for the backend, not a claim that you supply the final reasoning.",
                        criteria: Object.fromEntries(
                            EFFORTS.map((effort) => [
                                effort,
                                `Use ${effort} reasoning effort when the selected backend supports it`,
                            ]),
                        ),
                    },
                },
            }),
            signal: AbortSignal.timeout(options.timeoutMs),
        });

        if (!answer.ok) {
            return undefined;
        }

        const data = (await answer.json()) as {
            answers?: {
                tier?: {
                    choice?: string;
                    confidence?: number;
                    probabilities?: Record<string, number>;
                };
                effort?: {
                    choice?: string;
                    confidence?: number;
                    probabilities?: Record<string, number>;
                };
            };
        };
        const tierAnswer = data.answers?.tier;
        const effortAnswer = data.answers?.effort;
        const confidence = Math.min(
            tierAnswer?.probabilities?.[tierAnswer.choice ?? ""] ?? tierAnswer?.confidence ?? 0,
            effortAnswer?.probabilities?.[effortAnswer?.choice ?? ""] ??
                effortAnswer?.confidence ??
                0,
        );

        return validateDecision(
            { tier: tierAnswer?.choice, effort: effortAnswer?.choice },
            confidence,
            options,
        );
    } catch {
        return undefined;
    }
}

export async function forwardRequest(
    body: Record<string, unknown>,
    decision: Decision,
    capabilities: Record<Tier, Effort[]>,
    key: string,
    upstream: string,
    fetcher = fetch,
): Promise<{ status: number; contentType: string; body: ReadableStream<Uint8Array> | null }> {
    const { forwarded } = shapeForwarded(body, decision, capabilities);
    const answer = await fetcher(upstream, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "text/event-stream, application/json",
            authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(forwarded),
    });

    return {
        status: answer.status,
        contentType: answer.headers.get("content-type") ?? "application/json",
        body: answer.body,
    };
}

export default function jevAuto(host: Host, web: Web): void {
    const options = (): Options => {
        const capabilities: Record<Tier, Effort[]> = {
            cheap: parseEfforts(web.setting("cheapEfforts"), DEFAULT_CAPABILITIES.cheap),
            work: parseEfforts(web.setting("workEfforts"), DEFAULT_CAPABILITIES.work),
            hard: parseEfforts(web.setting("hardEfforts"), DEFAULT_CAPABILITIES.hard),
        };

        return {
            minimumConfidence: Number(web.setting("minimumConfidence") ?? 0.5),
            timeoutMs: Number(web.setting("timeoutMs") ?? 4000),
            fallbackTier: (web.setting("fallbackTier") as Tier) || "work",
            capabilities,
        };
    };

    web.settings([
        {
            name: "minimumConfidence",
            label: "Minimum Jev confidence",
            type: "number",
            default: 0.5,
            min: 0,
            max: 1,
        },
        {
            name: "timeoutMs",
            label: "Jev timeout (milliseconds)",
            type: "number",
            default: 4000,
            min: 250,
            max: 15000,
        },
        {
            name: "fallbackTier",
            label: "Fallback backend tier",
            type: "choice",
            default: "work",
            choices: [
                { value: "cheap", label: "Cheap" },
                { value: "work", label: "Work" },
                { value: "hard", label: "Hard" },
            ],
        },
        ...(["cheapEfforts", "workEfforts", "hardEfforts"] as const).map((name, index) => ({
            name,
            label: `${TIERS[index]} tier supported reasoning efforts`,
            description:
                "Comma-separated supported levels: off, minimal, low, medium, high, xhigh, max.",
            type: "text" as const,
            default: DEFAULT_CAPABILITIES[TIERS[index]].join(","),
        })),
    ]);
    const records: {
        source: string;
        backend: string;
        requestedEffort: string;
        effectiveEffort: string;
    }[] = [];
    let listening = false;
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];

        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", async () => {
            let body: Record<string, unknown>;

            try {
                body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
                    string,
                    unknown
                >;
            } catch {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { message: "Jev Auto reads JSON only." } }));

                return;
            }

            const settings = options();
            const text = lastWords(body);
            const decision =
                (await askJev(
                    text,
                    toolCount(body),
                    settings,
                    readKey(join(homedir(), ".pi-pocket", "commandcode.env"), "COMMAND_CODE_KEY"),
                )) ?? fallback(text, toolCount(body), settings.fallbackTier, settings.capabilities);
            const { forwarded, effectiveEffort } = shapeForwarded(
                body,
                decision,
                settings.capabilities,
            );

            records.push({
                source: decision.source,
                backend: MODELS[decision.tier],
                requestedEffort: decision.effort,
                effectiveEffort,
            });

            if (records.length > 40) {
                records.shift();
            }

            const key =
                process.env.JEV_AUTO_KEY ||
                readKey(join(homedir(), ".pi-pocket", "jev-auto.env"), "OMNIROUTE_KEY") ||
                readKey(join(homedir(), ".pi-pocket", "omniroute.env"), "OMNIROUTE_KEY");

            if (!key) {
                response.writeHead(503, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        error: { message: "Jev Auto has no configured upstream key." },
                    }),
                );

                return;
            }

            try {
                const answer = await forwardRequest(
                    body,
                    decision,
                    settings.capabilities,
                    key,
                    UPSTREAM,
                );

                response.writeHead(answer.status, {
                    "content-type": answer.contentType,
                    "cache-control": "no-store",
                });

                if (answer.contentType.includes("text/event-stream") && answer.body) {
                    await answer.body.pipeTo(
                        new WritableStream({
                            write(chunk) {
                                response.write(Buffer.from(chunk));
                            },
                            close() {
                                response.end();
                            },
                        }),
                    );
                } else {
                    response.end(answer.body ? await new Response(answer.body).text() : "");
                }
            } catch {
                response.writeHead(502, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        error: { message: "Jev Auto could not reach the configured upstream." },
                    }),
                );
            }
        });
    });

    server.on("error", () => {
        listening = false;
    });
    server.listen(PORT, "127.0.0.1", () => {
        listening = true;
    });
    web.onDispose(() => server.close());
    web.onDispose(
        host.registerModelProvider("jev", {
            name: "Jev Auto",
            baseUrl: `http://127.0.0.1:${PORT}/v1`,
            api: "openai-completions",
            apiKey: "jev-auto",
            models: [
                {
                    id: "auto",
                    name: "Jev Auto",
                    input: ["text", "image"],
                    contextWindow: 200000,
                    maxTokens: 32000,
                    reasoning: true,
                    thinkingLevelMap: {
                        off: "none",
                        minimal: "minimal",
                        low: "low",
                        medium: "medium",
                        high: "high",
                        xhigh: "xhigh",
                        max: "max",
                    },
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
            ],
        }),
    );
    web.route("GET", "auto", async () => ({
        listening,
        port: PORT,
        upstream: new URL(UPSTREAM).host,
        decisions: records.slice(-10),
    }));
}
