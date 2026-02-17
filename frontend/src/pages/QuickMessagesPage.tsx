/**
 * QuickMessagesPage — Full settings page for managing quick message templates.
 * Features: list, add, edit, delete, drag-to-reorder.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { GripVertical, Plus, Pencil, Trash2, Check, X, Loader2, MessageSquareText, Variable } from 'lucide-react';
import { authedFetch } from '../services/apiClient';

const API_BASE = import.meta.env.VITE_API_URL || '';

interface QuickMessage {
    id: string;
    title: string;
    content: string;
    sort_order: number;
}

export default function QuickMessagesPage() {
    const [messages, setMessages] = useState<QuickMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    // Inline edit state
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editTitle, setEditTitle] = useState('');
    const [editContent, setEditContent] = useState('');

    // New message form
    const [showAddForm, setShowAddForm] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newContent, setNewContent] = useState('');

    // Drag state
    const [dragIdx, setDragIdx] = useState<number | null>(null);
    const [overIdx, setOverIdx] = useState<number | null>(null);

    // Variable picker state
    const [variableFields, setVariableFields] = useState<{ label: string; group: string }[]>([]);
    const [activeVariablePicker, setActiveVariablePicker] = useState<'add' | 'edit' | null>(null);
    const newContentRef = useRef<HTMLTextAreaElement>(null);
    const editContentRef = useRef<HTMLTextAreaElement>(null);

    const fetchMessages = useCallback(async () => {
        try {
            setLoading(true);
            const res = await authedFetch(`${API_BASE}/api/quick-messages`);
            const data = await res.json();
            setMessages(data.messages || []);
        } catch (err) {
            console.error('Failed to load quick messages:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchMessages();
    }, [fetchMessages]);

    // Fetch lead-form settings for variable fields
    useEffect(() => {
        const coreFields = [
            { label: 'First Name', group: 'Main' },
            { label: 'Last Name', group: 'Main' },
            { label: 'Phone', group: 'Main' },
            { label: 'Email', group: 'Main' },
            { label: 'Company', group: 'Main' },
            { label: 'Address', group: 'Main' },
            { label: 'City', group: 'Main' },
            { label: 'State', group: 'Main' },
            { label: 'Postal Code', group: 'Main' },
            { label: 'Job Type', group: 'Main' },
            { label: 'Description', group: 'Main' },
        ];
        const metaFields = [
            { label: 'Job Source', group: 'Metadata' },
            { label: 'Created Date', group: 'Metadata' },
        ];

        authedFetch(`${API_BASE}/api/settings/lead-form`)
            .then(r => r.json())
            .then(data => {
                if (data.success && Array.isArray(data.customFields)) {
                    const custom = data.customFields
                        .filter((f: any) => !f.is_system)
                        .map((f: any) => ({ label: f.display_name, group: 'Metadata' }));
                    setVariableFields([...coreFields, ...metaFields, ...custom]);
                } else {
                    setVariableFields([...coreFields, ...metaFields]);
                }
            })
            .catch(() => setVariableFields([...coreFields, ...metaFields]));
    }, []);

    // ── Add new ──
    const handleAdd = async () => {
        if (!newTitle.trim() || !newContent.trim()) return;
        try {
            setSaving(true);
            await authedFetch(`${API_BASE}/api/quick-messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: newTitle.trim(), content: newContent.trim() }),
            });
            setNewTitle('');
            setNewContent('');
            setShowAddForm(false);
            await fetchMessages();
        } catch (err) {
            console.error('Failed to add quick message:', err);
        } finally {
            setSaving(false);
        }
    };

    // ── Edit ──
    const startEdit = (msg: QuickMessage) => {
        setEditingId(msg.id);
        setEditTitle(msg.title);
        setEditContent(msg.content);
    };

    const handleSaveEdit = async () => {
        if (!editingId || !editTitle.trim() || !editContent.trim()) return;
        try {
            setSaving(true);
            await authedFetch(`${API_BASE}/api/quick-messages/${editingId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: editTitle.trim(), content: editContent.trim() }),
            });
            setEditingId(null);
            await fetchMessages();
        } catch (err) {
            console.error('Failed to update quick message:', err);
        } finally {
            setSaving(false);
        }
    };

    // ── Delete ──
    const handleDelete = async (id: string) => {
        try {
            setSaving(true);
            await authedFetch(`${API_BASE}/api/quick-messages/${id}`, { method: 'DELETE' });
            await fetchMessages();
        } catch (err) {
            console.error('Failed to delete quick message:', err);
        } finally {
            setSaving(false);
        }
    };

    // ── Drag & Drop ──
    const handleDragStart = (idx: number) => {
        setDragIdx(idx);
    };

    const handleDragOver = (e: React.DragEvent, idx: number) => {
        e.preventDefault();
        setOverIdx(idx);
    };

    const handleDrop = async (e: React.DragEvent, dropIdx: number) => {
        e.preventDefault();
        if (dragIdx === null || dragIdx === dropIdx) {
            setDragIdx(null);
            setOverIdx(null);
            return;
        }

        const reordered = [...messages];
        const [moved] = reordered.splice(dragIdx, 1);
        reordered.splice(dropIdx, 0, moved);
        setMessages(reordered);
        setDragIdx(null);
        setOverIdx(null);

        try {
            setSaving(true);
            await authedFetch(`${API_BASE}/api/quick-messages/reorder`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderedIds: reordered.map(m => m.id) }),
            });
        } catch (err) {
            console.error('Failed to reorder:', err);
            await fetchMessages();
        } finally {
            setSaving(false);
        }
    };

    const handleDragEnd = () => {
        setDragIdx(null);
        setOverIdx(null);
    };

    return (
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 24px' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
                <div>
                    <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#111827' }}>Quick Messages</h1>
                    <p style={{ fontSize: 14, color: '#6b7280', margin: '4px 0 0' }}>
                        Manage message templates. Drag to reorder.
                    </p>
                </div>
                {saving && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#6b7280' }}>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Saving…
                    </div>
                )}
            </div>

            {/* Add new form / button — at the top */}
            {showAddForm ? (
                <div style={{
                    marginBottom: 16, padding: 16, borderRadius: 10,
                    border: '1px solid #e5e7eb', background: '#f9fafb',
                    display: 'flex', flexDirection: 'column', gap: 10,
                }}>
                    <input
                        value={newTitle}
                        onChange={(e) => setNewTitle(e.target.value)}
                        style={{
                            width: '100%', padding: '8px 12px', fontSize: 14, fontWeight: 600,
                            border: '1px solid #d1d5db', borderRadius: 8, outline: 'none',
                        }}
                        placeholder="Message title"
                        autoFocus
                    />
                    <div style={{ position: 'relative' }}>
                        <textarea
                            ref={newContentRef}
                            value={newContent}
                            onChange={(e) => setNewContent(e.target.value)}
                            style={{
                                width: '100%', padding: '8px 12px', fontSize: 13,
                                border: '1px solid #d1d5db', borderRadius: 8,
                                resize: 'vertical', minHeight: 80, outline: 'none',
                                fontFamily: 'inherit',
                            }}
                            rows={4}
                            placeholder="Message content"
                        />
                        {/* + Add Variable — floats to the right of the textarea */}
                        <div style={{ position: 'absolute', left: '100%', top: 0, marginLeft: 8 }}>
                            <button
                                type="button"
                                onClick={() => setActiveVariablePicker(activeVariablePicker === 'add' ? null : 'add')}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 4,
                                    padding: '4px 10px', fontSize: 12, fontWeight: 500,
                                    color: '#7c3aed', background: '#f5f3ff',
                                    border: '1px solid #ddd6fe', borderRadius: 6,
                                    cursor: 'pointer', whiteSpace: 'nowrap',
                                }}
                            >
                                <Variable className="w-3.5 h-3.5" /> + Add Variable
                            </button>
                            {activeVariablePicker === 'add' && (
                                <>
                                    <div className="fixed inset-0 z-10" onClick={() => setActiveVariablePicker(null)} />
                                    <div style={{
                                        position: 'absolute', left: 0, top: '100%', marginTop: 4,
                                        width: 220, maxHeight: 260, overflowY: 'auto',
                                        background: '#fff', border: '1px solid #e5e7eb',
                                        borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                                        zIndex: 20, padding: '4px 0',
                                    }}>
                                        {['Main', 'Metadata'].map(group => {
                                            const items = variableFields.filter(f => f.group === group);
                                            if (items.length === 0) return null;
                                            return (
                                                <div key={group}>
                                                    <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', padding: '6px 12px 2px', textTransform: 'uppercase' }}>{group}</div>
                                                    {items.map(f => (
                                                        <button
                                                            key={f.label}
                                                            onClick={() => {
                                                                const ta = newContentRef.current;
                                                                const insert = `{${f.label}}`;
                                                                if (ta) {
                                                                    const start = ta.selectionStart;
                                                                    const end = ta.selectionEnd;
                                                                    const newVal = newContent.slice(0, start) + insert + newContent.slice(end);
                                                                    setNewContent(newVal);
                                                                    setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + insert.length; }, 0);
                                                                } else {
                                                                    setNewContent(newContent + insert);
                                                                }
                                                                setActiveVariablePicker(null);
                                                            }}
                                                            style={{
                                                                display: 'block', width: '100%', textAlign: 'left',
                                                                padding: '5px 12px', fontSize: 13, color: '#374151',
                                                                background: 'transparent', border: 'none', cursor: 'pointer',
                                                            }}
                                                            onMouseEnter={e => { e.currentTarget.style.background = '#f3f4f6'; }}
                                                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                                        >
                                                            {`{${f.label}}`}
                                                        </button>
                                                    ))}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button
                            onClick={() => { setShowAddForm(false); setNewTitle(''); setNewContent(''); }}
                            style={{
                                padding: '6px 16px', fontSize: 13, fontWeight: 500,
                                color: '#6b7280', background: '#fff',
                                border: '1px solid #e5e7eb', borderRadius: 8,
                                cursor: 'pointer',
                            }}
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleAdd}
                            disabled={saving || !newTitle.trim() || !newContent.trim()}
                            style={{
                                padding: '6px 16px', fontSize: 13, fontWeight: 500,
                                color: '#fff', background: saving || !newTitle.trim() || !newContent.trim() ? '#93c5fd' : '#2563eb',
                                border: 'none', borderRadius: 8,
                                cursor: saving || !newTitle.trim() || !newContent.trim() ? 'not-allowed' : 'pointer',
                            }}
                        >
                            {saving ? 'Saving…' : 'Add Message'}
                        </button>
                    </div>
                </div>
            ) : (
                <button
                    onClick={() => setShowAddForm(true)}
                    style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        width: '100%', marginBottom: 16, padding: '12px 16px',
                        fontSize: 14, fontWeight: 500, color: '#2563eb',
                        background: 'transparent',
                        border: '2px dashed #93c5fd', borderRadius: 10,
                        cursor: 'pointer',
                        transition: 'background 0.15s, border-color 0.15s',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = '#eff6ff'; e.currentTarget.style.borderColor = '#60a5fa'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#93c5fd'; }}
                >
                    <Plus className="w-5 h-5" />
                    Add Message
                </button>
            )}

            {/* Messages list */}
            {loading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 0' }}>
                    <Loader2 className="w-6 h-6 animate-spin" style={{ color: '#9ca3af' }} />
                </div>
            ) : messages.length === 0 && !showAddForm ? (
                <div style={{
                    textAlign: 'center', padding: '48px 0', color: '#9ca3af',
                    border: '2px dashed #e5e7eb', borderRadius: 12,
                }}>
                    <MessageSquareText className="w-10 h-10" style={{ margin: '0 auto 12px', color: '#d1d5db' }} />
                    <div style={{ fontSize: 15, fontWeight: 500 }}>No quick messages yet</div>
                    <div style={{ fontSize: 13, marginTop: 4 }}>Click the button above to create your first template.</div>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {messages.map((msg, idx) => (
                        <div
                            key={msg.id}
                            draggable={editingId !== msg.id}
                            onDragStart={() => handleDragStart(idx)}
                            onDragOver={(e) => handleDragOver(e, idx)}
                            onDrop={(e) => handleDrop(e, idx)}
                            onDragEnd={handleDragEnd}
                            style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 10,
                                padding: '12px 14px',
                                borderRadius: 10,
                                border: `1px solid ${dragIdx === idx ? '#93c5fd'
                                    : overIdx === idx && dragIdx !== null ? '#60a5fa'
                                        : '#e5e7eb'
                                    }`,
                                background: dragIdx === idx ? '#eff6ff'
                                    : overIdx === idx && dragIdx !== null ? '#eff6ff'
                                        : '#fff',
                                opacity: dragIdx === idx ? 0.5 : 1,
                                transition: 'border-color 0.15s, background 0.15s',
                                cursor: editingId === msg.id ? 'default' : 'grab',
                            }}
                        >
                            {/* Drag handle */}
                            <div style={{ marginTop: 2, color: '#9ca3af', flexShrink: 0 }}>
                                <GripVertical className="w-5 h-5" />
                            </div>

                            {/* Content */}
                            {editingId === msg.id ? (
                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                    <input
                                        value={editTitle}
                                        onChange={(e) => setEditTitle(e.target.value)}
                                        style={{
                                            width: '100%', padding: '6px 10px', fontSize: 14, fontWeight: 600,
                                            border: '1px solid #d1d5db', borderRadius: 6,
                                            outline: 'none',
                                        }}
                                        placeholder="Title"
                                        autoFocus
                                    />
                                    <div style={{ position: 'relative' }}>
                                        <textarea
                                            ref={editContentRef}
                                            value={editContent}
                                            onChange={(e) => setEditContent(e.target.value)}
                                            style={{
                                                width: '100%', padding: '6px 10px', fontSize: 13,
                                                border: '1px solid #d1d5db', borderRadius: 6,
                                                resize: 'vertical', minHeight: 60,
                                                outline: 'none', fontFamily: 'inherit',
                                            }}
                                            rows={3}
                                            placeholder="Message content"
                                        />
                                        {/* + Add Variable — floats to the right of the textarea */}
                                        <div style={{ position: 'absolute', left: '100%', top: 0, marginLeft: 8 }}>
                                            <button
                                                type="button"
                                                onClick={() => setActiveVariablePicker(activeVariablePicker === 'edit' ? null : 'edit')}
                                                style={{
                                                    display: 'flex', alignItems: 'center', gap: 4,
                                                    padding: '4px 10px', fontSize: 12, fontWeight: 500,
                                                    color: '#7c3aed', background: '#f5f3ff',
                                                    border: '1px solid #ddd6fe', borderRadius: 6,
                                                    cursor: 'pointer', whiteSpace: 'nowrap',
                                                }}
                                            >
                                                <Variable className="w-3.5 h-3.5" /> + Add Variable
                                            </button>
                                            {activeVariablePicker === 'edit' && (
                                                <>
                                                    <div className="fixed inset-0 z-10" onClick={() => setActiveVariablePicker(null)} />
                                                    <div style={{
                                                        position: 'absolute', left: 0, top: '100%', marginTop: 4,
                                                        width: 220, maxHeight: 260, overflowY: 'auto',
                                                        background: '#fff', border: '1px solid #e5e7eb',
                                                        borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                                                        zIndex: 20, padding: '4px 0',
                                                    }}>
                                                        {['Main', 'Metadata'].map(group => {
                                                            const items = variableFields.filter(f => f.group === group);
                                                            if (items.length === 0) return null;
                                                            return (
                                                                <div key={group}>
                                                                    <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', padding: '6px 12px 2px', textTransform: 'uppercase' }}>{group}</div>
                                                                    {items.map(f => (
                                                                        <button
                                                                            key={f.label}
                                                                            onClick={() => {
                                                                                const ta = editContentRef.current;
                                                                                const insert = `{${f.label}}`;
                                                                                if (ta) {
                                                                                    const start = ta.selectionStart;
                                                                                    const end = ta.selectionEnd;
                                                                                    const newVal = editContent.slice(0, start) + insert + editContent.slice(end);
                                                                                    setEditContent(newVal);
                                                                                    setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + insert.length; }, 0);
                                                                                } else {
                                                                                    setEditContent(editContent + insert);
                                                                                }
                                                                                setActiveVariablePicker(null);
                                                                            }}
                                                                            style={{
                                                                                display: 'block', width: '100%', textAlign: 'left',
                                                                                padding: '5px 12px', fontSize: 13, color: '#374151',
                                                                                background: 'transparent', border: 'none', cursor: 'pointer',
                                                                            }}
                                                                            onMouseEnter={e => { e.currentTarget.style.background = '#f3f4f6'; }}
                                                                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                                                        >
                                                                            {`{${f.label}}`}
                                                                        </button>
                                                                    ))}
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        <button
                                            onClick={handleSaveEdit}
                                            disabled={saving}
                                            style={{
                                                display: 'flex', alignItems: 'center', gap: 4,
                                                padding: '4px 12px', fontSize: 13, fontWeight: 500,
                                                color: '#16a34a', background: '#f0fdf4',
                                                border: '1px solid #bbf7d0', borderRadius: 6,
                                                cursor: 'pointer',
                                            }}
                                        >
                                            <Check className="w-4 h-4" /> Save
                                        </button>
                                        <button
                                            onClick={() => setEditingId(null)}
                                            style={{
                                                display: 'flex', alignItems: 'center', gap: 4,
                                                padding: '4px 12px', fontSize: 13, fontWeight: 500,
                                                color: '#6b7280', background: '#f9fafb',
                                                border: '1px solid #e5e7eb', borderRadius: 6,
                                                cursor: 'pointer',
                                            }}
                                        >
                                            <X className="w-4 h-4" /> Cancel
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{msg.title}</div>
                                        <div style={{
                                            fontSize: 13, color: '#6b7280', marginTop: 2,
                                            whiteSpace: 'pre-wrap', lineHeight: 1.5,
                                        }}>
                                            {msg.content}
                                        </div>
                                    </div>
                                    {/* Actions */}
                                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                                        <button
                                            onClick={() => startEdit(msg)}
                                            title="Edit"
                                            style={{
                                                padding: 6, borderRadius: 6, border: 'none',
                                                background: 'transparent', cursor: 'pointer',
                                                color: '#9ca3af',
                                            }}
                                            onMouseEnter={(e) => { e.currentTarget.style.color = '#2563eb'; e.currentTarget.style.background = '#eff6ff'; }}
                                            onMouseLeave={(e) => { e.currentTarget.style.color = '#9ca3af'; e.currentTarget.style.background = 'transparent'; }}
                                        >
                                            <Pencil className="w-4 h-4" />
                                        </button>
                                        <button
                                            onClick={() => handleDelete(msg.id)}
                                            title="Delete"
                                            style={{
                                                padding: 6, borderRadius: 6, border: 'none',
                                                background: 'transparent', cursor: 'pointer',
                                                color: '#9ca3af',
                                            }}
                                            onMouseEnter={(e) => { e.currentTarget.style.color = '#dc2626'; e.currentTarget.style.background = '#fef2f2'; }}
                                            onMouseLeave={(e) => { e.currentTarget.style.color = '#9ca3af'; e.currentTarget.style.background = 'transparent'; }}
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
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
