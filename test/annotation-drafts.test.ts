import assert from "node:assert/strict";
import { test } from "node:test";
import {
    annotationKey,
    annotationMessage,
    loadAnnotations,
    remainingAnnotations,
    saveAnnotations,
    validateAnnotation,
} from "../web/annotation-drafts.js";

function storage() {
    const data = new Map<string, string>();

    return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => {
            data.set(key, value);
        },
        removeItem: (key: string) => {
            data.delete(key);
        },
    };
}

const note = {
    id: "note-1",
    conversationId: 12,
    source: { kind: "file", path: "src/a.ts", range: { startLine: 1, endLine: 1 } },
    snapshot: "const n = 1;",
    comment: "Review this",
    sendText: "> const n = 1;\n\nReview this",
};

test("annotation drafts retain immutable snapshots and isolate people and conversations", () => {
    const s = storage();
    const snapshot = validateAnnotation(note);

    saveAnnotations(s, "alice", 12, [snapshot]);
    snapshot.snapshot = "changed";
    assert.equal(loadAnnotations(s, "alice", 12)[0]?.snapshot, "const n = 1;");
    assert.deepEqual(loadAnnotations(s, "bob", 12), []);
    assert.deepEqual(loadAnnotations(s, "alice", 13), []);
    assert.equal(
        annotationMessage("Please check", loadAnnotations(s, "alice", 12)),
        "Please check\n\n" + note.sendText,
    );
});

test("annotation drafts reject cross-conversation notes, excess data and corrupt storage", () => {
    const s = storage();

    assert.throws(() => saveAnnotations(s, "alice", 13, [note]), /limit/);
    assert.throws(() => saveAnnotations(s, "alice", 12, Array(13).fill(note)), /limit/);
    assert.throws(() => validateAnnotation({ ...note, sendText: "not the snapshot" }), /Invalid/);
    s.setItem(annotationKey("alice", 12), "broken JSON");
    assert.deepEqual(loadAnnotations(s, "alice", 12), []);
});

test("successful sends preserve notes added while the request was in progress", () => {
    const later = { ...note, id: "later", comment: "Added in another tab" };

    assert.deepEqual(remainingAnnotations([note, later], [note]), [later]);
    assert.deepEqual(remainingAnnotations([later], [note]), [later]);
});

test("annotation drafts clear only when explicitly removed after send", () => {
    const s = storage();

    saveAnnotations(s, "alice", 12, [note]);
    assert.equal(loadAnnotations(s, "alice", 12).length, 1);
    saveAnnotations(s, "alice", 12, []);
    assert.deepEqual(loadAnnotations(s, "alice", 12), []);
});
