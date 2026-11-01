import { formatAnnotations, messageSelection } from "./annotation-format.js";

export const pocketApi = 1;
const ICON = "M4 4h16v12H9l-5 4z M8 8h8 M8 12h5";

/** Map textarea offsets (LF line endings) to the original source's UTF-16 offsets. */
export function sourceOffset(text, offset) {
    let displayed = 0;
    let source = 0;

    while (source < text.length && displayed < offset) {
        if (text[source] === "\r" && text[source + 1] === "\n") {
            source++;
        }

        source++;
        displayed++;
    }

    return source;
}

export default function setup(pocket) {
    const { html, useState, useEffect, useRef } = pocket;

    function AnnotationSheet({ close, reply, selection }) {
        const conversationId =
            selection?.conversationId ?? reply?.conversationId ?? pocket.conversationId();
        const [path, setPath] = useState(selection?.path ?? "");
        const [source, setSource] = useState(
            selection ??
                (reply
                    ? {
                          kind: "message",
                          messageId: reply.id,
                          text: reply.text,
                      }
                    : null),
        );
        const captured = messageSelection(reply?.text, reply?.selectedText);
        const [range, setRange] = useState(selection?.range ?? captured?.range ?? null);
        const [snapshot, setSnapshot] = useState(selection?.snapshot ?? captured?.snapshot ?? "");
        const [comment, setComment] = useState("");
        const [error, setError] = useState("");
        const [loading, setLoading] = useState(false);
        const field = useRef(null);
        const alive = useRef(true);

        useEffect(
            () => () => {
                alive.current = false;
            },
            [],
        );

        async function loadFile(event) {
            event.preventDefault();

            if (conversationId == null || conversationId !== pocket.conversationId()) {
                setError("The conversation changed. Open annotations again.");

                return;
            }

            setError("");
            setLoading(true);

            try {
                const file = await pocket.api(
                    `files/${conversationId}?path=${encodeURIComponent(path)}`,
                );

                if (!alive.current) {
                    return;
                }

                setSource({ kind: "file", path: file.path, text: file.text });
                setSnapshot("");
                setRange(null);
            } catch (failure) {
                if (alive.current) {
                    setError(failure.message);
                }
            } finally {
                if (alive.current) {
                    setLoading(false);
                }
            }
        }

        function capture() {
            const input = field.current;

            if (!input || !source?.text) {
                return;
            }

            const start = sourceOffset(source.text, input.selectionStart);
            const end = sourceOffset(source.text, input.selectionEnd);
            const selected = source.text.slice(start, end);

            if (end <= start) {
                setRange(null);
                setSnapshot("");

                return;
            }

            const next = { start, end };

            if (source.kind === "file") {
                next.startLine = source.text.slice(0, start).split("\n").length;
                next.endLine = source.text.slice(0, end - 1).split("\n").length;
            }

            setRange(next);
            setSnapshot(selected);
        }

        function add() {
            if (conversationId == null || conversationId !== pocket.conversationId()) {
                setError("The conversation changed. Open annotations again.");

                return;
            }

            if (typeof pocket.addAnnotation !== "function") {
                setError("Annotation drafts need an updated Pi Pocket. No text was added.");

                return;
            }

            try {
                const note =
                    source?.kind === "file"
                        ? { kind: "file", path: source.path, range, snapshot, comment }
                        : {
                              kind: "message",
                              messageId: source?.messageId,
                              range,
                              snapshot,
                              comment,
                          };
                const sendText = formatAnnotations([note]);

                pocket.addAnnotation({
                    conversationId,
                    id: crypto.randomUUID(),
                    source:
                        note.kind === "file"
                            ? { kind: "file", path: note.path, range }
                            : { kind: "message", messageId: note.messageId, range },
                    snapshot,
                    comment,
                    sendText,
                });
                close();
            } catch (failure) {
                setError(failure.message);
            }
        }

        return html`<div class="annotation-sheet">
            ${
                !reply &&
                !selection &&
                html`<form onSubmit=${loadFile}>
                    <label for="annotation-path">File path in this conversation's workspace</label>
                    <div class="annotation-row">
                        <input
                            id="annotation-path"
                            value=${path}
                            onInput=${(event) => setPath(event.currentTarget.value)}
                            placeholder="src/example.js"
                            required
                        />
                        <button type="submit" disabled=${loading}>
                            ${loading ? "Opening…" : "Open"}
                        </button>
                    </div>
                </form>`
            }
            ${
                source?.text !== undefined &&
                html`<label for="annotation-source">Select text to quote</label>
                    <textarea
                        id="annotation-source"
                        ref=${field}
                        class="annotation-source mono"
                        readonly
                        value=${source.text}
                        onSelect=${capture}
                        aria-describedby="annotation-select-help"
                    ></textarea>
                    <p id="annotation-select-help" class="muted small">
                        Select text with a mouse, keyboard, or touch. The selected text is saved as
                        a snapshot. If the message selection is ambiguous, select it again here.
                    </p>`
            }
            ${
                snapshot &&
                html`<div class="annotation-preview">
                    <strong>Selected snapshot</strong>
                    <p class="small mono">
                        ${source.kind === "file" ? `${source.path}, lines ${range.startLine}–${range.endLine}` : `Message ${source.messageId}`}
                    </p>
                    <pre>${snapshot}</pre>
                </div>`
            }
            ${
                snapshot &&
                html`<label for="annotation-comment">Your comment</label>
                    <textarea
                        id="annotation-comment"
                        value=${comment}
                        onInput=${(event) => setComment(event.currentTarget.value)}
                        rows="4"
                        maxlength="20000"
                    ></textarea>`
            }
            ${error && html`<p class="error-box" role="alert">${error}</p>`}
            <button class="primary" disabled=${!snapshot || !comment.trim()} onClick=${add}>
                Add to message draft
            </button>
        </div>`;
    }

    pocket.style("style.css");
    pocket.sheet({ id: "annotation", title: "Add annotation", component: AnnotationSheet });
    pocket.composerButton({
        id: "annotation",
        title: "Annotate a file",
        iconPath: ICON,
        sheet: "annotation",
    });

    if (typeof pocket.messageAction === "function") {
        pocket.messageAction({
            id: "annotation",
            label: "Annotate",
            iconPath: ICON,
            run: (reply) => pocket.openSheet("annotation", { reply }),
        });
    } else {
        pocket.replyAction({
            id: "annotation",
            label: "Annotate",
            iconPath: ICON,
            run: (reply) => pocket.openSheet("annotation", { reply }),
        });
    }

    if (typeof pocket.fileSelectionAction === "function") {
        pocket.fileSelectionAction({
            id: "annotation",
            label: "Annotate selection",
            run: (selection) =>
                pocket.openSheet("annotation", { selection: { ...selection, kind: "file" } }),
        });
    }

    if (typeof pocket.messageSelectionAction === "function") {
        pocket.messageSelectionAction({
            id: "annotation",
            label: "Annotate selection",
            run: (selection) =>
                pocket.openSheet("annotation", { selection: { ...selection, kind: "message" } }),
        });
    }
}
