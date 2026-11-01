/** Optional Foreman supervision for conversations that the owner selects. */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
    AgentDoc,
    defineDoc,
    defineExtension,
    GenerationTask,
    hook,
    LiveDoc,
    ToolTask,
    type Extension,
    type HookApi,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { awaitWithContext, withoutAbortSignal } from "@earendil-works/chord/context";
import type { ExtensionWeb, PocketHost } from "../host.ts";

const NAME = "foreman";
const LIMIT_BYTES = 24_000;
const MAX_OUTPUT = 8_192;
const MAX_TEXT = 4_000;
const MAX_CONTINUATIONS = 2;
const MAX_REQUESTS = 20;
const TIMEOUT_MS = 15_000;

export const ForemanControl = defineDoc<{
    workId: string;
    halt: string;
    continuations: number;
    requests: number;
}>({
    kind: "pocket.foreman.control",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ workId: "", halt: "", continuations: 0, requests: 0 }),
    checkpointWhen: () => true,
});

type Outcome = {
    action?: "allow" | "inject_context" | "block" | "halt";
    reason?: string;
    system_message?: string;
};
type Payload = {
    session_id: string;
    cwd: string;
    work_id?: string;
    event_id?: string;
    continuation_active?: boolean;
    event: Record<string, unknown>;
};
const bound = (value: unknown, max = MAX_TEXT) =>
    typeof value === "string" ? value.slice(0, max) : "";

function text(value: unknown): string {
    if (typeof value === "string") {
        return bound(value);
    }

    return Array.isArray(value)
        ? bound(
              value
                  .filter((part) => part?.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
          )
        : "";
}

function explain(result: Outcome): string {
    return bound(result.system_message ?? result.reason ?? "Foreman halted supervised work", 1_000);
}

function parse(value: unknown): Outcome {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid Foreman response");
    }

    const row = value as Record<string, unknown>;

    if (Object.keys(row).some((key) => !["action", "reason", "system_message"].includes(key))) {
        throw new Error("Invalid Foreman response");
    }

    if (
        row.action !== undefined &&
        !["allow", "inject_context", "block", "halt"].includes(String(row.action))
    ) {
        throw new Error("Invalid Foreman action");
    }

    if (
        [row.reason, row.system_message].some(
            (item) => item !== undefined && typeof item !== "string",
        )
    ) {
        throw new Error("Invalid Foreman response");
    }

    return row as Outcome;
}

export function foremanTransport(
    payload: Payload,
    executable: string,
    dataDir: string,
    signal?: AbortSignal,
): Promise<Outcome> {
    const input = JSON.stringify(payload);

    if (Buffer.byteLength(input) > LIMIT_BYTES) {
        return Promise.reject(new Error("Foreman evidence exceeds the request limit"));
    }

    return new Promise((resolveResult, reject) => {
        const child = spawn(executable, ["hook", "--client", "pi-durable", "--data-dir", dataDir], {
            cwd: payload.cwd,
            stdio: ["pipe", "pipe", "ignore"],
            env: {
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                HOME: homedir(),
                FOREMAN_DATA_DIR: dataDir,
                FOREMAN_DECISION_PROVIDER: String(payload.event.assessment_provider),
                FOREMAN_DECISION_MODEL: String(payload.event.assessment_model),
            },
        });
        let output = "";
        let settled = false;
        const timer = setTimeout(
            () => finish(new Error("Foreman assessment timed out")),
            TIMEOUT_MS,
        );
        const abort = () => finish(new Error("Foreman assessment cancelled"));

        const finish = (error?: Error, result?: Outcome) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);

            if (error) {
                child.kill("SIGKILL");
                reject(error);
            } else {
                resolveResult(result!);
            }
        };

        child.on("error", () => finish(new Error("Foreman executable could not start")));
        child.stdin.on("error", () => finish(new Error("Foreman input failed")));
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            output += chunk;

            if (Buffer.byteLength(output) > MAX_OUTPUT) {
                finish(new Error("Foreman response exceeds the output limit"));
            }
        });
        child.on("close", (code) => {
            if (settled) {
                return;
            }

            if (code !== 0) {
                return finish(new Error("Foreman assessment failed"));
            }

            try {
                finish(undefined, parse(JSON.parse(output)));
            } catch {
                finish(new Error("Invalid Foreman response"));
            }
        });
        signal?.addEventListener("abort", abort, { once: true });

        if (signal?.aborted) {
            abort();
        } else {
            child.stdin.end(input);
        }
    });
}

