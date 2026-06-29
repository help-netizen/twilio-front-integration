import { useRef, useState, useEffect, useCallback, type ChangeEvent } from 'react';
import { Paperclip, X, FileText, Image as ImageIcon, Loader2, AlertCircle, RotateCcw } from 'lucide-react';
import { uploadStagedAttachment, deleteStagedAttachment, type NoteEntityType } from '../../services/noteAttachmentsApi';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 5;
const ACCEPT = 'image/*,application/pdf,.doc,.docx,.xls,.xlsx';

type ItemStatus = 'uploading' | 'done' | 'error';
interface Item {
    key: string;
    file: File;
    name: string;
    size: number;
    isImage: boolean;
    status: ItemStatus;
    id?: number;
    error?: string;
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
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function NoteAttachmentInput({ entityType, entityId, onStateChange, compact }: NoteAttachmentInputProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [items, setItems] = useState<Item[]>([]);
    const removedKeys = useRef<Set<string>>(new Set());
    const keySeq = useRef(0);
    const cb = useRef(onStateChange);
    cb.current = onStateChange;

    // Report state up AFTER render (never during a setState updater).
    useEffect(() => {
        const ids = items.filter(i => i.status === 'done' && i.id != null).map(i => i.id!);
        const blocked = items.some(i => i.status === 'uploading' || i.status === 'error');
        cb.current({ ids, blocked });
    }, [items]);

    const startUpload = useCallback(async (file: File, key: string) => {
        try {
            const att = await uploadStagedAttachment(entityType, entityId, file);
            if (removedKeys.current.has(key)) { deleteStagedAttachment(att.id).catch(() => {}); return; }
            setItems(prev => prev.map(i => (i.key === key ? { ...i, status: 'done', id: att.id } : i)));
        } catch (err) {
            if (removedKeys.current.has(key)) return;
            setItems(prev => prev.map(i => (i.key === key ? { ...i, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' } : i)));
        }
    }, [entityType, entityId]);

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        const selected = Array.from(e.target.files || []);
        if (inputRef.current) inputRef.current.value = '';
        const room = Math.max(0, MAX_FILES - items.length);
        const toAdd = selected.slice(0, room).filter(f => {
            if (f.size > MAX_FILE_SIZE) { console.warn(`[Attachments] "${f.name}" too large`); return false; }
            return true;
        });
        if (toAdd.length === 0) return;
        const newItems: Item[] = toAdd.map(f => ({
            key: `${Date.now()}-${keySeq.current++}`,
            file: f, name: f.name, size: f.size,
            isImage: f.type.startsWith('image/'), status: 'uploading' as const,
        }));
        setItems(prev => [...prev, ...newItems]);
        newItems.forEach(it => startUpload(it.file, it.key));
    };

    const removeItem = (key: string) => {
        removedKeys.current.add(key);
        setItems(prev => {
            const it = prev.find(i => i.key === key);
            if (it?.status === 'done' && it.id != null) deleteStagedAttachment(it.id).catch(() => {});
            return prev.filter(i => i.key !== key);
        });
    };

    const retry = (key: string) => {
        setItems(prev => prev.map(i => (i.key === key ? { ...i, status: 'uploading', error: undefined } : i)));
        const it = items.find(i => i.key === key);
        if (it) startUpload(it.file, key);
    };

    return (
        <div>
            <input ref={inputRef} type="file" multiple accept={ACCEPT} onChange={handleChange} className="hidden" />

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
                        const isErr = item.status === 'error';
                        return (
                            <div
                                key={item.key}
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs"
                                style={{
                                    background: isErr ? 'rgba(180,35,24,0.06)' : 'rgba(117,106,89,0.06)',
                                    border: `1px solid ${isErr ? 'rgba(180,35,24,0.4)' : 'var(--blanc-line)'}`,
                                    color: 'var(--blanc-ink-2)',
                                    opacity: item.status === 'uploading' ? 0.75 : 1,
                                }}
                                title={isErr ? (item.error || 'Upload failed') : undefined}
                            >
                                {item.status === 'uploading'
                                    ? <Loader2 className="size-3 shrink-0 animate-spin" style={{ color: 'var(--blanc-ink-3)' }} />
                                    : isErr
                                        ? <AlertCircle className="size-3 shrink-0" style={{ color: '#b42318' }} />
                                        : item.isImage
                                            ? <ImageIcon className="size-3 shrink-0" />
                                            : <FileText className="size-3 shrink-0" />}
                                <span className="max-w-[120px] truncate">{item.name}</span>
                                <span className="text-[10px]" style={{ color: 'var(--blanc-ink-3)' }}>
                                    {item.status === 'uploading' ? 'Uploading…' : isErr ? 'Failed' : formatSize(item.size)}
                                </span>
                                {isErr && (
                                    <button
                                        type="button"
                                        onMouseDown={e => e.preventDefault()}
                                        onClick={() => retry(item.key)}
                                        className="hover:opacity-70"
                                        style={{ color: 'var(--blanc-ink-3)' }}
                                        title="Retry upload"
                                    >
                                        <RotateCcw className="size-3" />
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onMouseDown={e => e.preventDefault()}
                                    onClick={() => removeItem(item.key)}
                                    className="hover:opacity-70"
                                    style={{ color: 'var(--blanc-ink-3)' }}
                                    title="Remove"
                                >
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
