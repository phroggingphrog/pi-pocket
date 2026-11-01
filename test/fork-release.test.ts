import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { sha256File, verifyAsset, verifyForkReleaseManifest } from "../src/server/fork-release.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-fork-release-"));

after(() => rmSync(root, { recursive: true, force: true }));

const base = {
    schema: 1 as const,
    repository: "phroggingphrog/pi-pocket" as const,
    tag: "v0.28.0",
    commit: "a".repeat(40),
    version: "0.28.0",
    assets: [
        { name: "pi-pocket-v0.28.0-source.tar.gz", bytes: 4, sha256: "b".repeat(64) },
        { name: "pi-pocket-v0.28.0.tgz", bytes: 4, sha256: "c".repeat(64) },
    ],
};

test("selects valid owner-fork release versions and rejects wrong repositories or mismatched tags", () => {
    assert.equal(verifyForkReleaseManifest(base).tag, "v0.28.0");
    assert.throws(
        () => verifyForkReleaseManifest({ ...base, repository: "TannerMidd/pi-pocket" }),
        /owner-fork/,
    );
    assert.throws(() => verifyForkReleaseManifest({ ...base, version: "0.27.0" }), /tag, version/);
    assert.throws(() => verifyForkReleaseManifest({ ...base, tag: "v0.28.0-beta" }), /owner-fork/);
});

test("verifies SHA256 and byte size for each release asset", async () => {
    const path = join(root, "asset.tgz");

    writeFileSync(path, "data");
    const digest = await sha256File(path);
    const asset = { name: "asset.tgz", bytes: 4, sha256: digest };

    verifyAsset(asset, readFileSync(path));
    assert.throws(
        () => verifyAsset({ ...asset, sha256: "d".repeat(64) }, readFileSync(path)),
        /SHA256/,
    );
    assert.throws(() => verifyAsset({ ...asset, bytes: 5 }, readFileSync(path)), /size/);
});

test("manifest rejects duplicate, path-bearing, empty, and malformed assets", () => {
    assert.throws(
        () => verifyForkReleaseManifest({ ...base, assets: [base.assets[0], base.assets[0]] }),
        /unique/,
    );
    assert.throws(
        () =>
            verifyForkReleaseManifest({
                ...base,
                assets: [{ ...base.assets[0], name: "../escape" }, base.assets[1]],
            }),
        /base names/,
    );
    assert.throws(() => verifyForkReleaseManifest({ ...base, assets: [] }), /list release assets/);
    assert.throws(
        () =>
            verifyForkReleaseManifest({
                ...base,
                assets: [{ ...base.assets[0], sha256: "not-a-checksum" }, base.assets[1]],
            }),
        /invalid size or checksum/,
    );
});
