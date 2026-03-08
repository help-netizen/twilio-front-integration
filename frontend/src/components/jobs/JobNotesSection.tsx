import { useState } from 'react';
import { Button } from '../ui/button';
import { CornerDownLeft, Plus } from 'lucide-react';
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
    const [isFocused, setIsFocused] = useState(false);
    const [isEditingComments, setIsEditingComments] = useState(false);

    const handleSaveComments = async () => {
        setIsFocused(false);
        if (!comments.trim()) setIsEditingComments(false);
        // TODO: save comments via API when endpoint exists
    };

    return (
        <div>
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">Comments</h3>
            {(comments.trim() || isEditingComments) ? (
                <div className="relative bg-rose-50 rounded-lg border border-rose-100 py-1 px-2">
                    <textarea
                        ref={el => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }}
                        className="w-full text-sm resize-none bg-transparent border-none outline-none min-h-[24px] pr-16 leading-6"
                        value={comments}
                        onChange={e => setComments(e.target.value)}
                        onFocus={() => setIsFocused(true)}
                        onBlur={handleSaveComments}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSaveComments(); } }}
                        placeholder="Add comments..."
                        rows={1}
                        autoFocus={isEditingComments}
                        style={{ height: 'auto', minHeight: '24px' }}
                        onInput={e => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }}
                    />
                    {isFocused && (
                        <Button size="sm" className="absolute top-1 right-1.5 h-6 px-2 text-xs"
                            onMouseDown={e => e.preventDefault()} onClick={handleSaveComments}>
                            <CornerDownLeft className="size-3 mr-1" /> Enter
                        </Button>
                    )}
                </div>
            ) : (
                <button onClick={() => { setIsEditingComments(true); setIsFocused(true); }}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors underline decoration-dashed decoration-1 underline-offset-4">
                    + Add comment
                </button>
            )}
        </div>
    );
}

export function JobNotesList({ job }: { job: LocalJob }) {
    return (
        <div>
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                Job Notes ({job.notes?.length || 0})
            </h3>
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
    return (
        <div className="border-t bg-background p-4 space-y-3">
            <textarea
                className="w-full border rounded-md px-3 py-2 text-sm resize-none min-h-[80px]"
                placeholder="Write a note..."
                value={noteJobId === job.id ? noteText : ''}
                onChange={e => { setNoteJobId(job.id); setNoteText(e.target.value); }}
                onFocus={() => { if (noteJobId !== job.id) setNoteJobId(job.id); }}
                onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onAddNote(); } }}
            />
            <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">⌘ + Enter to submit</p>
                <Button size="sm" onClick={onAddNote} disabled={!noteText.trim() || noteJobId !== job.id}>
                    <Plus className="size-4 mr-1" /> Add Note
                </Button>
            </div>
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
