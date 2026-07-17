/**
 * QuickMessagesPage — Full settings page for managing quick message templates.
 * Features: list, add, edit, delete, drag-to-reorder.
 */
import { useRef } from 'react';
import { GripVertical, Plus, Pencil, Trash2, Check, X, Loader2, MessageSquareText } from 'lucide-react';
import { useQuickMessages } from '../hooks/useQuickMessages';
import { VariablePicker } from './VariablePicker';

export default function QuickMessagesPage() {
    const qm = useQuickMessages();
    const newContentRef = useRef<HTMLTextAreaElement>(null);
    const editContentRef = useRef<HTMLTextAreaElement>(null);

    return (
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
                <div><h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#111827' }}>Quick Messages</h1><p style={{ fontSize: 14, color: '#6b7280', margin: '4px 0 0' }}>Manage message templates. Drag to reorder.</p></div>
                {qm.saving && <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#6b7280' }}><Loader2 className="w-4 h-4 animate-spin" />Saving…</div>}
            </div>

            {qm.showAddForm ? (
                <div style={{ marginBottom: 16, padding: 16, borderRadius: 10, border: '1px solid #e5e7eb', background: '#f9fafb', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <input value={qm.newTitle} onChange={e => qm.setNewTitle(e.target.value)} style={{ width: '100%', padding: '8px 12px', fontSize: 14, fontWeight: 600, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none' }} placeholder="Message title" autoFocus />
                    <div style={{ position: 'relative' }}>
                        <textarea ref={newContentRef} value={qm.newContent} onChange={e => qm.setNewContent(e.target.value)} style={{ width: '100%', padding: '8px 12px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, resize: 'vertical', minHeight: 80, outline: 'none', fontFamily: 'inherit' }} rows={4} placeholder="Message content" />
                        <VariablePicker variableFields={qm.variableFields} isOpen={qm.activeVariablePicker === 'add'} onToggle={() => qm.setActiveVariablePicker(qm.activeVariablePicker === 'add' ? null : 'add')} onClose={() => qm.setActiveVariablePicker(null)} contentRef={newContentRef} content={qm.newContent} setContent={qm.setNewContent} />
                    </div>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button onClick={() => { qm.setShowAddForm(false); qm.setNewTitle(''); qm.setNewContent(''); }} style={{ padding: '6px 16px', fontSize: 13, fontWeight: 500, color: '#6b7280', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>Cancel</button>
                        <button onClick={qm.handleAdd} disabled={qm.saving || !qm.newTitle.trim() || !qm.newContent.trim()} style={{ padding: '6px 16px', fontSize: 13, fontWeight: 500, color: '#fff', background: qm.saving || !qm.newTitle.trim() || !qm.newContent.trim() ? '#93c5fd' : '#2563eb', border: 'none', borderRadius: 8, cursor: qm.saving || !qm.newTitle.trim() || !qm.newContent.trim() ? 'not-allowed' : 'pointer' }}>{qm.saving ? 'Saving…' : 'Add Message'}</button>
                    </div>
                </div>
            ) : (
                <button onClick={() => qm.setShowAddForm(true)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', marginBottom: 16, padding: '12px 16px', fontSize: 14, fontWeight: 500, color: '#2563eb', background: 'transparent', border: '2px dashed #93c5fd', borderRadius: 10, cursor: 'pointer', transition: 'background 0.15s, border-color 0.15s' }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#eff6ff'; e.currentTarget.style.borderColor = '#60a5fa'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#93c5fd'; }}>
                    <Plus className="w-5 h-5" />Add Message
                </button>
            )}

            {qm.loading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 0' }}><Loader2 className="w-6 h-6 animate-spin" style={{ color: '#9ca3af' }} /></div>
            ) : qm.messages.length === 0 && !qm.showAddForm ? (
                <div style={{ textAlign: 'center', padding: '48px 0', color: '#9ca3af', border: '2px dashed #e5e7eb', borderRadius: 12 }}>
                    <MessageSquareText className="w-10 h-10" style={{ margin: '0 auto 12px', color: '#d1d5db' }} /><div style={{ fontSize: 15, fontWeight: 500 }}>No quick messages yet</div><div style={{ fontSize: 13, marginTop: 4 }}>Click the button above to create your first template.</div>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {qm.messages.map((msg, idx) => (
                        <div key={msg.id} draggable={qm.editingId !== msg.id} onDragStart={() => qm.handleDragStart(idx)} onDragOver={e => qm.handleDragOver(e, idx)} onDrop={e => qm.handleDrop(e, idx)} onDragEnd={qm.handleDragEnd}
                            style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', borderRadius: 10, border: `1px solid ${qm.dragIdx === idx ? '#93c5fd' : qm.overIdx === idx && qm.dragIdx !== null ? '#60a5fa' : '#e5e7eb'}`, background: qm.dragIdx === idx || (qm.overIdx === idx && qm.dragIdx !== null) ? '#eff6ff' : '#fff', opacity: qm.dragIdx === idx ? 0.5 : 1, transition: 'border-color 0.15s, background 0.15s', cursor: qm.editingId === msg.id ? 'default' : 'grab' }}>
                            <div style={{ marginTop: 2, color: '#9ca3af', flexShrink: 0 }}><GripVertical className="w-5 h-5" /></div>
                            {qm.editingId === msg.id ? (
                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                    <input value={qm.editTitle} onChange={e => qm.setEditTitle(e.target.value)} style={{ width: '100%', padding: '6px 10px', fontSize: 14, fontWeight: 600, border: '1px solid #d1d5db', borderRadius: 6, outline: 'none' }} placeholder="Title" autoFocus />
                                    <div style={{ position: 'relative' }}>
                                        <textarea ref={editContentRef} value={qm.editContent} onChange={e => qm.setEditContent(e.target.value)} style={{ width: '100%', padding: '6px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 6, resize: 'vertical', minHeight: 60, outline: 'none', fontFamily: 'inherit' }} rows={3} placeholder="Message content" />
                                        <VariablePicker variableFields={qm.variableFields} isOpen={qm.activeVariablePicker === 'edit'} onToggle={() => qm.setActiveVariablePicker(qm.activeVariablePicker === 'edit' ? null : 'edit')} onClose={() => qm.setActiveVariablePicker(null)} contentRef={editContentRef} content={qm.editContent} setContent={qm.setEditContent} />
                                    </div>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        <button onClick={qm.handleSaveEdit} disabled={qm.saving} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 12px', fontSize: 13, fontWeight: 500, color: '#16a34a', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, cursor: 'pointer' }}><Check className="w-4 h-4" /> Save</button>
                                        <button onClick={() => qm.setEditingId(null)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 12px', fontSize: 13, fontWeight: 500, color: '#6b7280', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer' }}><X className="w-4 h-4" /> Cancel</button>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{msg.title}</div><div style={{ fontSize: 13, color: '#6b7280', marginTop: 2, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{msg.content}</div></div>
                                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                                        <button onClick={() => qm.startEdit(msg)} title="Edit" style={{ padding: 6, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', color: '#9ca3af' }} onMouseEnter={e => { e.currentTarget.style.color = '#2563eb'; e.currentTarget.style.background = '#eff6ff'; }} onMouseLeave={e => { e.currentTarget.style.color = '#9ca3af'; e.currentTarget.style.background = 'transparent'; }}><Pencil className="w-4 h-4" /></button>
                                        <button onClick={() => qm.handleDelete(msg.id)} title="Delete" style={{ padding: 6, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', color: '#9ca3af' }} onMouseEnter={e => { e.currentTarget.style.color = '#dc2626'; e.currentTarget.style.background = '#fef2f2'; }} onMouseLeave={e => { e.currentTarget.style.color = '#9ca3af'; e.currentTarget.style.background = 'transparent'; }}><Trash2 className="w-4 h-4" /></button>
                                    </div>
                                </>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