function configuration(web: ExtensionWeb) {
    const provider = web.setting("provider");
    const model = web.setting("model");
    const folder = web.setting("dataDirectory");
    const executable = web.setting("executable");

    if (
        (provider !== "jev" && provider !== "openai") ||
        typeof model !== "string" ||
        !model.trim()
    ) {
        throw new Error("Set the Foreman assessment provider and model first");
    }

    if (typeof folder !== "string" || !folder.trim()) {
        throw new Error("Set the Foreman data directory first");
    }

    return {
        provider,
        model: model.trim(),
        dataDir: resolve(folder.startsWith("~/") ? folder.replace(/^~/, homedir()) : folder),
        executable:
            typeof executable === "string" && executable.trim() ? executable.trim() : "foreman",
    };
}

async function selected(api: HookApi, context: Context): Promise<boolean> {
    const state = await api.snapshot(AgentDoc, api.conversationId, context);
    const extensions = state?.extensions;

    return Array.isArray(extensions)
        ? extensions.includes(NAME)
        : extensions?.add?.includes(NAME) === true && extensions.remove?.includes(NAME) !== true;
}

async function halt(
    host: PocketHost,
    api: HookApi,
    context: Context,
    reason: string,
): Promise<never> {
    const abort = host.durableHarness().abortTask(api.taskId, withoutAbortSignal(context));

    try {
        await awaitWithContext(abort, context);
    } catch (error) {
        if (!context.abortSignal?.aborted) {
            throw error;
        }
    }

    throw new Error(bound(reason, 1_000));
}

async function assess(
    host: PocketHost,
    web: ExtensionWeb,
    assessment: ForemanAssessment,
    api: HookApi,
    context: Context,
    event: Record<string, unknown>,
): Promise<Outcome> {
    if (!(await selected(api, context))) {
        return { action: "allow" };
    }

    const settings = configuration(web);
    const live = await api.snapshot(LiveDoc, api.conversationId, context);

    if (!live?.run?.inputs.length) {
        throw new Error("Foreman cannot identify durable run input");
    }

    const workId = JSON.stringify(live.run.inputs);
    let state = await api.snapshot(ForemanControl, api.conversationId, context);

    if (state?.workId !== workId) {
        const conversation = await host.durableHarness().conversation(api.conversationId, context);

        if (!conversation) {
            throw new Error("Foreman cannot read durable conversation");
        }

        await conversation.commit(async (tx) => {
            const control = await tx.doc(ForemanControl, api.conversationId);

            control.workId = workId;
            control.halt = "";
            control.continuations = 0;
            control.requests = 0;
        }, context);
        state = { workId, halt: "", continuations: 0, requests: 0 };
    }

    if (state?.halt) {
        return halt(host, api, context, state.halt);
    }

    if ((state?.requests ?? 0) >= MAX_REQUESTS) {
        throw new Error("Foreman assessment limit reached");
    }

    const conversation = await host.durableHarness().conversation(api.conversationId, context);

    if (!conversation) {
        throw new Error("Foreman cannot read durable conversation");
    }

    const prompts: string[] = [];

    for (const submissionId of live.run.inputs) {
        const submission = await host.durableHarness().submission(submissionId, context);
        const status = await submission?.status(context);

        if (!status?.entry) {
            throw new Error("Foreman cannot read submitted work");
        }

        const page = await conversation.entries(
            { minEntryId: status.entry, maxEntryId: status.entry },
            1,
            undefined,
            context,
        );
        const prompt = page.items[0]?.model
            ?.filter((item) => item.role === "user")
            .map((item) => text(item.content))
            .join("\n");

        if (!prompt?.trim()) {
            throw new Error("Foreman requires a text work prompt");
        }

        prompts.push(prompt);
    }

    const agent = await api.snapshot(AgentDoc, api.conversationId, context);
    const envelope: Payload = {
        session_id: JSON.stringify([resolve(host.dataDir), api.conversationId]),
        cwd: agent?.cwd ?? process.cwd(),
        work_id: workId,
        ...(event.type === "onYield" ? { event_id: `onYield:${String(api.taskId)}` } : {}),
        continuation_active: event.type === "onYield" || (state?.continuations ?? 0) > 0,
        event: {
            ...event,
            assessment_provider: settings.provider,
            assessment_model: settings.model,
            ...(event.type === "beforeRequest" ? { prompt: prompts.join("\n\n") } : {}),
        },
    };

    if (Buffer.byteLength(JSON.stringify(envelope)) > LIMIT_BYTES) {
        throw new Error("Foreman evidence exceeds the request limit");
    }

    const memo = `pocket.foreman.${String(event.type)}.${String(api.taskId)}`;
    let result = await api.memo<Outcome>(memo, context);

    if (!result) {
        await conversation.commit(async (tx) => {
            (await tx.doc(ForemanControl, api.conversationId)).requests += 1;
        }, context);
        const response = await assessment(
            envelope,
            settings.executable,
            settings.dataDir,
            context.abortSignal,
        );

        await conversation.commit(async (tx) => {
            const control = await tx.doc(ForemanControl, api.conversationId);

            if (response.action === "halt" || response.action === "block") {
                control.halt = explain(response);
            }
        }, context);
        result = await api.memo(memo, response, context);
    }

    return result ?? { action: "halt", reason: "Foreman assessment returned no result" };
}

