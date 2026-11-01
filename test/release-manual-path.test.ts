import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { githubRepository, repositoryOf } from "../src/server/updates.ts";
import { sha256File, verifyAsset, verifyForkReleaseManifest } from "../src/server/fork-release.ts";

const root = mkdtempSync(join(tmpdir(), "pocket-release-manual-"));

after(() => rmSync(root, { recursive: true, force: true }));

const manifest = {
    schema: 1 as const,
    repository: "phroggingphrog/pi-pocket" as const,
    tag: "v0.28.0",
    commit: "a".repeat(40),
    version: "0.28.0",
    assets: [
        { name: "source.tar.gz", bytes: 4, sha256: "b".repeat(64) },
        { name: "pi-pocket.tgz", bytes: 4, sha256: "c".repeat(64) },
    ],
};

test("release selection stays pinned to the owner fork and preserves package provenance", () => {
    const packageDir = join(root, "source");

    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
        join(root, "source", "package.json"),
        JSON.stringify({
            repository: { url: "git+https://github.com/phroggingphrog/pi-pocket.git" },
        }),
    );
    assert.equal(
        repositoryOf(join(root, "source")),
        "https://github.com/phroggingphrog/pi-pocket.git",
    );
    assert.deepEqual(githubRepository(repositoryOf(join(root, "source"))), {
        owner: "phroggingphrog",
        name: "pi-pocket",
    });
    assert.deepEqual(githubRepository("https://github.com/TannerMidd/pi-pocket.git"), {
        owner: "TannerMidd",
        name: "pi-pocket",
    });
});

test("release manifest selects exact commit, version, and unique fork assets", () => {
    assert.deepEqual(verifyForkReleaseManifest(manifest), manifest);
    assert.throws(
        () => verifyForkReleaseManifest({ ...manifest, repository: "TannerMidd/pi-pocket" }),
        /owner-fork/,
    );
    assert.throws(() => verifyForkReleaseManifest({ ...manifest, tag: "v0.29.0" }), /tag, version/);
    assert.throws(
        () =>
            verifyForkReleaseManifest({
                ...manifest,
                assets: [manifest.assets[0], manifest.assets[0]],
            }),
        /unique/,
    );
});

test("download artifacts pass byte-size and SHA256 verification before installation", async () => {
    const path = join(root, "manual-release.tgz");

    writeFileSync(path, "data");
    const sha256 = await sha256File(path);
    const item = { name: "manual-release.tgz", bytes: 4, sha256 };

    verifyAsset(item, readFileSync(path));
    assert.throws(
        () => verifyAsset({ ...item, sha256: "0".repeat(64) }, readFileSync(path)),
        /SHA256/,
    );
    assert.throws(() => verifyAsset({ ...item, bytes: 9 }, readFileSync(path)), /size/);
});
