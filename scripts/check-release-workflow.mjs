import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

assert.match(workflow, /workflow_dispatch:/);
assert.doesNotMatch(workflow, /^\s*(push|schedule):/m);
assert.match(workflow, /github\.repository == 'phroggingphrog\/pi-pocket'/);
assert.match(workflow, /git merge-base --is-ancestor/);
assert.match(workflow, /npm run check/);
assert.match(workflow, /npm run lint/);
assert.match(workflow, /npm test/);
assert.match(workflow, /build-fork-release\.mjs/);
assert.match(workflow, /gh release create/);
assert.match(workflow, /--repo phroggingphrog\/pi-pocket/);
assert.doesNotMatch(workflow, /npm publish|TannerMidd\/pi-pocket/);
assert.doesNotMatch(workflow, /systemctl|restart|deploy/i);
console.log("Manual owner-fork release workflow checks passed.");
