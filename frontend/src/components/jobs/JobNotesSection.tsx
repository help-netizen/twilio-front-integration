import { useState, useRef } from 'react';
import { Button } from '../ui/button';
import { Plus } from 'lucide-react';
import type { LocalJob } from '../../services/jobsApi';
import { formatSchedule } from './jobHelpers';

// ─── Types ───────────────────────────────────────────────────────────────────

interface JobNotesSectionProps {
    job: LocalJob;
    noteJobId: number | null;
    noteText: string;
    setNoteText: (v: string) => void;
    setNoteJobId: (v: number | null) => void;
    onAddNote: () => void;
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
                {job.notes && job.notes.length > 0 ? job.notes.map((note: any, i: number) => (
                    <div key={note.id || i} className="p-3 bg-muted rounded-lg space-y-2">
                        {note.text && <p className="text-sm whitespace-pre-wrap">{note.text}</p>}
                        {note.images && note.images.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                                {note.images.map((url: string, j: number) => (
                                    <a key={j} href={url} target="_blank" rel="noopener noreferrer">
                                        <img
                                            src={url}
                                            alt={`Note image ${j + 1}`}
                                            className="w-24 h-24 object-cover rounded-md border hover:opacity-80 transition-opacity"
                                        />
                                    </a>
                                ))}
                            </div>
                        )}
                        {note.files && note.files.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                                {note.files.map((url: string, j: number) => (
                                    <a key={j} href={url} target="_blank" rel="noopener noreferrer"
                                        className="text-xs text-primary hover:underline">
                                        📎 File {j + 1}
                                    </a>
                                ))}
                            </div>
                        )}
                        {note.created && (
                            <p className="text-xs text-muted-foreground">{formatSchedule(note.created).date}</p>
                        )}
                        {!note.text && (!note.images || note.images.length === 0) && (
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
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const text = noteJobId === job.id ? noteText : '';

    const expand = () => {
        setExpanded(true);
        if (noteJobId !== job.id) setNoteJobId(job.id);
        setTimeout(() => textareaRef.current?.focus(), 0);
    };

    const handleBlur = () => {
        if (!text.trim()) {
            setExpanded(false);
        }
    };

    const handleSubmit = () => {
        onAddNote();
        setExpanded(false);
    };

    return (
        <div style={{
            padding: '10px 14px',
            background: 'rgba(117,106,89,0.03)',
            borderTop: '1px solid rgba(117,106,89,0.08)',
            borderRadius: '0 0 var(--blanc-radius-xl) 0',
        }}>
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
                        onBlur={handleBlur}
                        onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); handleSubmit(); } }}
                        onInput={e => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }}
                        autoFocus
                    />
                    <div className="flex items-center justify-between">
                        <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>⌘ + Enter</p>
                        <Button size="sm" onClick={handleSubmit} disabled={!text.trim()}>
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
    return (
        <div className="space-y-2">
            <textarea
                className="w-full border rounded-md px-3 py-2 text-sm resize-none min-h-[60px]"
                placeholder="Write a note..."
                value={noteJobId === job.id ? noteText : ''}
                onChange={e => { setNoteJobId(job.id); setNoteText(e.target.value); }}
                onFocus={() => { if (noteJobId !== job.id) setNoteJobId(job.id); }}
            />
            <Button size="sm" onClick={onAddNote} disabled={!noteText.trim() || noteJobId !== job.id}>
                <Plus className="size-4 mr-1" /> Add Note
            </Button>
        </div>
    );
}
