import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type GatewayTask = {
    id: string;
    owner: string;
    idempotencyKey: string;
    conversationId: number;
    requestId: string;
    repositoryPath: string;
    prompt: string;
    submissionId?: number;
    status: string;
    createdAt: number;
};
export type OAuthClient = {
    client_id: string;
    client_secret?: string;
    client_secret_expires_at?: number;
    redirect_uris: string[];
    grant_types?: string[];
    response_types?: string[];
    token_endpoint_auth_method?: string;
    scope?: string;
};
type OAuthCode = {
    clientId: string;
    redirectUri: string;
    challenge: string;
    scopes: string[];
    resource: string;
    owner: string;
    expiresAt: number;
};
type OAuthToken = {
    clientId: string;
    owner: string;
    scopes: string[];
    resource: string;
    expiresAt: number;
};
type GatewayState = {
    clients: OAuthClient[];
    codes: Record<string, OAuthCode>;
    tokens: Record<string, OAuthToken>;
    tasks: GatewayTask[];
};
const blank = (): GatewayState => ({ clients: [], codes: {}, tokens: {}, tasks: [] });

export class StateStore {
    #state = blank();
    #path: string;
    #queue: Promise<void> = Promise.resolve();
    private constructor(path: string) {
        this.#path = path;
    }
    static async open(path: string): Promise<StateStore> {
        const store = new StateStore(path);

        await mkdir(dirname(path), { recursive: true, mode: 0o700 });

        try {
            const parsed = JSON.parse(await readFile(path, "utf8")) as GatewayState;

            if (
                !parsed ||
                !Array.isArray(parsed.tasks) ||
                !Array.isArray(parsed.clients) ||
                typeof parsed.codes !== "object" ||
                typeof parsed.tokens !== "object"
            ) {
                throw new Error("Invalid state");
            }

            store.#state = parsed;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw new Error("Gateway state is invalid; refusing to overwrite it.");
            }
        }

        return store;
    }
    async #save() {
        const temp = `${this.#path}.${randomUUID()}.tmp`;

        await writeFile(temp, JSON.stringify(this.#state), { mode: 0o600, flag: "wx" });
        await rename(temp, this.#path);
    }
    #mutate<T>(fn: () => T): Promise<T> {
        const run = this.#queue.then(async () => {
            const value = fn();

            await this.#save();

            return value;
        });

        this.#queue = run.then(
            () => {},
            () => {},
        );

        return run;
    }
    async flush() {
        await this.#queue;
    }
    client(id: string) {
        return this.#state.clients.find((item) => item.client_id === id);
    }
    async addClient(client: OAuthClient) {
        await this.#mutate(() => {
            if (!this.client(client.client_id)) {
                this.#state.clients.push(client);
            }
        });
    }
    code(id: string) {
        return this.#state.codes[id];
    }
    async putCode(id: string, data: OAuthCode) {
        await this.#mutate(() => {
            this.#state.codes[id] = data;
        });
    }
    async takeCode(id: string) {
        let found: OAuthCode | undefined;

        await this.#mutate(() => {
            found = this.#state.codes[id];
            delete this.#state.codes[id];
        });

        return found;
    }
    token(id: string) {
        return this.#state.tokens[id];
    }
    async putToken(id: string, data: OAuthToken) {
        await this.#mutate(() => {
            this.#state.tokens[id] = data;
        });
    }
    async revoke(id: string) {
        await this.#mutate(() => {
            delete this.#state.tokens[id];
        });
    }
    taskByIdempotency(owner: string, key: string) {
        return this.#state.tasks.find(
            (task) => task.owner === owner && task.idempotencyKey === key,
        );
    }
    task(id: string, owner: string) {
        return this.#state.tasks.find((task) => task.id === id && task.owner === owner);
    }
    tasks(owner: string) {
        return this.#state.tasks.filter((task) => task.owner === owner);
    }
    async addTask(task: GatewayTask) {
        return this.#mutate(() => {
            if (this.taskByIdempotency(task.owner, task.idempotencyKey)) {
                throw new Error("Duplicate idempotency key.");
            }

            this.#state.tasks.push(task);
        });
    }
    async updateTask(id: string, owner: string, update: Partial<GatewayTask>) {
        await this.#mutate(() => {
            const found = this.task(id, owner);

            if (!found) {
                throw new Error("Task not found.");
            }

            Object.assign(found, update);
        });
    }
    async recoverTasks(recover: (task: GatewayTask) => Promise<void>) {
        for (const task of [...this.#state.tasks]) {
            if (["creating", "submitting", "submission_uncertain"].includes(task.status)) {
                await recover({ ...task });
            }
        }
    }
}
