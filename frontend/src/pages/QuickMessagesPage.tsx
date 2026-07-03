/**
 * QuickMessagesPage — Full settings page for managing quick message templates.
 * Features: list, add, edit, delete, drag-to-reorder.
 *
 * Layout: canonical SettingsPageShell (UI-AUDIT-001 W4) with a readable content
 * column that reserves room on the right for the absolutely-positioned
 * VariablePicker — Blanc tokens and ui/ components throughout.
 */
import { useRef } from 'react';
import { GripVertical, Plus, Pencil, Trash2, Check, X, Loader2, MessageSquareText } from 'lucide-react';
import { useQuickMessages } from '../hooks/useQuickMessages';
import { VariablePicker } from './VariablePicker';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';

export default function QuickMessagesPage() {
    const qm = useQuickMessages();
    const newContentRef = useRef<HTMLTextAreaElement>(null);
    const editContentRef = useRef<HTMLTextAreaElement>(null);

    return (
        <SettingsPageShell
            title="Quick Messages"
            description="Reusable message templates. Drag to reorder."
            actions={qm.saving
                ? (
                    <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>
                        <Loader2 className="w-4 h-4 animate-spin" /> Saving…
                    </div>
                )
                : undefined}
        >
            {/* Width cap + reserved right gutter: the VariablePicker renders at
                left:100% of the textarea wrapper, so the column keeps 140px free. */}
            <div className="space-y-4" style={{ maxWidth: 860, paddingRight: 140 }}>
                {qm.showAddForm ? (
                    <div
                        className="flex flex-col gap-3 rounded-2xl p-4"
                        style={{ background: 'rgba(25,25,25,0.03)' }}
                    >
                        <Input
                            value={qm.newTitle}
                            onChange={e => qm.setNewTitle(e.target.value)}
                            className="font-semibold"
                            placeholder="Message title"
                            autoFocus
                        />
                        <div className="relative">
                            <Textarea
                                ref={newContentRef}
                                value={qm.newContent}
                                onChange={e => qm.setNewContent(e.target.value)}
                                rows={4}
                                placeholder="Message content"
                                className="min-h-20"
                            />
                            <VariablePicker variableFields={qm.variableFields} isOpen={qm.activeVariablePicker === 'add'} onToggle={() => qm.setActiveVariablePicker(qm.activeVariablePicker === 'add' ? null : 'add')} onClose={() => qm.setActiveVariablePicker(null)} contentRef={newContentRef} content={qm.newContent} setContent={qm.setNewContent} />
                        </div>
                        <div className="flex justify-end gap-2">
                            <Button variant="ghost" onClick={() => { qm.setShowAddForm(false); qm.setNewTitle(''); qm.setNewContent(''); }}>Cancel</Button>
                            <Button onClick={qm.handleAdd} disabled={qm.saving || !qm.newTitle.trim() || !qm.newContent.trim()}>
                                {qm.saving ? 'Saving…' : 'Add Message'}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <Button
                        variant="secondary"
                        onClick={() => qm.setShowAddForm(true)}
                        className="w-full justify-start"
                    >
                        <Plus className="w-4 h-4" /> Add Message
                    </Button>
                )}

                {qm.loading ? (
                    <div className="flex items-center justify-center py-12">
                        <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--blanc-ink-3)' }} />
                    </div>
                ) : qm.messages.length === 0 && !qm.showAddForm ? (
                    <div
                        className="flex flex-col items-center rounded-2xl py-12 text-center"
                        style={{ background: 'rgba(25,25,25,0.03)', color: 'var(--blanc-ink-3)' }}
                    >
                        <MessageSquareText className="w-9 h-9 mb-3" style={{ color: 'var(--blanc-ink-3)' }} />
                        <div className="text-[15px] font-medium" style={{ color: 'var(--blanc-ink-2)' }}>No quick messages yet</div>
                        <div className="text-[13px] mt-1">Click the button above to create your first template.</div>
                    </div>
                ) : (
                    <div className="flex flex-col gap-1.5">
                        {qm.messages.map((msg, idx) => {
                            const isDragging = qm.dragIdx === idx;
                            const isOver = qm.overIdx === idx && qm.dragIdx !== null;
                            return (
                                <div
                                    key={msg.id}
                                    draggable={qm.editingId !== msg.id}
                                    onDragStart={() => qm.handleDragStart(idx)}
                                    onDragOver={e => qm.handleDragOver(e, idx)}
                                    onDrop={e => qm.handleDrop(e, idx)}
                                    onDragEnd={qm.handleDragEnd}
                                    className="flex items-start gap-2.5 rounded-xl border p-3 transition-colors"
                                    style={{
                                        borderColor: isDragging || isOver ? 'var(--blanc-job)' : 'var(--blanc-line)',
                                        background: isDragging || isOver ? 'var(--blanc-job-soft)' : 'var(--blanc-surface-strong)',
                                        opacity: isDragging ? 0.5 : 1,
                                        cursor: qm.editingId === msg.id ? 'default' : 'grab',
                                    }}
                                >
                                    <div className="mt-0.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }}><GripVertical className="w-5 h-5" /></div>
                                    {qm.editingId === msg.id ? (
                                        <div className="flex-1 flex flex-col gap-2">
                                            <Input value={qm.editTitle} onChange={e => qm.setEditTitle(e.target.value)} className="h-8 font-semibold" placeholder="Title" autoFocus />
                                            <div className="relative">
                                                <Textarea ref={editContentRef} value={qm.editContent} onChange={e => qm.setEditContent(e.target.value)} rows={3} placeholder="Message content" className="min-h-16" />
                                                <VariablePicker variableFields={qm.variableFields} isOpen={qm.activeVariablePicker === 'edit'} onToggle={() => qm.setActiveVariablePicker(qm.activeVariablePicker === 'edit' ? null : 'edit')} onClose={() => qm.setActiveVariablePicker(null)} contentRef={editContentRef} content={qm.editContent} setContent={qm.setEditContent} />
                                            </div>
                                            <div className="flex gap-2">
                                                <Button size="sm" onClick={qm.handleSaveEdit} disabled={qm.saving}><Check className="w-4 h-4" /> Save</Button>
                                                <Button size="sm" variant="ghost" onClick={() => qm.setEditingId(null)}><X className="w-4 h-4" /> Cancel</Button>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>{msg.title}</div>
                                                <div className="text-[13px] mt-0.5 whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--blanc-ink-2)' }}>{msg.content}</div>
                                            </div>
                                            <div className="flex gap-1 shrink-0">
                                                <Button variant="ghost" size="icon" className="size-8" onClick={() => qm.startEdit(msg)} title="Edit"><Pencil className="w-4 h-4" /></Button>
                                                <Button variant="ghost" size="icon" className="size-8 hover:text-[var(--blanc-danger)]" onClick={() => qm.handleDelete(msg.id)} title="Delete"><Trash2 className="w-4 h-4" /></Button>
                                            </div>
                                        </>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </SettingsPageShell>
    );
}
