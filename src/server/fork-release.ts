import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";

export type ForkReleaseManifest = {
    schema: 1;
    repository: "phroggingphrog/pi-pocket";
    tag: string;
    commit: string;
    version: string;
    assets: { name: string; bytes: number; sha256: string }[];
};

const TAG = /^v(\d+\.\d+\.\d+(?:-beta\.\d+)?)$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function verifyForkReleaseManifest(value: unknown): ForkReleaseManifest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Release manifest must be an object");
    }

    const manifest = value as Partial<ForkReleaseManifest>;
    const match = typeof manifest.tag === "string" ? TAG.exec(manifest.tag) : null;

    if (manifest.schema !== 1 || manifest.repository !== "phroggingphrog/pi-pocket" || !match) {
        throw new Error("Release manifest must identify a valid owner-fork release");
    }

    if (
        manifest.version !== match[1] ||
        typeof manifest.commit !== "string" ||
        !COMMIT.test(manifest.commit)
    ) {
        throw new Error("Release tag, version, or commit does not match the manifest contract");
    }

    if (!Array.isArray(manifest.assets) || manifest.assets.length < 2) {
        throw new Error("Release manifest must list release assets");
    }

    const names = new Set<string>();

    for (const asset of manifest.assets) {
        if (
            !asset ||
            typeof asset.name !== "string" ||
            asset.name !== basename(asset.name) ||
            names.has(asset.name)
        ) {
            throw new Error("Release asset names must be unique base names");
        }

        if (
            !Number.isSafeInteger(asset.bytes) ||
            asset.bytes < 1 ||
            typeof asset.sha256 !== "string" ||
            !SHA256.test(asset.sha256)
        ) {
            throw new Error(`Release asset ${asset.name} has invalid size or checksum`);
        }

        names.add(asset.name);
    }

    return manifest as ForkReleaseManifest;
}

export async function sha256File(path: string): Promise<string> {
    const hash = createHash("sha256");

    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
    }

    return hash.digest("hex");
}

export function verifyAsset(
    metadata: ForkReleaseManifest["assets"][number],
    bytes: Uint8Array,
): void {
    if (bytes.byteLength !== metadata.bytes) {
        throw new Error(`Release asset ${metadata.name} has the wrong size`);
    }

    const digest = createHash("sha256").update(bytes).digest("hex");

    if (digest !== metadata.sha256) {
        throw new Error(`Release asset ${metadata.name} failed SHA256 verification`);
    }
}
