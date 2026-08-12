/**
 * NotesSection — unified notes component for any entity (job, lead, contact).
 *
 * Self-contained: fetches, posts, edits and soft-deletes notes via API.
 * Usage: <NotesSection entityType="job" entityId={123} />
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { Plus, MoreVertical, Pencil, Trash2, X, ArrowUp, Check, Loader2, Sparkles } from 'lucide-react';
import { NoteAttachmentInput, type AttachmentState } from './NoteAttachmentInput';
import { NoteAttachmentDisplay } from './NoteAttachmentDisplay';
import { authedFetch } from '../../services/apiClient';
import { useAuthz } from '../../hooks/useAuthz';
import { FullScreenTextEditor } from './FullScreenTextEditor';
import { polishReport } from '../../services/estimatesApi';
import { toast } from 'sonner';
import { TaskStack } from '../tasks/TaskStack';
import { prepareNotesForDisplay } from './notesDisplay';
import { useIsMobile } from '../../hooks/useIsMobile';
import { NoteComposerOverlay, useVisibleViewportHeight } from './NoteComposerOverlay';

// ─── Types ───────────────────────────────────────────────────────────────────

interface NoteAttachment {
    id: number | string;
    fileName: string;
    contentType: string;
    fileSize: number;
    url?: string;
    source?: string;
}

interface Note {
    id?: string;
    text: string | null;
    created?: string | null;
    author?: string;
    migrated?: boolean;
    source?: string | null;
    created_by?: string | null;
    zb_note_id?: string | null;
    /** Server-authoritative edit/delete permission for the current user (NOTE-AUTHOR-FIX-001). */
    can_edit?: boolean;
    attachments?: NoteAttachment[];
}

interface NotesSectionProps {
    entityType: 'job' | 'lead' | 'contact';
    entityId: string | number;
    /** Optional callback after note is added/edited/deleted (e.g. to refresh parent) */
    onNoteAdded?: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOTE_BG = '#fef9e7';

function formatDate(iso?: string | null): string {
    if (!iso) return 'Unknown date';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'Unknown date';
    try {
        return new Intl.DateTimeFormat('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit',
        }).format(d);
    } catch {
        return iso;
    }
}

function apiPath(entityType: string, entityId: string | number): string {
    switch (entityType) {
        case 'job': return `/api/jobs/${entityId}/notes`;
        case 'lead': return `/api/leads/${entityId}/notes`;
        case 'contact': return `/api/contacts/${entityId}/notes`;
        default: return `/api/${entityType}s/${entityId}/notes`;
    }
}

// ─── Component ───────────────────────────────────────────────────────────────

