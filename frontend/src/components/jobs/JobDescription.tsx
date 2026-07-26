import { useState, useRef, useEffect } from 'react';
import { updateJobDescription, type LocalJob } from '../../services/jobsApi';
import { useAuthz } from '../../hooks/useAuthz';

/**
 * Job description — inline-editable (click to edit, saves on blur). Heading matches
 * the Finance heading. Editable only for `jobs.edit`; empty shows a soft prompt.
 */
export function JobDescription({ job, onJobUpdated }: { job: LocalJob; onJobUpdated?: (job: LocalJob) => void }) {
    const { hasPermission } = useAuthz();
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
        setTimeout(() => { taRef.current?.focus(); autoGrow(taRef.current); }, 0);
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

    if (editing) {
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
        </div>
    );
}
