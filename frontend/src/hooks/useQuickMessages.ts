import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { authedFetch } from '../services/apiClient';
import { useLeadFormSettings } from './useLeadFormSettings';

const API_BASE = import.meta.env.VITE_API_URL || '';

export interface QuickMessage {
    id: string;
    title: string;
    content: string;
    sort_order: number;
}

export function useQuickMessages() {
    const [messages, setMessages] = useState<QuickMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editTitle, setEditTitle] = useState('');
    const [editContent, setEditContent] = useState('');
    const [showAddForm, setShowAddForm] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newContent, setNewContent] = useState('');
    const [dragIdx, setDragIdx] = useState<number | null>(null);
    const [overIdx, setOverIdx] = useState<number | null>(null);
    const [variableFields, setVariableFields] = useState<{ label: string; group: string }[]>([]);
    const [activeVariablePicker, setActiveVariablePicker] = useState<'add' | 'edit' | null>(null);

    const { customFields: settingsCustomFields } = useLeadFormSettings();

    const fetchMessages = useCallback(async () => { try { setLoading(true); const res = await authedFetch(`${API_BASE}/api/quick-messages`); const data = await res.json(); setMessages(data.messages || []); } catch (err) { console.error('Failed to load quick messages:', err); } finally { setLoading(false); } }, []);
    useEffect(() => { fetchMessages(); }, [fetchMessages]);

    useEffect(() => {
        const coreFields = [{ label: 'First Name', group: 'Main' }, { label: 'Last Name', group: 'Main' }, { label: 'Phone', group: 'Main' }, { label: 'Email', group: 'Main' }, { label: 'Company', group: 'Main' }, { label: 'Address', group: 'Main' }, { label: 'City', group: 'Main' }, { label: 'State', group: 'Main' }, { label: 'Postal Code', group: 'Main' }, { label: 'Job Type', group: 'Main' }, { label: 'Description', group: 'Main' }];
        const metaFields = [{ label: 'Job Source', group: 'Metadata' }, { label: 'Created Date', group: 'Metadata' }];
        const custom = settingsCustomFields.filter(f => !f.is_system).map(f => ({ label: f.display_name, group: 'Metadata' }));
        setVariableFields([...coreFields, ...metaFields, ...custom]);
    }, [settingsCustomFields]);

    const handleAdd = async () => { if (!newTitle.trim() || !newContent.trim()) return; try { setSaving(true); const res = await authedFetch(`${API_BASE}/api/quick-messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: newTitle.trim(), content: newContent.trim() }) }); if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error((err as any).error || `HTTP ${res.status}`); } setNewTitle(''); setNewContent(''); setShowAddForm(false); await fetchMessages(); toast.success('Message added'); } catch (err) { console.error('Failed to add quick message:', err); toast.error(`Failed to add message: ${(err as Error).message}`); } finally { setSaving(false); } };
    const startEdit = (msg: QuickMessage) => { setEditingId(msg.id); setEditTitle(msg.title); setEditContent(msg.content); };
    const handleSaveEdit = async () => { if (!editingId || !editTitle.trim() || !editContent.trim()) return; try { setSaving(true); const res = await authedFetch(`${API_BASE}/api/quick-messages/${editingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: editTitle.trim(), content: editContent.trim() }) }); if (!res.ok) throw new Error(`HTTP ${res.status}`); setEditingId(null); await fetchMessages(); toast.success('Message updated'); } catch (err) { console.error('Failed to update quick message:', err); toast.error('Failed to update message'); } finally { setSaving(false); } };
    const handleDelete = async (id: string) => { try { setSaving(true); const res = await authedFetch(`${API_BASE}/api/quick-messages/${id}`, { method: 'DELETE' }); if (!res.ok) throw new Error(`HTTP ${res.status}`); await fetchMessages(); toast.success('Message deleted'); } catch (err) { console.error('Failed to delete quick message:', err); toast.error('Failed to delete message'); } finally { setSaving(false); } };
    const handleDragStart = (idx: number) => { setDragIdx(idx); };
    const handleDragOver = (e: React.DragEvent, idx: number) => { e.preventDefault(); setOverIdx(idx); };
    const handleDrop = async (e: React.DragEvent, dropIdx: number) => { e.preventDefault(); if (dragIdx === null || dragIdx === dropIdx) { setDragIdx(null); setOverIdx(null); return; } const reordered = [...messages]; const [moved] = reordered.splice(dragIdx, 1); reordered.splice(dropIdx, 0, moved); setMessages(reordered); setDragIdx(null); setOverIdx(null); try { setSaving(true); await authedFetch(`${API_BASE}/api/quick-messages/reorder`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderedIds: reordered.map(m => m.id) }) }); } catch (err) { console.error('Failed to reorder:', err); await fetchMessages(); } finally { setSaving(false); } };
    const handleDragEnd = () => { setDragIdx(null); setOverIdx(null); };

    return {
        messages, loading, saving, editingId, setEditingId, editTitle, setEditTitle, editContent, setEditContent,
        showAddForm, setShowAddForm, newTitle, setNewTitle, newContent, setNewContent,
        dragIdx, overIdx, variableFields, activeVariablePicker, setActiveVariablePicker,
        handleAdd, startEdit, handleSaveEdit, handleDelete,
        handleDragStart, handleDragOver, handleDrop, handleDragEnd,
    };
}
