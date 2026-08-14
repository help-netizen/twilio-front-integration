import { useRef, useState, useEffect, useCallback, type ChangeEvent } from 'react';
import { Paperclip, X, FileText, Loader2, RotateCcw } from 'lucide-react';
import { uploadStagedAttachment, deleteStagedAttachment, type NoteEntityType } from '../../services/noteAttachmentsApi';
import { isHeicOrHeif, yieldToMainThread } from '../../lib/imageCompression';
import { NOTE_ATTACHMENT_MAX_FILE_SIZE, prepareImageAttachmentForUpload } from './noteAttachmentPreparation';

const MAX_FILES = 10;
const ACCEPT = 'image/*,application/pdf,.doc,.docx,.xls,.xlsx';
const THUMB = 40; // px — a hair under the 44px attach button, per the owner ("no bigger than the attach icon")

type ItemStatus = 'compressing' | 'uploading' | 'done' | 'error';
interface Item {
    key: string;
    file: File;
    name: string;
    size: number;
    isImage: boolean;
    prepared: boolean;
    status: ItemStatus;
    id?: number;
    error?: string;
    /** Object URL for the inline image thumbnail (images only). */
    previewUrl?: string;
}

export interface AttachmentState {
    /** Ids of successfully-uploaded (staged) attachments to send with the note. */
    ids: number[];
    /** True while any file is still uploading or in an error state → block submit. */
    blocked: boolean;
}

