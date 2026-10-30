export interface AnnotationDraft {
    id: string;
    conversationId: number;
    source: { kind: string; path?: string; messageId?: string; range?: unknown };
    snapshot: string;
    comment: string;
    sendText: string;
}
interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
export function annotationKey(person: string | undefined, conversationId: number): string;
export function validateAnnotation(note: unknown): AnnotationDraft;
export function loadAnnotations(
    storage: StorageLike,
    person: string | undefined,
    conversationId: number,
): AnnotationDraft[];
export function saveAnnotations(
    storage: StorageLike,
    person: string | undefined,
    conversationId: number,
    notes: AnnotationDraft[],
): void;
export function remainingAnnotations(
    latest: AnnotationDraft[],
    sent: AnnotationDraft[],
): AnnotationDraft[];
export function annotationMessage(text: string, notes: AnnotationDraft[]): string;
