/** Aggregate cache observations from committed assistant entries and cache-keeper requests. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    AssistantEntry,
    defineDoc,
    type CommitPublication,
    type ConversationId,
    type Harness,
} from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export type CacheObservation = {
    id: string;
    at: number;
    source: "response" | "refresh";
    outcome: string;
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

export const CacheTelemetryDoc = defineDoc<{ observations: CacheObservation[] }>({
    kind: "x.cache-diagnostics.observations",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    checkpointWhen: () => false,
    initial: () => ({ observations: [] }),
});

export function observation(
    id: string,
    source: CacheObservation["source"],
    message: AssistantMessage,
): CacheObservation {
    const u = message.usage;

    return {
        id,
        source,
        at: message.timestamp,
        outcome: message.stopReason,
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
        costInput: u.cost.input,
        costOutput: u.cost.output,
        costRead: u.cost.cacheRead,
        costWrite: u.cost.cacheWrite,
        costTotal: u.cost.total,
    };
}

/** A publication is already committed; the observation commit can lag or fail independently. */
export class CacheTelemetry {
    readonly #harness: Harness;
    readonly #log: (line: string) => void;
    #pending: Promise<void> = Promise.resolve();

    constructor(harness: Harness, log: (line: string) => void) {
        this.#harness = harness;
        this.#log = log;
    }

    committed(publication: CommitPublication): void {
        for (const change of publication.changes) {
            if (change.type !== "entry" || !AssistantEntry.is(change.value)) {
                continue;
            }

            const message = change.value.model?.[0];

            if (message?.role !== "assistant" || !message.usage) {
                continue;
            }

            this.record(
                change.value.conversationId,
                observation(String(change.value.id), "response", message),
            );
        }
    }

    record(id: ConversationId, item: CacheObservation): void {
        this.#pending = this.#pending
            .then(async () => {
                await this.#harness.commit(async (tx) => {
                    const doc = await tx.doc(CacheTelemetryDoc, id);

                    if (
                        doc.observations.some(
                            (existing) =>
                                existing.id === item.id && existing.source === item.source,
                        )
                    ) {
                        return;
                    }

                    doc.observations.push(item);

                    if (doc.observations.length > 100) {
                        doc.observations.splice(0, doc.observations.length - 100);
                    }
                }, BACKGROUND_CONTEXT);
            })
            .catch((error: unknown) =>
                this.#log(
                    `Cache telemetry not stored: ${error instanceof Error ? error.message : String(error)}`,
                ),
            );
    }

    async close(): Promise<void> {
        await this.#pending;
    }
}
