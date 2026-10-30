import assert from "node:assert/strict";
import { test } from "node:test";
import setup, { sourceOffset } from "./index.js";

test("maps textarea offsets to original CRLF and UTF-16 source offsets", () => {
    const text = "first\r\n😀second\r\nthird";
    const displayed = text.replace(/\r\n?/g, "\n");
    const start = displayed.indexOf("second");
    const end = displayed.indexOf("third") + "third".length;

    assert.equal(text.slice(sourceOffset(text, start), sourceOffset(text, end)), "second\r\nthird");
    assert.equal(sourceOffset(text, displayed.indexOf("😀")), 7);
    assert.equal(sourceOffset(text, 0), 0);
});

function client(withMessageAction) {
    const registered = {};
    const opened = [];
    const pocket = {
        style: () => {},
        sheet: (spec) => {
            registered.sheet = spec;
        },
        composerButton: (spec) => {
            registered.composer = spec;
        },
        replyAction: (spec) => {
            registered.reply = spec;
        },
        openSheet: (...args) => opened.push(args),
    };

    if (withMessageAction) {
        pocket.messageAction = (spec) => {
            registered.message = spec;
        };
    }

    setup(pocket);

    return { registered, opened };
}

test("uses native message actions for human and assistant messages", () => {
    const { registered, opened } = client(true);
    const reply = {
        id: "123",
        text: "Text",
        kind: "user",
        conversationId: 2,
        selectedText: "Text",
    };

    registered.message.run(reply);
    assert.equal(registered.reply, undefined);
    assert.deepEqual(opened, [["annotation", { reply }]]);
    assert.equal(registered.composer.sheet, "annotation");
});

test("falls back to the reply action on an older app", () => {
    const { registered, opened } = client(false);
    const reply = { id: "456", text: "Answer", conversationId: 3 };

    registered.reply.run(reply);
    assert.deepEqual(opened, [["annotation", { reply }]]);
});
