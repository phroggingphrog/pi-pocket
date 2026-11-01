import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const tag = process.env.RELEASE_TAG;
const commit = process.env.RELEASE_REVISION;
const output = resolve(process.env.RELEASE_OUTPUT ?? "release-artifacts");
const tagMatch = typeof tag === "string" ? /^v(\d+\.\d+\.\d+(?:-beta\.\d+)?)$/.exec(tag) : null;

if (!tagMatch || !/^[a-f0-9]{40}$/.test(commit ?? "")) {
    throw new Error("Set a valid release tag and exact commit SHA.");
}

if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== commit) {
    throw new Error("HEAD does not match the requested release commit.");
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

if (`v${pkg.version}` !== tag) {
    throw new Error("The package version does not match the release tag.");
}

if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) {
    throw new Error("The release worktree must be clean.");
}

mkdirSync(output, { recursive: true });
const archive = gzipSync(
    execFileSync("git", ["archive", "--format=tar", `--prefix=pi-pocket-${tag}/`, commit]),
    { level: 9, mtime: 0 },
);
const sourceName = `pi-pocket-${tag}-source.tar.gz`;

writeFileSync(join(output, sourceName), archive);
const packRoot = mkdtempSync(join(output, ".pack-"));
const sourceDirectory = mkdtempSync(join(output, ".source-"));

try {
    execFileSync("tar", ["-xzf", join(output, sourceName), "-C", sourceDirectory]);
    const extracted = join(sourceDirectory, `pi-pocket-${tag}`);

    execFileSync("npm", ["pack", "--pack-destination", packRoot], {
        cwd: extracted,
        stdio: "inherit",
    });

    for (const name of readdirSync(packRoot).filter((candidate) => candidate.endsWith(".tgz"))) {
        copyFileSync(join(packRoot, name), join(output, name));
    }
} finally {
    rmSync(packRoot, { recursive: true, force: true });
    rmSync(sourceDirectory, { recursive: true, force: true });
}

const files = readdirSync(output)
    .filter((name) => name.endsWith(".tgz") || name.endsWith(".tar.gz"))
    .sort();

if (files.length < 2) {
    throw new Error("Expected both source and npm package artifacts.");
}

const assets = files.map((name) => {
    const path = join(output, name);
    const bytes = readFileSync(path);

    return {
        name: basename(name),
        bytes: statSync(path).size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
});
const manifest = {
    schema: 1,
    repository: "phroggingphrog/pi-pocket",
    tag,
    commit,
    version: tagMatch[1],
    assets,
};

writeFileSync(join(output, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(
    join(output, "SHA256SUMS"),
    [
        ...assets.map((asset) => `${asset.sha256}  ${asset.name}`),
        `${createHash("sha256")
            .update(readFileSync(join(output, "release-manifest.json")))
            .digest("hex")}  release-manifest.json`,
    ].join("\n") + "\n",
);
