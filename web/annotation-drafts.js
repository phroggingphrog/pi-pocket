const MAX_NOTES = 12;
const MAX_TEXT = 80000;

export function annotationKey(person, conversationId) {
    return `pocket.annotations.${person ?? "owner"}.${conversationId}`;
}

export function validateAnnotation(note) {
    if (
        !note ||
        typeof note.id !== "string" ||
        note.id.length > 100 ||
        !Number.isSafeInteger(note.conversationId) ||
        note.conversationId <= 0 ||
        !["file", "message"].includes(note.source?.kind) ||
        typeof note.snapshot !== "string" ||
        !note.snapshot.trim() ||
        typeof note.comment !== "string" ||
        typeof note.sendText !== "string" ||
        !note.sendText.includes(note.snapshot) ||
        note.sendText.length > MAX_TEXT
    ) {
        throw new Error("Invalid annotation snapshot or source.");
    }

    return JSON.parse(JSON.stringify(note));
}

export function loadAnnotations(storage, person, conversationId) {
    try {
        const list = JSON.parse(storage.getItem(annotationKey(person, conversationId)) ?? "[]");

        if (!Array.isArray(list) || list.length > MAX_NOTES) {
            return [];
        }

        return list
            .map(validateAnnotation)
            .filter((note) => note.conversationId === conversationId);
    } catch {
        return [];
    }
}

export function saveAnnotations(storage, person, conversationId, notes) {
    const checked = notes.map(validateAnnotation);

    if (
        checked.length > MAX_NOTES ||
        checked.some((note) => note.conversationId !== conversationId) ||
        checked.reduce((total, note) => total + note.sendText.length, 0) > MAX_TEXT
    ) {
        throw new Error("Annotation draft limit reached. Send or remove a note first.");
    }

    const key = annotationKey(person, conversationId);

    if (checked.length) {
        storage.setItem(key, JSON.stringify(checked));
    } else {
        storage.removeItem(key);
    }
}

export function remainingAnnotations(latest, sent) {
    const sentIds = new Set(sent.map((note) => note.id));

    return latest.filter((note) => !sentIds.has(note.id));
}

export function annotationMessage(text, notes) {
    return [text.trimEnd(), ...notes.map((note) => note.sendText)].filter(Boolean).join("\n\n");
}