interface NoteAttachmentInputProps {
    entityType: NoteEntityType;
    entityId: number | string;
    /** Called whenever the staged ids / busy state change. */
    onStateChange: (state: AttachmentState) => void;
    compact?: boolean;
    /**
     * Trigger style. 'text' (default) = the inline paperclip link (legacy chip list below).
     * 'round' = a 44px circular icon button (composer-canon) with inline thumbnails to its
     * right — the mobile/desktop note composer.
     */
    variant?: 'text' | 'round';
    /**
     * Background of the 'round' button. Defaults to the field fill (its ground on a white
     * sheet). Override to a contrasting tone when the round button sits on a filled
     * --blanc-field composer card, so it stays visible.
     */
    roundBg?: string;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const isBusyStatus = (s: ItemStatus) => s === 'compressing' || s === 'uploading';

export function NoteAttachmentInput({ entityType, entityId, onStateChange, compact, variant = 'text', roundBg = 'var(--blanc-field)' }: NoteAttachmentInputProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [items, setItems] = useState<Item[]>([]);
    const removedKeys = useRef<Set<string>>(new Set());
    const uploadQueue = useRef<Promise<void>>(Promise.resolve());
    const keySeq = useRef(0);
    const cb = useRef(onStateChange);
    cb.current = onStateChange;

    // Track every object URL we mint so we can revoke them all on unmount (removeItem
    // revokes eagerly; double-revoke is a harmless no-op).
    const createdUrls = useRef<Set<string>>(new Set());
    const makeThumbUrl = useCallback((file: File) => {
        const url = URL.createObjectURL(file);
        createdUrls.current.add(url);
        return url;
    }, []);
    useEffect(() => () => {
        createdUrls.current.forEach(url => URL.revokeObjectURL(url));
        createdUrls.current.clear();
    }, []);

    // Report state up AFTER render (never during a setState updater).
    useEffect(() => {
        const ids = items.filter(i => i.status === 'done' && i.id != null).map(i => i.id!);
        const blocked = items.some(i => isBusyStatus(i.status) || i.status === 'error');
        cb.current({ ids, blocked });
    }, [items]);

    const processItem = useCallback(async (item: Item) => {
        try {
            let uploadFile = item.file;
            if (item.isImage && !item.prepared) {
                const result = await prepareImageAttachmentForUpload(item.file);
                if (removedKeys.current.has(item.key)) return;
                uploadFile = result.file;
                // HEIC/HEIF can't render in <img> before conversion, so those get their
                // thumbnail here (from the converted JPEG); regular images already have one.
                const newPreview = item.isImage && !item.previewUrl ? makeThumbUrl(uploadFile) : undefined;
                setItems(prev => prev.map(i => (i.key === item.key ? {
                    ...i,
                    file: uploadFile,
                    name: uploadFile.name,
                    size: uploadFile.size,
                    prepared: true,
                    status: 'uploading',
                    ...(newPreview ? { previewUrl: newPreview } : {}),
                } : i)));
            }

            if (removedKeys.current.has(item.key)) return;
            const att = await uploadStagedAttachment(entityType, entityId, uploadFile);
            if (removedKeys.current.has(item.key)) { deleteStagedAttachment(att.id).catch(() => {}); return; }
            setItems(prev => prev.map(i => (i.key === item.key ? { ...i, status: 'done', id: att.id } : i)));
        } catch (err) {
            if (removedKeys.current.has(item.key)) return;
            setItems(prev => prev.map(i => (i.key === item.key ? { ...i, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' } : i)));
        }
    }, [entityType, entityId, makeThumbUrl]);

    const enqueueItems = useCallback((queuedItems: Item[]) => {
        uploadQueue.current = uploadQueue.current.then(async () => {
            // Let the thumbnail render before the first full-size decode.
            await yieldToMainThread();
            for (let index = 0; index < queuedItems.length; index += 1) {
                const item = queuedItems[index];
                if (item && !removedKeys.current.has(item.key)) await processItem(item);
                if (index < queuedItems.length - 1) await yieldToMainThread();
            }
        });
    }, [processItem]);

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        const selected = Array.from(e.target.files || []);
        if (inputRef.current) inputRef.current.value = '';
        const room = Math.max(0, MAX_FILES - items.length);
        const toAdd = selected.slice(0, room).filter(f => {
            const isImage = f.type.startsWith('image/') || isHeicOrHeif(f);
            if (!isImage && f.size > NOTE_ATTACHMENT_MAX_FILE_SIZE) {
                console.warn(`[Attachments] "${f.name}" too large`);
                return false;
            }
            return true;
        });
        if (toAdd.length === 0) return;
        const newItems: Item[] = toAdd.map(f => {
            const isImage = f.type.startsWith('image/') || isHeicOrHeif(f);
            // Non-HEIC images get an immediate preview from the original; HEIC waits for conversion.
            const previewUrl = isImage && !isHeicOrHeif(f) ? makeThumbUrl(f) : undefined;
            return {
                key: `${Date.now()}-${keySeq.current++}`,
                file: f, name: f.name, size: f.size,
                isImage, prepared: false, previewUrl,
                status: isImage ? 'compressing' as const : 'uploading' as const,
            };
        });
        setItems(prev => [...prev, ...newItems]);
        enqueueItems(newItems);
    };

    const removeItem = (key: string) => {
        removedKeys.current.add(key);
        setItems(prev => {
            const it = prev.find(i => i.key === key);
            if (it?.previewUrl) URL.revokeObjectURL(it.previewUrl);
            if (it?.status === 'done' && it.id != null) deleteStagedAttachment(it.id).catch(() => {});
            return prev.filter(i => i.key !== key);
        });
    };

    const retry = (key: string) => {
        const it = items.find(i => i.key === key);
        if (!it) return;
        const status: ItemStatus = it.isImage && !it.prepared ? 'compressing' : 'uploading';
        setItems(prev => prev.map(i => (i.key === key ? { ...i, status, error: undefined } : i)));
        enqueueItems([{ ...it, status, error: undefined }]);
    };

    const fileInput = <input ref={inputRef} type="file" multiple accept={ACCEPT} onChange={handleChange} className="hidden" />;

    // ---- 'round' composer variant: attach button + inline thumbnails (image previews) ----
    if (variant === 'round') {
        // Show EVERY attachment as its own thumbnail. The previews live in a full-width
        // strip that wraps onto new rows (flexBasis:100% forces it onto its own line above
        // the composer's action bar); the round attach button flows inline with the bar's
        // controls. (Owner reversed the earlier "first 2 + N chip" collapse — MAX is 10.)
        return (
            <>
                {fileInput}
                {items.length > 0 && (
                    <div className="flex flex-wrap gap-1.5" style={{ flexBasis: '100%', minWidth: 0 }}>
                        {items.map(item => {
                            const busy = isBusyStatus(item.status);
                            const err = item.status === 'error';
                            return (
                                <div
                                    key={item.key}
                                    className="relative shrink-0"
                                    style={{ width: THUMB, height: THUMB }}
                                    title={err ? (item.error || 'Upload failed') : item.name}
                                >
                                    {item.isImage && item.previewUrl ? (
                                        <img
                                            src={item.previewUrl}
                                            alt={item.name}
                                            className="h-full w-full object-cover"
                                            style={{ borderRadius: 10, border: '1px solid var(--blanc-line)' }}
                                        />
                                    ) : (
                                        <div
                                            className="flex h-full w-full items-center justify-center"
                                            style={{ borderRadius: 10, background: 'rgba(25,25,25,0.06)', border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-2)' }}
                                        >
                                            <FileText className="size-4" />
                                        </div>
                                    )}
                                    {busy && (
                                        <div className="absolute inset-0 flex items-center justify-center" style={{ borderRadius: 10, background: 'rgba(25,25,25,0.45)' }}>
                                            <Loader2 className="size-4 animate-spin" style={{ color: '#fff' }} />
                                        </div>
                                    )}
                                    {err && (
                                        <button
                                            type="button"
                                            onMouseDown={e => e.preventDefault()}
                                            onClick={() => retry(item.key)}
                                            title="Retry upload"
                                            className="absolute inset-0 flex items-center justify-center"
                                            style={{ borderRadius: 10, background: 'rgba(180,35,24,0.5)' }}
                                        >
                                            <RotateCcw className="size-4" style={{ color: '#fff' }} />
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onMouseDown={e => e.preventDefault()}
                                        onClick={() => removeItem(item.key)}
                                        aria-label="Remove attachment"
                                        className="absolute flex items-center justify-center"
                                        style={{ top: -5, right: -5, width: 18, height: 18, borderRadius: 999, background: 'var(--blanc-ink-1)', color: '#fff', border: '2px solid var(--blanc-surface-strong)' }}
                                    >
                                        <X className="size-2.5" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
                <button
                    type="button"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => inputRef.current?.click()}
                    disabled={items.length >= MAX_FILES}
                    aria-label="Attach files"
                    className="flex shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-80 disabled:opacity-30"
                    style={{ width: 44, height: 44, background: roundBg, border: 'none', color: 'var(--blanc-ink-2)' }}
                    title="Attach files"
                >
                    <Paperclip className="size-5" />
                </button>
            </>
        );
    }

    // ---- legacy 'text' variant: paperclip link + chip list below ----
    return (
        <div>
            {fileInput}
            <button
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={() => inputRef.current?.click()}
                disabled={items.length >= MAX_FILES}
                className="inline-flex items-center gap-1 text-xs transition-opacity hover:opacity-70 disabled:opacity-30"
                style={{ color: 'var(--blanc-ink-3)' }}
                title="Attach files"
            >
                <Paperclip className="size-3.5" />
                {!compact && <span>Attach</span>}
            </button>

            {items.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                    {items.map(item => {
                        const busy = isBusyStatus(item.status);
                        const isErr = item.status === 'error';
                        return (
                            <div
                                key={item.key}
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs"
                                style={{
                                    background: isErr ? 'rgba(180,35,24,0.06)' : 'rgba(25,25,25,0.06)',
                                    border: `1px solid ${isErr ? 'rgba(180,35,24,0.4)' : 'var(--blanc-line)'}`,
                                    color: 'var(--blanc-ink-2)',
                                    opacity: busy ? 0.75 : 1,
                                }}
                                title={isErr ? (item.error || 'Upload failed') : undefined}
                            >
                                {busy
                                    ? <Loader2 className="size-3 shrink-0 animate-spin" style={{ color: 'var(--blanc-ink-3)' }} />
                                    : isErr
                                        ? <RotateCcw className="size-3 shrink-0" style={{ color: '#b42318' }} />
                                        : <FileText className="size-3 shrink-0" />}
                                <span className="max-w-[120px] truncate">{item.name}</span>
                                <span className="text-[10px]" style={{ color: 'var(--blanc-ink-3)' }}>
                                    {item.status === 'compressing' ? 'Compressing…' : item.status === 'uploading' ? 'Uploading…' : isErr ? 'Failed' : formatSize(item.size)}
                                </span>
                                {isErr && (
                                    <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => retry(item.key)} className="hover:opacity-70" style={{ color: 'var(--blanc-ink-3)' }} title="Retry upload">
                                        <RotateCcw className="size-3" />
                                    </button>
                                )}
                                <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => removeItem(item.key)} className="hover:opacity-70" style={{ color: 'var(--blanc-ink-3)' }} title="Remove">
                                    <X className="size-3" />
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
