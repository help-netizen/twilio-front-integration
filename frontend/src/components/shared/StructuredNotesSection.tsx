import { useState, useRef, useCallback, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../ui/button';
import { NoteAttachmentInput } from './NoteAttachmentInput';
import { NoteAttachmentDisplay } from './NoteAttachmentDisplay';
import { authedFetch } from '../../services/apiClient';

// ─── Types ───────────────────────────────────────────────────────────────────

interface StructuredNote {
    text: string;
    created: string;
    migrated?: boolean;
    attachments?: Array<{
        id: number;
        fileName: string;
        contentType: string;
        fileSize: number;
    }>;
}

interface StructuredNotesSectionProps {
    /** 'lead' or 'contact' */
    entityType: 'lead' | 'contact';
    /** UUID for leads, numeric ID for contacts */
    entityId: string | number;
    /** Legacy plain text notes/comments (for display if structured is empty) */
    legacyText?: string;
    /** Optional external callback after note is added */
    onNoteAdded?: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
    try {
        return new Intl.DateTimeFormat('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit',
        }).format(new Date(iso));
    } catch {
        return iso;
    }
}

// ─── Component ───────────────────────────────────────────────────────────────

export function StructuredNotesSection({
    entityType, entityId, legacyText, onNoteAdded,
}: StructuredNotesSectionProps) {
    const [notes, setNotes] = useState<StructuredNote[]>([]);
    const [text, setText] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const [expanded, setExpanded] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const basePath = entityType === 'lead'
        ? `/api/leads/${entityId}/notes`
        : `/api/contacts/${entityId}/notes`;

    const fetchNotes = useCallback(async () => {
        try {
            const res = await authedFetch(basePath);
            const data = await res.json();
            if (data.ok || data.data) setNotes(data.data || []);
        } catch { }
    }, [basePath]);

    useEffect(() => { fetchNotes(); }, [fetchNotes]);

    const handleSubmit = useCallback(async () => {
        if (!text.trim() && files.length === 0) return;
        setSubmitting(true);
        try {
            const formData = new FormData();
            formData.append('text', text.trim());
            files.forEach(f => formData.append('attachments', f));

            await authedFetch(basePath, { method: 'POST', body: formData });
            setText('');
            setFiles([]);
            setExpanded(false);
            fetchNotes();
            onNoteAdded?.();
        } catch (err) {
            console.error('[StructuredNotes] Failed to add note:', err);
        } finally {
            setSubmitting(false);
        }
    }, [text, files, basePath, onNoteAdded]);

    const expand = () => {
        setExpanded(true);
        setTimeout(() => textareaRef.current?.focus(), 0);
    };

    // Click-outside to collapse (replaces blur which breaks with file dialogs)
    const handleClickOutside = useCallback((e: MouseEvent) => {
        if (!containerRef.current?.contains(e.target as Node) && !text.trim() && files.length === 0) {
            setExpanded(false);
        }
    }, [text, files.length]);

    useEffect(() => {
        if (expanded) {
            document.addEventListener('mousedown', handleClickOutside);
            return () => document.removeEventListener('mousedown', handleClickOutside);
        }
    }, [expanded, handleClickOutside]);

    const canSubmit = (text.trim() || files.length > 0) && !submitting;
    const displayNotes = notes.length > 0 ? notes : [];
    const showLegacy = displayNotes.length === 0 && legacyText?.trim();

    return (
        <div ref={containerRef} className="space-y-3">
            {/* Existing notes */}
            {displayNotes.map((note, i) => (
                <div key={i} className="p-3 rounded-xl space-y-2" style={{ background: 'rgba(117,106,89,0.04)' }}>
                    {note.text && <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--blanc-ink-1)' }}>{note.text}</p>}
                    {note.attachments && note.attachments.length > 0 && (
                        <NoteAttachmentDisplay attachments={note.attachments} />
                    )}
                    <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                        {formatDate(note.created)}
                        {note.migrated && ' (migrated)'}
                    </p>
                </div>
            ))}

            {/* Legacy text fallback */}
            {showLegacy && (
                <div className="p-3 rounded-xl" style={{ background: 'rgba(117,106,89,0.04)' }}>
                    <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--blanc-ink-2)' }}>{legacyText}</p>
                    <p className="text-xs mt-1" style={{ color: 'var(--blanc-ink-3)' }}>Legacy note</p>
                </div>
            )}

            {/* Add note */}
            {expanded ? (
                <div className="space-y-2">
                    <textarea
                        ref={textareaRef}
                        className="w-full text-sm resize-none outline-none bg-transparent leading-5"
                        style={{
                            border: '1px solid var(--blanc-line)',
                            borderRadius: 10,
                            padding: '8px 12px',
                            minHeight: 72,
                            color: 'var(--blanc-ink-1)',
                        }}
                        placeholder="Write a note..."
                        value={text}
                        onChange={e => setText(e.target.value)}
                        onKeyDown={e => {
                            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSubmit) {
                                e.preventDefault();
                                handleSubmit();
                            }
                        }}
                        onInput={e => {
                            const t = e.target as HTMLTextAreaElement;
                            t.style.height = 'auto';
                            t.style.height = `${t.scrollHeight}px`;
                        }}
                        autoFocus
                    />
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <NoteAttachmentInput files={files} onChange={setFiles} compact />
                            <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Cmd + Enter</p>
                        </div>
                        <Button size="sm" onMouseDown={e => e.preventDefault()} onClick={handleSubmit} disabled={!canSubmit}>
                            <Plus className="size-4 mr-1" /> Add Note
                        </Button>
                    </div>
                </div>
            ) : (
                <button
                    onClick={expand}
                    className="w-full flex items-center gap-2 transition-opacity hover:opacity-70"
                    style={{
                        height: 34,
                        borderRadius: 10,
                        border: '1px solid var(--blanc-line)',
                        background: 'transparent',
                        paddingLeft: 12,
                        paddingRight: 12,
                        cursor: 'text',
                        textAlign: 'left',
                    }}
                >
                    <Plus className="size-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                    <span className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>Add note…</span>
                </button>
            )}
        </div>
    );
}
