import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '../ui/button';
import { Plus } from 'lucide-react';
import type { LocalJob } from '../../services/jobsApi';
import { formatSchedule } from './jobHelpers';
import { NoteAttachmentInput } from '../shared/NoteAttachmentInput';
import { NoteAttachmentDisplay } from '../shared/NoteAttachmentDisplay';

// ─── Types ───────────────────────────────────────────────────────────────────

interface JobNotesSectionProps {
    job: LocalJob;
    noteJobId: number | null;
    noteText: string;
    setNoteText: (v: string) => void;
    setNoteJobId: (v: number | null) => void;
    onAddNote: (files?: File[]) => void;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

export function JobDescription({ job }: { job: LocalJob }) {
    return (
        <div>
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">Description</h3>
            <div className="p-3 bg-muted rounded-lg">
                <p className="text-sm whitespace-pre-wrap">{job.description || 'No description'}</p>
            </div>
        </div>
    );
}

export function JobComments({ job }: { job: LocalJob }) {
    const [comments, setComments] = useState(job.comments || '');

    const handleSaveComments = async () => {
        // TODO: save comments via API when endpoint exists
    };

    return (
        <div style={{ padding: '14px 16px 16px', borderRadius: 16, background: '#fef9e7', borderLeft: '3px solid #f6d860' }}>
            <h4 className="blanc-eyebrow mb-2">Notes</h4>
            <textarea
                ref={el => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }}
                className="w-full text-sm resize-none bg-transparent border-none outline-none leading-6"
                style={{ minHeight: 36, color: comments ? 'var(--blanc-ink-1)' : undefined }}
                value={comments}
                onChange={e => setComments(e.target.value)}
                onBlur={handleSaveComments}
                onInput={e => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }}
                placeholder="Add comments…"
                rows={2}
            />
        </div>
    );
}

export function JobNotesList({ job }: { job: LocalJob }) {
    return (
        <div>
            <div className="space-y-3">
                {job.notes && job.notes.length > 0 ? [...job.notes].reverse().map((note: any, i: number) => (
                    <div key={note.id || i} className="p-3 rounded-lg space-y-2" style={{ background: '#fef9e7' }}>
                        {note.text && <p className="text-sm whitespace-pre-wrap">{note.text}</p>}
                        {note.attachments && note.attachments.length > 0 && (
                            <NoteAttachmentDisplay attachments={note.attachments} />
                        )}
                        {note.created && (
                            <p className="text-xs text-muted-foreground">{formatSchedule(note.created).date}</p>
                        )}
                        {!note.text && (!note.attachments || note.attachments.length === 0) && (
                            <p className="text-xs text-muted-foreground italic">Empty note</p>
                        )}
                    </div>
                )) : (
                    <p className="text-sm text-muted-foreground">No notes yet</p>
                )}
            </div>
        </div>
    );
}

export function JobAddNote({ job, noteJobId, noteText, setNoteText, setNoteJobId, onAddNote }: JobNotesSectionProps) {
    const [expanded, setExpanded] = useState(false);
    const [files, setFiles] = useState<File[]>([]);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const text = noteJobId === job.id ? noteText : '';

    const expand = () => {
        setExpanded(true);
        if (noteJobId !== job.id) setNoteJobId(job.id);
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

    const handleSubmit = () => {
        onAddNote(files.length > 0 ? files : undefined);
        setFiles([]);
        setExpanded(false);
    };

    const canSubmit = text.trim() || files.length > 0;

    return (
        <div ref={containerRef}>
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
                        onChange={e => { setNoteJobId(job.id); setNoteText(e.target.value); }}
                        onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSubmit) { e.preventDefault(); handleSubmit(); } }}
                        onInput={e => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }}
                        autoFocus
                    />
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <NoteAttachmentInput files={files} onChange={setFiles} compact />
                            <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Cmd + Enter</p>
                        </div>
                        <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
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

export function JobMobileAddNote({ job, noteJobId, noteText, setNoteText, setNoteJobId, onAddNote }: JobNotesSectionProps) {
    const [files, setFiles] = useState<File[]>([]);
    const canSubmit = (noteText.trim() || files.length > 0) && noteJobId === job.id;

    const handleSubmit = () => {
        onAddNote(files.length > 0 ? files : undefined);
        setFiles([]);
    };

    return (
        <div className="space-y-2">
            <textarea
                className="w-full border rounded-md px-3 py-2 text-sm resize-none min-h-[60px]"
                placeholder="Write a note..."
                value={noteJobId === job.id ? noteText : ''}
                onChange={e => { setNoteJobId(job.id); setNoteText(e.target.value); }}
                onFocus={() => { if (noteJobId !== job.id) setNoteJobId(job.id); }}
            />
            <div className="flex items-center justify-between">
                <NoteAttachmentInput files={files} onChange={setFiles} />
                <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
                    <Plus className="size-4 mr-1" /> Add Note
                </Button>
            </div>
        </div>
    );
}