export function NotesSection({ entityType, entityId, onNoteAdded }: NotesSectionProps) {
    const { user, isTenantAdmin, hasAnyPermission, membership } = useAuthz();
    const myId = user?.sub;
    const isAdmin = isTenantAdmin();
    // REPORT-POLISH-001: the "Polish report" composer action is Provider-only.
    const isProvider = membership?.role_key === 'provider';
    const canCreateTask = hasAnyPermission('tasks.create', 'tasks.manage');
    const [taskCreateOpen, setTaskCreateOpen] = useState(false);

    const [notes, setNotes] = useState<Note[]>([]);
    const [text, setText] = useState('');
    const [composeAttach, setComposeAttach] = useState<AttachmentState>({ ids: [], blocked: false });
    const [composeAttachKey, setComposeAttachKey] = useState(0);
    const [expanded, setExpanded] = useState(false);
    // Mobile opens the composer as a floating overlay docked above the keyboard
    // (NoteComposerOverlay); desktop expands it inline. Same content either way.
    const isMobile = useIsMobile();
    const [submitting, setSubmitting] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // REPORT-POLISH-001: turn the note text into a full professional report via the LLM, then
    // review it in a full-screen (type B) editor. Accept → the report replaces the note text;
    // Cancel → the note keeps the text the provider originally typed (we never mutate `text`
    // until Accept). Re-polish re-runs on the editor's current (possibly edited) text.
    const [polishOpen, setPolishOpen] = useState(false);
    const [polishBusy, setPolishBusy] = useState(false);
    const [polishText, setPolishText] = useState('');

    const reportPolishError = (e: any) => {
        const msg = e?.code === 'app_disabled'
            ? 'Report → Estimate is turned off — enable it in Settings → Integrations.'
            : e?.code === 'provider_only'
                ? 'Report polishing is available to Providers only.'
                : (e?.message || 'Could not polish the report');
        toast.error(msg);
    };

    const startPolish = async () => {
        const src = text.trim();
        if (!src || polishBusy) return;
        setPolishText('');
        setPolishOpen(true);
        setPolishBusy(true);
        try {
            setPolishText(await polishReport(src));
        } catch (e) {
            reportPolishError(e);
            setPolishOpen(false);
        } finally {
            setPolishBusy(false);
        }
    };

    const repolish = async (current: string) => {
        const src = current.trim();
        if (!src || polishBusy) return;
        setPolishBusy(true);
        try {
            setPolishText(await polishReport(src));
        } catch (e) {
            reportPolishError(e); // keep the editor open so edits aren't lost
        } finally {
            setPolishBusy(false);
        }
    };

    const renderPolishButton = (size: number) => isProvider ? (
        <button
            type="button"
            onMouseDown={e => e.preventDefault()}
            onClick={startPolish}
            disabled={!text.trim() || polishBusy}
            aria-label="Polish report"
            title="Turn your note into a full technician report · Provider only"
            className="flex shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-80 disabled:opacity-40"
            style={{ width: size, height: size, background: 'var(--blanc-surface-strong)', color: 'var(--blanc-accent)' }}
        >
            {polishBusy ? <Loader2 className="size-5 animate-spin" /> : <Sparkles className="size-5" />}
        </button>
    ) : null;

    // Edit state
    const [editingKey, setEditingKey] = useState<string | null>(null);
    const [editText, setEditText] = useState('');
    const [editAttach, setEditAttach] = useState<AttachmentState>({ ids: [], blocked: false });
    const [editAttachKey, setEditAttachKey] = useState(0);
    const [removeIds, setRemoveIds] = useState<Set<string>>(new Set());
    const [editSubmitting, setEditSubmitting] = useState(false);
    const [editError, setEditError] = useState<string | null>(null);
    const [menuOpenKey, setMenuOpenKey] = useState<string | null>(null);

    const basePath = apiPath(entityType, entityId);

    // Prefer the server-authoritative flag (NOTE-AUTHOR-FIX-001) — it matches the
    // note author by EITHER the Keycloak sub OR the crm_users.id, which the client
    // can't do (it only knows `sub`). Fall back to the local heuristic when a note
    // predates the flag (older payloads / entities not yet returning it).
    const canEdit = (n: Note) =>
        n.can_edit ?? (
            isAdmin ? true
            // Only a genuine ZB-ORIGIN note (explicit source) is admin-only in the
            // fallback. A note with a zb_note_id but a local created_by was authored
            // here and merely pushed to Zenbooker — its author keeps edit rights
            // (NOTE-ZB-AUTHOR-FIX-001). The server-authoritative can_edit above is the
            // real gate; this fallback only runs for legacy payloads without it.
            : n.source === 'zenbooker' ? false
            : n.created_by ? n.created_by === myId
            : false
        );
    const canDelete = canEdit;

    const fetchNotes = useCallback(async () => {
        try {
            const res = await authedFetch(basePath);
            const data = await res.json();
            if (data.ok || data.data) setNotes(data.data || []);
        } catch { /* silent — notes are non-critical */ }
    }, [basePath]);

    useEffect(() => { fetchNotes(); }, [fetchNotes]);

    const submitNote = useCallback(async (noteText: string) => {
        if ((!noteText.trim() && composeAttach.ids.length === 0) || composeAttach.blocked) return;
        setSubmitting(true);
        try {
            const formData = new FormData();
            formData.append('text', noteText.trim());
            // NOTE-ATTACH-UPLOAD-001: files are already uploaded (staged) — send their ids.
            formData.append('attachment_ids', JSON.stringify(composeAttach.ids));

            await authedFetch(basePath, { method: 'POST', body: formData });
            setText('');
            setComposeAttach({ ids: [], blocked: false });
            setComposeAttachKey(k => k + 1); // remount the input → clears its chips
            setExpanded(false);
            fetchNotes();
            onNoteAdded?.();
        } catch (err) {
            console.error('[NotesSection] Failed to add note:', err);
        } finally {
            setSubmitting(false);
        }
    }, [composeAttach, basePath, fetchNotes, onNoteAdded]);

    const handleSubmit = useCallback(() => submitNote(text), [submitNote, text]);


    // NOTE-COMPOSER-KEYBOARD: mobile uses the INLINE composer (normal document flow), not a
    // fixed bottom sheet. iOS natively scrolls a focused normal-flow input above the keyboard
    // (proven by the inline note editor), whereas a fixed sheet stays behind it in standalone
    // PWA (visualViewport doesn't report the keyboard there). So add + edit are both inline.
    const expand = () => {
        setExpanded(true);
        setTimeout(() => textareaRef.current?.focus(), 0);
    };

    // Click-outside to collapse
    const handleClickOutside = useCallback((e: MouseEvent) => {
        // Don't collapse while an upload is in flight (blocked) — ids is still empty then,
        // so collapsing would unmount the input and drop the in-progress chip.
        if (!containerRef.current?.contains(e.target as Node) && !text.trim() && composeAttach.ids.length === 0 && !composeAttach.blocked) {
            setExpanded(false);
        }
    }, [text, composeAttach.ids.length, composeAttach.blocked]);

    useEffect(() => {
        // Desktop-only: on mobile the composer is a portaled overlay (outside containerRef),
        // so this outside-click would fire when tapping the textarea and collapse it.
        if (expanded && !isMobile) {
            document.addEventListener('mousedown', handleClickOutside);
            return () => document.removeEventListener('mousedown', handleClickOutside);
        }
    }, [expanded, isMobile, handleClickOutside]);

    // ─── Edit / Delete ───────────────────────────────────────────────────────

    const startEdit = (note: Note, renderKey: string) => {
        setMenuOpenKey(null);
        setEditingKey(renderKey);
        setEditText(note.text ?? '');
        setEditAttach({ ids: [], blocked: false });
        setEditAttachKey(k => k + 1);
        setRemoveIds(new Set());
        setEditError(null);
    };

    const cancelEdit = () => {
        setEditingKey(null);
        setEditText('');
        setEditAttach({ ids: [], blocked: false });
        setRemoveIds(new Set());
        setEditError(null);
    };

    const toggleRemoveAttachment = (id: number | string) => {
        const key = String(id);
        setRemoveIds(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    };

    const saveEdit = useCallback(async (note: Note) => {
        if (!note.id) return;
        setEditSubmitting(true);
        setEditError(null);
        try {
            const formData = new FormData();
            formData.append('text', editText.trim());
            formData.append('remove_attachment_ids', JSON.stringify([...removeIds]));
            formData.append('attachment_ids', JSON.stringify(editAttach.ids));

            const res = await authedFetch(`${basePath}/${note.id}`, { method: 'PATCH', body: formData });
            if (!res.ok) {
                setEditError(res.status === 403 ? 'You can’t edit this note.' : 'Failed to save note.');
                return;
            }
            cancelEdit();
            fetchNotes();
            onNoteAdded?.();
        } catch (err) {
            console.error('[NotesSection] Failed to edit note:', err);
            setEditError('Failed to save note.');
        } finally {
            setEditSubmitting(false);
        }
    }, [editText, removeIds, editAttach, basePath, fetchNotes, onNoteAdded]);

    const deleteNote = useCallback(async (note: Note) => {
        if (!note.id) return;
        setMenuOpenKey(null);
        if (!window.confirm('Delete this note? This cannot be undone.')) return;
        try {
            const res = await authedFetch(`${basePath}/${note.id}`, { method: 'DELETE' });
            if (!res.ok) {
                console.error('[NotesSection] Failed to delete note:', res.status);
                return;
            }
            fetchNotes();
            onNoteAdded?.();
        } catch (err) {
            console.error('[NotesSection] Failed to delete note:', err);
        }
    }, [basePath, fetchNotes, onNoteAdded]);

    // Close kebab menu on outside click
    useEffect(() => {
        if (!menuOpenKey) return;
        const close = () => setMenuOpenKey(null);
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [menuOpenKey]);

    // Grow up to the top of the visible area, then let the text scroll inside the card. The
    // ceiling is the VISIBLE height (visualViewport), not innerHeight — the latter counts space
    // hidden behind Safari's toolbars / the keyboard and let the card grow off-screen.
    const composerViewportHeight = useVisibleViewportHeight(isMobile && (expanded || !!editingKey));
    const composerMaxHeight = Math.max(96, composerViewportHeight - 150);
    const growComposer = (el: HTMLTextAreaElement) => {
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, composerMaxHeight)}px`;
    };

    const canSubmit = (!!text.trim() || composeAttach.ids.length > 0) && !submitting && !composeAttach.blocked;
    const canSaveEdit = (!!editText.trim() || editAttach.ids.length > 0) && !editSubmitting && !editAttach.blocked;

    const displayedNotes = prepareNotesForDisplay(notes);
    // The note being edited — on mobile it opens the same floating overlay as add.
    const editingNote = editingKey ? displayedNotes.find(d => d.renderKey === editingKey)?.note ?? null : null;

    return (
        <div ref={containerRef} className="space-y-3">
            {/* Add note input — always at top. Desktop expands inline; mobile keeps the
                button and opens the floating overlay below (docked above the keyboard). */}
            {expanded && !isMobile ? (
                /* COMPOSER-CANON-001 (OB-38): the desktop inline composer matches the mobile
                   one — a single rounded filled card holding a roomy borderless textarea over a
                   row of round action buttons (attach + violet send-arrow, no "Add note" label).
                   The attach circle rides a white ground so it stays visible on the field card. */
                <div style={{ background: 'var(--blanc-field)', borderRadius: 16, padding: '10px 12px' }}>
                    <textarea
                        ref={textareaRef}
                        className="w-full resize-none outline-none bg-transparent"
                        style={{
                            border: 'none',
                            padding: '2px 2px 0',
                            minHeight: 160, // long service reports — the box grows from here
                            fontSize: 15,
                            lineHeight: 1.5,
                            color: 'var(--blanc-ink-1)',
                        }}
                        placeholder="Write a note…"
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
                    <div className="flex items-center justify-between" style={{ marginTop: 8 }}>
                        <div className="flex items-center gap-3">
                            <NoteAttachmentInput key={composeAttachKey} entityType={entityType} entityId={entityId} onStateChange={setComposeAttach} variant="round" roundBg="var(--blanc-surface-strong)" />
                            {renderPolishButton(44)}
                            <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>⌘ + Enter</p>
                        </div>
                        <button
                            type="button"
                            onMouseDown={e => e.preventDefault()}
                            onClick={handleSubmit}
                            disabled={!canSubmit}
                            aria-label="Add note"
                            className="flex shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-40"
                            style={{ width: 44, height: 44, background: 'var(--blanc-accent)', color: '#fff' }}
                        >
                            {submitting ? <Loader2 className="size-5 animate-spin" /> : <ArrowUp className="size-5" />}
                        </button>
                    </div>
                </div>
            ) : (
                <div className="flex items-center gap-2">
                    {/* NOTE-TASK-BAR-AFFORDANCE-001 variant C: the frequent primary action
                        (Add note) gets a soft violet fill so it stops disappearing; Add task
                        stays a calm neutral chip. Filled affordances read as tappable without a
                        loud border — the old transparent + faint hairline vanished on the panel. */}
                    <button
                        onClick={expand}
                        className="flex-1 flex items-center gap-2 transition-opacity hover:opacity-80"
                        style={{
                            height: 36,
                            borderRadius: 10,
                            border: 'none',
                            background: 'var(--blanc-accent-soft)',
                            paddingLeft: 12,
                            paddingRight: 12,
                            cursor: 'text',
                            textAlign: 'left',
                        }}
                    >
                        <Plus className="size-4 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                        <span className="text-sm font-medium" style={{ color: 'var(--blanc-accent)' }}>Add note…</span>
                    </button>
                    {canCreateTask && (
                        <button
                            onClick={() => setTaskCreateOpen(true)}
                            className="flex items-center gap-1.5 shrink-0 transition-opacity hover:opacity-80"
                            style={{
                                height: 36,
                                borderRadius: 10,
                                border: 'none',
                                background: 'var(--blanc-field)',
                                paddingLeft: 12,
                                paddingRight: 12,
                                cursor: 'pointer',
                                color: 'var(--blanc-ink-1)',
                            }}
                            title="Add task"
                        >
                            <Plus className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-2)' }} />
                            <span className="text-sm font-medium">Add task</span>
                        </button>
                    )}
                </div>
            )}

            {/* Mobile: floating ADD composer docked above the keyboard (NOTE-COMPOSER-KEYBOARD).
                One filled --blanc-field card — borderless textarea over the round action row —
                identical to the desktop composer / Pulse reply (COMPOSER-CANON). */}
            {/* Mobile ADD composer (owner reference: Todoist). A card docked above the
                keyboard that GROWS with the text — from two lines up to the top of the
                screen, then the text scrolls inside. No title, no divider: just the text
                and the action row. */}
            <NoteComposerOverlay open={expanded && isMobile} onClose={() => setExpanded(false)}>
                <div style={{ background: 'var(--blanc-field)', borderRadius: 16, padding: '10px 12px' }}>
                    <textarea
                        className="w-full resize-none outline-none bg-transparent"
                        style={{
                            border: 'none',
                            padding: '2px 2px 0',
                            minHeight: 72,
                            maxHeight: composerMaxHeight,
                            overflowY: 'auto',
                            fontSize: 16,
                            lineHeight: 1.5,
                            color: 'var(--blanc-ink-1)',
                        }}
                        placeholder="Write a note…"
                        value={text}
                        onChange={e => setText(e.target.value)}
                        onInput={e => growComposer(e.target as HTMLTextAreaElement)}
                        ref={el => { if (el) growComposer(el); }}
                        autoFocus
                    />
                    <div className="flex items-center justify-between gap-3" style={{ marginTop: 6 }}>
                        <div className="flex items-center gap-2">
                            <NoteAttachmentInput key={composeAttachKey} entityType={entityType} entityId={entityId} onStateChange={setComposeAttach} variant="round" roundBg="var(--blanc-surface-strong)" />
                            {renderPolishButton(40)}
                        </div>
                        <button
                            type="button"
                            onClick={handleSubmit}
                            disabled={!canSubmit}
                            aria-label="Add note"
                            className="flex shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-40"
                            style={{ width: 40, height: 40, background: 'var(--blanc-accent)', color: '#fff' }}
                        >
                            {submitting ? <Loader2 className="size-5 animate-spin" /> : <ArrowUp className="size-5" />}
                        </button>
                    </div>
                </div>
            </NoteComposerOverlay>

            {/* Mobile: floating EDIT composer — same overlay + canon card as add. */}
            <NoteComposerOverlay open={!!editingNote && isMobile} onClose={cancelEdit}>
                {editingNote && (
                    <div style={{ background: 'var(--blanc-field)', borderRadius: 16, padding: '10px 12px' }}>
                        <textarea
                            className="w-full resize-none outline-none bg-transparent"
                            style={{ border: 'none', padding: '2px 2px 0', minHeight: 72, maxHeight: composerMaxHeight, overflowY: 'auto', fontSize: 16, lineHeight: 1.5, color: 'var(--blanc-ink-1)' }}
                            placeholder="Write a note…"
                            value={editText}
                            onChange={e => setEditText(e.target.value)}
                            onInput={e => growComposer(e.target as HTMLTextAreaElement)}
                            ref={el => { if (el) growComposer(el); }}
                            autoFocus
                        />
                        {editingNote.attachments && editingNote.attachments.length > 0 && (
                            <div className="flex flex-wrap gap-1.5" style={{ marginTop: 8 }}>
                                {editingNote.attachments.map(att => {
                                    const marked = removeIds.has(String(att.id));
                                    return (
                                        <div key={att.id} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs" style={{ background: 'rgba(25,25,25,0.06)', border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-2)', opacity: marked ? 0.4 : 1, textDecoration: marked ? 'line-through' : 'none' }}>
                                            <span className="max-w-[120px] truncate">{att.fileName}</span>
                                            <button type="button" onClick={() => toggleRemoveAttachment(att.id)} className="hover:opacity-70" style={{ color: 'var(--blanc-ink-3)' }} title={marked ? 'Keep attachment' : 'Remove attachment'}>
                                                <X className="size-3" />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        {editError && <p className="text-xs" style={{ color: '#b42318', marginTop: 8 }}>{editError}</p>}
                        <div className="flex items-center justify-end gap-4" style={{ marginTop: 6 }}>
                            <div className="mr-auto"><NoteAttachmentInput key={editAttachKey} entityType={entityType} entityId={entityId} onStateChange={setEditAttach} variant="round" roundBg="var(--blanc-surface-strong)" /></div>
                            <button type="button" onMouseDown={e => e.preventDefault()} onClick={cancelEdit} disabled={editSubmitting} className="text-sm font-medium disabled:opacity-40" style={{ color: 'var(--blanc-ink-2)' }}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                onMouseDown={e => e.preventDefault()}
                                onClick={() => saveEdit(editingNote)}
                                disabled={!canSaveEdit}
                                aria-label="Save note"
                                className="flex shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-40"
                                style={{ width: 40, height: 40, background: 'var(--blanc-accent)', color: '#fff' }}
                            >
                                {editSubmitting ? <Loader2 className="size-5 animate-spin" /> : <Check className="size-5" />}
                            </button>
                        </div>
                    </div>
                )}
            </NoteComposerOverlay>

            {/* Pinned tasks — TASKS-001 (tasks live at the top of the notes feed) */}
            <TaskStack
                parentType={entityType}
                parentId={entityId}
                showAddButton={false}
                createOpen={taskCreateOpen}
                onCreateOpenChange={setTaskCreateOpen}
            />

            {/* Notes list — newest first */}
            {displayedNotes.map(({ note, renderKey }) => {
                const editing = editingKey === renderKey;
                const showKebab = !editing && !!note.id && canEdit(note);
                return (
                    <div key={renderKey} className="relative p-3 rounded-xl space-y-2" style={{ background: NOTE_BG }}>
                        {editing && !isMobile ? (
                            <div className="space-y-2">
                                <textarea
                                    className="w-full resize-none outline-none"
                                    style={{
                                        background: 'var(--blanc-surface-strong)',
                                        border: 'none',
                                        borderRadius: 12,
                                        padding: '8px 12px',
                                        minHeight: 72,
                                        fontSize: 15,
                                        lineHeight: 1.5,
                                        color: 'var(--blanc-ink-1)',
                                    }}
                                    placeholder="Write a note…"
                                    value={editText}
                                    onChange={e => setEditText(e.target.value)}
                                    onInput={e => {
                                        const t = e.target as HTMLTextAreaElement;
                                        t.style.height = 'auto';
                                        t.style.height = `${t.scrollHeight}px`;
                                    }}
                                    autoFocus
                                />

                                {/* Existing attachments — mark for removal */}
                                {note.attachments && note.attachments.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5">
                                        {note.attachments.map(att => {
                                            const marked = removeIds.has(String(att.id));
                                            return (
                                                <div
                                                    key={att.id}
                                                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs"
                                                    style={{
                                                        background: 'rgba(25,25,25,0.06)',
                                                        border: '1px solid var(--blanc-line)',
                                                        color: 'var(--blanc-ink-2)',
                                                        opacity: marked ? 0.4 : 1,
                                                        textDecoration: marked ? 'line-through' : 'none',
                                                    }}
                                                >
                                                    <span className="max-w-[120px] truncate">{att.fileName}</span>
                                                    <button
                                                        type="button"
                                                        onMouseDown={e => e.preventDefault()}
                                                        onClick={() => toggleRemoveAttachment(att.id)}
                                                        className="hover:opacity-70"
                                                        style={{ color: 'var(--blanc-ink-3)' }}
                                                        title={marked ? 'Keep attachment' : 'Remove attachment'}
                                                    >
                                                        <X className="size-3" />
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}

                                {editError && (
                                    <p className="text-xs" style={{ color: '#b42318' }}>{editError}</p>
                                )}

                                {/* Composer-canon action row: round attach + Cancel + round violet Save. */}
                                <div className="flex items-center justify-between gap-2">
                                    <NoteAttachmentInput key={editAttachKey} entityType={entityType} entityId={entityId} onStateChange={setEditAttach} variant="round" roundBg="var(--blanc-surface-strong)" />
                                    <div className="flex items-center gap-4">
                                        <button type="button" onMouseDown={e => e.preventDefault()} onClick={cancelEdit} disabled={editSubmitting} className="text-sm font-medium disabled:opacity-40" style={{ color: 'var(--blanc-ink-2)' }}>
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            onMouseDown={e => e.preventDefault()}
                                            onClick={() => saveEdit(note)}
                                            disabled={!canSaveEdit}
                                            aria-label="Save note"
                                            className="flex shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-40"
                                            style={{ width: 44, height: 44, background: 'var(--blanc-accent)', color: '#fff' }}
                                        >
                                            {editSubmitting ? <Loader2 className="size-5 animate-spin" /> : <Check className="size-5" />}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <>
                                {showKebab && (
                                    <div className="absolute top-2 right-2">
                                        <button
                                            type="button"
                                            onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                                            onClick={e => {
                                                e.stopPropagation();
                                                setMenuOpenKey(menuOpenKey === renderKey ? null : renderKey);
                                            }}
                                            className="p-1 rounded-md transition-opacity hover:opacity-70"
                                            style={{ color: 'var(--blanc-ink-3)' }}
                                            title="Note actions"
                                        >
                                            <MoreVertical className="size-4" />
                                        </button>
                                        {menuOpenKey === renderKey && (
                                            <div
                                                className="absolute right-0 mt-1 z-50 min-w-[120px] rounded-xl overflow-hidden"
                                                style={{
                                                    background: 'var(--blanc-surface-strong, #fffdf9)',
                                                    border: '1px solid var(--blanc-line)',
                                                }}
                                                onMouseDown={e => e.stopPropagation()}
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() => startEdit(note, renderKey)}
                                                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-[rgba(25,25,25,0.06)]"
                                                    style={{ color: 'var(--blanc-ink-1)' }}
                                                >
                                                    <Pencil className="size-3.5" /> Edit
                                                </button>
                                                {canDelete(note) && (
                                                    <button
                                                        type="button"
                                                        onClick={() => deleteNote(note)}
                                                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-[rgba(25,25,25,0.06)]"
                                                        style={{ color: '#b42318' }}
                                                    >
                                                        <Trash2 className="size-3.5" /> Delete
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {note.text && (
                                    <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--blanc-ink-1)', paddingRight: showKebab ? 24 : 0 }}>
                                        {note.text}
                                    </p>
                                )}
                                {note.attachments && note.attachments.length > 0 && (
                                    <NoteAttachmentDisplay attachments={note.attachments} groupKey={`note-${note.id}`} />
                                )}
                                <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                                    {note.author && <span className="font-medium">{note.author} · </span>}
                                    {formatDate(note.created)}
                                    {note.migrated && ' (migrated)'}
                                </p>
                            </>
                        )}
                    </div>
                );
            })}

            {/* REPORT-POLISH-001 — full-screen (type B) review of the polished report:
                edit, Re-polish, Accept (→ note text) or Cancel (keeps the original text). */}
            <FullScreenTextEditor
                open={polishOpen}
                initialValue={polishText}
                busy={polishBusy}
                title="Report"
                doneLabel="Accept"
                repolishLabel="Re-polish"
                onRepolish={repolish}
                onDone={(t) => { setText(t); setPolishOpen(false); }}
                onCancel={() => setPolishOpen(false)}
            />

        </div>
    );
}
