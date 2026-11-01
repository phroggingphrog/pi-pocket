import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAnnotations, messageSelection } from "./annotation-format.js";

test("uses a message selection only when it occurs once", () => {
    assert.deepEqual(messageSelection("😀 alpha beta", "alpha"), {
        snapshot: "alpha",
        range: { start: 3, end: 8 },
    });
    assert.equal(messageSelection("one one", "one"), null);
    assert.equal(messageSelection("hello", "missing"), null);
    assert.equal(messageSelection("hello", undefined), null);
});

const file = {
    kind: "file",
    path: "src/example.js",
    range: { start: 2, end: 9, startLine: 1, endLine: 2 },
    snapshot: "old\n```",
    comment: "Please change this.\n```",
};
const message = {
    kind: "message",
    messageId: "42",
    range: { start: 0, end: 4 },
    snapshot: "text",
    comment: "Why?",
};

test("keeps multiple snapshots, metadata, and comments in order", () => {
    const output = formatAnnotations([file, message]);

    assert.match(output, /"path":"src\/example\.js"/);
    assert.match(output, /"startLine":1,"endLine":2/);
    assert.match(output, /````\nold\n```\n````/);
    assert.match(output, /````\nPlease change this\.\n```\n````/);
    assert.ok(output.indexOf("old") < output.indexOf('"messageId":"42"'));
    assert.match(output, /"start":0,"end":4/);
});

test("rejects malformed notes and excessive text", () => {
    assert.throws(() => formatAnnotations([]));
    assert.throws(() => formatAnnotations([{ ...file, range: { start: 9, end: 2 } }]));
    assert.throws(() => formatAnnotations([{ ...file, path: "" }]));
    assert.throws(() => formatAnnotations([{ ...message, comment: " " }]));
    assert.throws(() => formatAnnotations([{ ...message, snapshot: "a".repeat(100_001) }]));
});

test("preserves CRLF snapshot and original file offsets", () => {
    const output = formatAnnotations([
        {
            ...file,
            range: { start: 6, end: 18, startLine: 1, endLine: 2 },
            snapshot: "line\r\nSecond",
        },
    ]);

    assert.match(output, /"start":6,"end":18/);
    assert.ok(output.includes("line\r\nSecond"));
});

test("metadata and text cannot close their fences", () => {
    const output = formatAnnotations([
        { ...file, path: "a```b", snapshot: "````x", comment: "```" },
    ]);

    assert.match(output, /````json\n/);
    assert.match(output, /`````\n````x\n`````/);
    assert.match(output, /````\n```\n````/);
});