export type ForemanAssessment = (
    payload: Payload,
    executable: string,
    dataDir: string,
    signal?: AbortSignal,
) => Promise<Outcome>;

export default function createForeman(
    host: PocketHost,
    web: ExtensionWeb,
    assessmentProvider: ForemanAssessment = foremanTransport,
) {
    let extension: Extension;

    web.settings([
        {
            name: "executable",
            label: "Foreman executable",
            type: "text",
            default: "foreman",
            placeholder: "foreman",
        },
        {
            name: "dataDirectory",
            label: "Foreman data directory",
            type: "text",
            placeholder: "~/.foreman",
        },
        {
            name: "provider",
            label: "Assessment provider",
            type: "choice",
            choices: [
                { value: "jev", label: "Jev" },
                { value: "openai", label: "OpenAI Decisions" },
            ],
        },
        {
            name: "model",
            label: "Assessment model",
            type: "text",
            placeholder: "Provider model ID",
        },
    ]);
    web.command("foreman-session", {
        description: "Select or deselect Foreman for this conversation.",
        args: "<on|off>",
        scope: "conversation",
        handler: async (args, command) => {
            const on = args.trim() === "on";

            if (!on && args.trim() !== "off") {
                return {
                    type: "toast",
                    level: "error",
                    message: "Use /foreman on or /foreman off.",
                };
            }

            if (on) {
                try {
                    configuration(web);
                } catch (error) {
                    return {
                        type: "toast",
                        level: "error",
                        message:
                            error instanceof Error ? error.message : "Foreman settings are invalid",
                    };
                }
            }

            const conversation = await host
                .durableHarness()
                .conversation(command.conversationId, command.context);

            if (!conversation) {
                return { type: "toast", level: "error", message: "Session does not exist." };
            }

            const current = await host
                .durableHarness()
                .snapshot(AgentDoc, command.conversationId, command.context);
            const selection = current?.extensions;
            const baseline = host.defaultExtensionNames();
            const names = Array.isArray(selection)
                ? selection.filter((name) => name !== NAME)
                : (selection?.add ?? []);
            const excluded = Array.isArray(selection) ? [] : (selection?.remove ?? []);

            await conversation.commit(async (tx) => {
                const agent = await tx.doc(AgentDoc, command.conversationId);

                agent.extensions = on
                    ? {
                          add: [...new Set([...baseline, ...names, NAME])],
                          remove: excluded.filter((name) => name !== NAME),
                      }
                    : {
                          add: [...new Set([...baseline, ...names])],
                          remove: [...new Set([...excluded, NAME])],
                      };
            }, command.context);

            return {
                type: "toast",
                level: "info",
                message: on
                    ? "Foreman selected for this conversation."
                    : "Foreman not selected for this conversation.",
            };
        },
    });
    extension = defineExtension({
        name: NAME,
        hooks: [
            hook(GenerationTask, {
                beforeRequest: async (request, api, context) => {
                    try {
                        const result = await assess(host, web, assessmentProvider, api, context, {
                            type: "beforeRequest",
                            prompt: request.messages
                                .filter((item) => item.role === "user")
                                .map((item) => text(item.content))
                                .join("\n\n"),
                        });

                        if (result.action === "block" || result.action === "halt") {
                            return halt(host, api, context, explain(result));
                        }

                        if (result.action === "inject_context") {
                            return {
                                messages: [
                                    ...request.messages,
                                    {
                                        role: "user",
                                        content: `[Foreman]\n${explain(result)}`,
                                    } as import("@earendil-works/pi-ai").UserMessage,
                                ],
                            };
                        }
                    } catch (error) {
                        return halt(
                            host,
                            api,
                            context,
                            error instanceof Error ? error.message : "Foreman assessment failed",
                        );
                    }
                },
                onYield: async (answer, api, context) => {
                    try {
                        let result = await api.memo<Outcome>(
                            `foreman.yield.${String(api.taskId)}`,
                            context,
                        );

                        if (!result) {
                            result = await assess(host, web, assessmentProvider, api, context, {
                                type: "onYield",
                                last_assistant_message: text(answer.content),
                            });
                            await api.memo(`foreman.yield.${String(api.taskId)}`, result, context);
                        }

                        if (result.action === "halt") {
                            return halt(host, api, context, explain(result));
                        }

                        if (result.action === "block" || result.action === "inject_context") {
                            const state = await api.snapshot(
                                ForemanControl,
                                api.conversationId,
                                context,
                            );
                            const memo = `foreman.continuation.${String(api.taskId)}.${String(result.action)}`;
                            const continued = await api.memo<string>(memo, context);

                            if (continued) {
                                return { continue: continued };
                            }

                            if ((state?.continuations ?? 0) >= MAX_CONTINUATIONS) {
                                return halt(
                                    host,
                                    api,
                                    context,
                                    "Foreman continuation limit reached",
                                );
                            }

                            const conversation = await host
                                .durableHarness()
                                .conversation(api.conversationId, context);

                            if (conversation) {
                                await conversation.commit(async (tx) => {
                                    (
                                        await tx.doc(ForemanControl, api.conversationId)
                                    ).continuations += 1;
                                }, context);
                            }

                            await api.memo(memo, explain(result), context);

                            return { continue: explain(result) };
                        }
                    } catch (error) {
                        return halt(
                            host,
                            api,
                            context,
                            error instanceof Error ? error.message : "Foreman assessment failed",
                        );
                    }
                },
                afterTools: async (_assistant, _results, api, context) => {
                    const state = await api.snapshot(ForemanControl, api.conversationId, context);

                    if (state?.halt) {
                        return halt(host, api, context, state.halt);
                    }
                },
            }),
            hook(ToolTask, {
                beforeTool: async (call, api, context) => {
                    const state = await api.snapshot(ForemanControl, api.conversationId, context);

                    if (state?.halt) {
                        return { block: state.halt };
                    }

                    const result = await assess(host, web, assessmentProvider, api, context, {
                        type: "beforeTool",
                        call,
                    });

                    if (result.action === "halt" || result.action === "block") {
                        const conversation = await host
                            .durableHarness()
                            .conversation(api.conversationId, context);

                        if (conversation) {
                            await conversation.commit(async (tx) => {
                                (await tx.doc(ForemanControl, api.conversationId)).halt =
                                    explain(result);
                            }, context);
                        }

                        return { block: explain(result) };
                    }

                    if (result.action === "inject_context") {
                        return {
                            block: `Foreman requests a correction before this tool runs: ${explain(result)}`,
                        };
                    }
                },
                afterTool: async (call, result, api, context) => {
                    let assessment: Outcome;

                    try {
                        assessment = await assess(host, web, assessmentProvider, api, context, {
                            type: "afterTool",
                            call,
                            result,
                        });
                    } catch (error) {
                        assessment = {
                            action: "halt",
                            reason:
                                error instanceof Error
                                    ? error.message
                                    : "Foreman assessment failed",
                        };
                    }

                    if (!assessment.action || assessment.action === "allow") {
                        return;
                    }

                    if (assessment.action === "inject_context") {
                        return {
                            ...result,
                            output: [
                                ...(result.output ?? []),
                                { type: "text", text: explain(assessment) },
                            ],
                        };
                    }

                    {
                        await host
                            .durableHarness()
                            .conversation(api.conversationId, context)
                            ?.then((conversation) =>
                                conversation?.commit(async (tx) => {
                                    (await tx.doc(ForemanControl, api.conversationId)).halt =
                                        explain(assessment);
                                }, context),
                            );
                    }

                    return {
                        ...result,
                        isError: true,
                        output: [
                            ...(result.output ?? []),
                            { type: "text", text: explain(assessment) },
                        ],
                        control: { ...result.control, terminate: true },
                    };
                },
            }),
        ],
    });

    return extension;
}
