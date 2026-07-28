import { useState, useRef, useEffect } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';
import { updateJobDescription, type LocalJob } from '../../services/jobsApi';
import { useAuthz } from '../../hooks/useAuthz';
import { useIsMobile } from '../../hooks/useIsMobile';
import { NoteComposerOverlay } from '../shared/NoteComposerOverlay';

/**
 * Job description — inline-editable (click to edit, saves on blur). Heading matches
 * the Finance heading. Editable only for `jobs.edit`; empty shows a soft prompt.
 *
 * On MOBILE the edit does NOT happen in place (the keyboard would cover it, and a
 * deferred focus needs a second tap). Instead the first tap opens the floating
 * hover-input above the keyboard (NoteComposerOverlay) with a round save arrow —
 * same pattern as the note composer.
 */
export function JobDescription({ job, onJobUpdated }: { job: LocalJob; onJobUpdated?: (job: LocalJob) => void }) {
    const { hasPermission } = useAuthz();
    const isMobile = useIsMobile();
    const canEdit = hasPermission('jobs.edit');
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(job.description || '');
    const [saving, setSaving] = useState(false);
    const taRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => { setText(job.description || ''); }, [job.id, job.description]);

    const autoGrow = (el: HTMLTextAreaElement | null) => {
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    };

    const startEdit = () => {
        if (!canEdit || saving) return;
        setEditing(true);
        // Desktop focuses the inline textarea; mobile's overlay textarea autoFocuses itself.
        if (!isMobile) setTimeout(() => { taRef.current?.focus(); autoGrow(taRef.current); }, 0);
    };

    const save = async () => {
        setEditing(false);
        const next = text.trim();
        if (next === (job.description || '').trim()) return; // unchanged
        setSaving(true);
        try {
            const updated = await updateJobDescription(job.id, next);
            onJobUpdated?.(updated);
        } catch {
            setText(job.description || ''); // revert on failure
        } finally {
            setSaving(false);
        }
    };

    const heading = (
        <h2
            className="text-xl font-semibold mb-3"
            style={{ fontFamily: 'var(--blanc-font-heading)', letterSpacing: '-0.02em', color: 'var(--blanc-ink-1)' }}
        >
            Description
        </h2>
    );

    // Desktop inline edit (keyboard isn't a problem there).
    if (editing && !isMobile) {
        return (
            <div>
                {heading}
                <textarea
                    ref={taRef}
                    className="w-full resize-none rounded-lg p-3 text-sm outline-none"
                    style={{ background: 'var(--blanc-field)', color: 'var(--blanc-ink-1)', minHeight: 76 }}
                    value={text}
                    placeholder="Add a description…"
                    onChange={e => { setText(e.target.value); autoGrow(e.target); }}
                    onBlur={save}
                    onKeyDown={e => {
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
                        if (e.key === 'Escape') { setText(job.description || ''); setEditing(false); }
                    }}
                />
            </div>
        );
    }

    return (
        <div>
            {heading}
            <div
                onClick={startEdit}
                className="p-3 rounded-lg transition-colors"
                style={{ background: 'var(--blanc-surface-muted)', cursor: canEdit ? 'text' : 'default' }}
                title={canEdit ? 'Click to edit' : undefined}
            >
                <p className="text-sm whitespace-pre-wrap" style={{ color: job.description ? 'var(--blanc-ink-1)' : 'var(--blanc-ink-3)' }}>
                    {job.description || (canEdit ? 'Add a description…' : 'No description')}
                </p>
            </div>

            {/* Mobile: first tap floats the input above the keyboard; save arrow writes it back. */}
            <NoteComposerOverlay open={editing && isMobile} onClose={save}>
                <div style={{ background: 'var(--blanc-field)', borderRadius: 16, padding: '10px 12px' }}>
                    <textarea
                        autoFocus
                        className="w-full resize-none bg-transparent outline-none"
                        style={{ border: 'none', fontSize: 16, lineHeight: 1.5, color: 'var(--blanc-ink-1)', minHeight: 72, padding: '2px 2px 0' }}
                        value={text}
                        placeholder="Add a description…"
                        onChange={e => setText(e.target.value)}
                    />
                    <div className="flex items-center justify-end" style={{ marginTop: 6 }}>
                        <button
                            type="button"
                            onClick={save}
                            aria-label="Save description"
                            className="flex shrink-0 items-center justify-center rounded-full transition-opacity"
                            style={{ width: 40, height: 40, background: 'var(--blanc-accent)', color: '#fff' }}
                        >
                            {saving ? <Loader2 className="size-5 animate-spin" /> : <ArrowUp className="size-5" />}
                        </button>
                    </div>
                </div>
            </NoteComposerOverlay>
        </div>
    );
}
