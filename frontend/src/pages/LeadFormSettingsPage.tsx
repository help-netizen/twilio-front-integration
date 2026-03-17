import { useState, useEffect, useCallback } from 'react';
import { authedFetch } from '../services/apiClient';
import * as jobsApi from '../services/jobsApi';
import './LeadFormSettingsPage.css';
import { toast } from 'sonner';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { CustomField, JobType, JobTag } from './leadFormTypes';
import { FIELD_TYPES, toApiName, TAG_PALETTE } from './leadFormTypes';
import { SortableJobType, SortableField } from './SortableSettingsItems';
import { SortableTag } from './SortableTag';

export default function LeadFormSettingsPage() {
    const [jobTypes, setJobTypes] = useState<JobType[]>([]);
    const [fields, setFields] = useState<CustomField[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [tags, setTags] = useState<JobTag[]>([]);
    const [newTagName, setNewTagName] = useState('');
    const [newTagColor, setNewTagColor] = useState('#3B82F6');
    const [newJobType, setNewJobType] = useState('');
    const [showNewField, setShowNewField] = useState(false);
    const [newFieldName, setNewFieldName] = useState('');
    const [newFieldType, setNewFieldType] = useState('text');
    const [newFieldSearchable, setNewFieldSearchable] = useState(true);

    const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

    const load = useCallback(async () => { try { const res = await authedFetch('/api/settings/lead-form'); const data = await res.json(); if (data.success) { setJobTypes(data.jobTypes); setFields(data.customFields); } else toast.error('Failed to load settings'); } catch { toast.error('Network error loading settings'); } finally { setLoading(false); } }, []);
    useEffect(() => { load(); }, [load]);

    const loadTags = useCallback(async () => { try { const data = await jobsApi.listJobTags(); setTags(data); } catch { /* silent */ } }, []);
    useEffect(() => { loadTags(); }, [loadTags]);

    const handleSave = async () => { setSaving(true); try { const res = await authedFetch('/api/settings/lead-form', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobTypes: jobTypes.map(jt => jt.name), customFields: fields.map((f, i) => ({ ...f, sort_order: i })) }) }); const data = await res.json(); if (data.success) { setJobTypes(data.jobTypes); setFields(data.customFields); setDirty(false); toast.success('Settings saved'); } else toast.error('Failed to save: ' + (data.error || 'Unknown error')); } catch { toast.error('Network error saving settings'); } finally { setSaving(false); } };

    const addJobType = () => { const name = newJobType.trim(); if (!name) return; if (jobTypes.some(jt => jt.name.toLowerCase() === name.toLowerCase())) { toast.warning('Job type already exists'); return; } setJobTypes([...jobTypes, { id: null, name, sort_order: jobTypes.length }]); setNewJobType(''); setDirty(true); };
    const removeJobType = (i: number) => { setJobTypes(jobTypes.filter((_, idx) => idx !== i)); setDirty(true); };
    const handleJobTypeDragEnd = (event: DragEndEvent) => { const { active, over } = event; if (!over || active.id === over.id) return; const oi = jobTypes.findIndex(jt => `jt-${jt.id ?? jt.name}` === active.id); const ni = jobTypes.findIndex(jt => `jt-${jt.id ?? jt.name}` === over.id); setJobTypes(arrayMove(jobTypes, oi, ni)); setDirty(true); };

    const addField = () => { const dn = newFieldName.trim(); const an = toApiName(dn); if (!dn || !an) { toast.warning('Field name is required'); return; } if (fields.some(f => f.api_name === an)) { toast.warning(`Field "${an}" already exists`); return; } setFields([...fields, { id: null, display_name: dn, api_name: an, field_type: newFieldType, is_system: false, is_searchable: newFieldSearchable, sort_order: fields.length }]); setNewFieldName(''); setNewFieldType('text'); setNewFieldSearchable(true); setShowNewField(false); setDirty(true); };
    const removeField = (i: number) => { if (fields[i].is_system) return; setFields(fields.filter((_, idx) => idx !== i)); setDirty(true); };
    const handleFieldDragEnd = (event: DragEndEvent) => { const { active, over } = event; if (!over || active.id === over.id) return; const oi = fields.findIndex(f => `cf-${f.id ?? f.api_name}` === active.id); const ni = fields.findIndex(f => `cf-${f.id ?? f.api_name}` === over.id); setFields(arrayMove(fields, oi, ni)); setDirty(true); };

    const addTag = async () => { const name = newTagName.trim(); if (!name) return; try { await jobsApi.createJobTag(name, newTagColor); setNewTagName(''); setNewTagColor('#3B82F6'); loadTags(); toast.success('Tag created'); } catch (err: any) { toast.error(err.message || 'Failed to create tag'); } };
    const handleTagArchiveToggle = async (tag: JobTag) => { try { await jobsApi.updateJobTag(tag.id, { is_active: !tag.is_active }); loadTags(); toast.success(tag.is_active ? 'Tag archived' : 'Tag restored'); } catch (err: any) { toast.error(err.message || 'Failed'); } };
    const handleTagColorChange = async (tagId: number, color: string) => { try { await jobsApi.updateJobTag(tagId, { color }); loadTags(); } catch (err: any) { toast.error(err.message || 'Failed'); } };
    const handleTagRename = async (tagId: number, name: string) => { try { await jobsApi.updateJobTag(tagId, { name }); loadTags(); toast.success('Tag renamed'); } catch (err: any) { toast.error(err.message || 'Failed'); } };
    const handleTagDragEnd = async (event: DragEndEvent) => { const { active, over } = event; if (!over || active.id === over.id) return; const oi = tags.findIndex(t => `tag-${t.id}` === active.id); const ni = tags.findIndex(t => `tag-${t.id}` === over.id); const reordered = arrayMove(tags, oi, ni); setTags(reordered); try { await jobsApi.reorderJobTags(reordered.map(t => t.id)); } catch { loadTags(); } };

    if (loading) return <div style={{ padding: '48px', textAlign: 'center', color: '#888' }}>Loading settings...</div>;

    return (
        <div className="lfsp-page">
            <div className="lfsp-header">
                <div><h1 className="lfsp-title">Lead & Job Settings</h1><p className="lfsp-subtitle">Configure job types and form fields for lead management</p></div>
                <button className={`lfsp-save-btn ${dirty ? 'lfsp-save-dirty' : ''}`} onClick={handleSave} disabled={saving || !dirty}>{saving ? 'Saving...' : 'Save'}</button>
            </div>

            <section className="lfsp-section">
                <h2 className="lfsp-section-title">Job Types</h2>
                <p className="lfsp-section-desc">Manage the list of available job types. Drag to reorder.</p>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleJobTypeDragEnd}>
                    <SortableContext items={jobTypes.map(jt => `jt-${jt.id ?? jt.name}`)} strategy={verticalListSortingStrategy}>
                        <div className="lfsp-list">{jobTypes.map((jt, i) => <SortableJobType key={`jt-${jt.id ?? jt.name}`} item={jt} onRemove={() => removeJobType(i)} />)}</div>
                    </SortableContext>
                </DndContext>
                <div className="lfsp-add-row">
                    <input className="lfsp-input" value={newJobType} onChange={e => setNewJobType(e.target.value)} onKeyDown={e => e.key === 'Enter' && addJobType()} placeholder="New job type name" />
                    <button className="lfsp-add-btn" onClick={addJobType}>+ Add Job Type</button>
                </div>
            </section>

            <section className="lfsp-section">
                <h2 className="lfsp-section-title">Metadata Fields</h2>
                <p className="lfsp-section-desc">System fields (🔒) cannot be deleted or renamed. Drag to reorder.</p>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleFieldDragEnd}>
                    <SortableContext items={fields.map(f => `cf-${f.id ?? f.api_name}`)} strategy={verticalListSortingStrategy}>
                        <div className="lfsp-list">{fields.map((f, i) => <SortableField key={`cf-${f.id ?? f.api_name}`} item={f} onRemove={() => removeField(i)} onToggleSearchable={() => { if (f.is_system) return; const u = [...fields]; u[i] = { ...u[i], is_searchable: !u[i].is_searchable }; setFields(u); setDirty(true); }} />)}</div>
                    </SortableContext>
                </DndContext>
                {showNewField ? (
                    <div className="lfsp-new-field-form">
                        <div className="lfsp-new-field-row">
                            <input className="lfsp-input" value={newFieldName} onChange={e => { const v = e.target.value.replace(/[^A-Za-z ]/g, ''); setNewFieldName(v); }} placeholder="Display Name" autoFocus />
                            <div className="lfsp-api-preview">{toApiName(newFieldName) || 'api_name'}</div>
                            <select className="lfsp-select" value={newFieldType} onChange={e => setNewFieldType(e.target.value)}>{FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
                        </div>
                        <div className="lfsp-new-field-actions">
                            <label className="lfsp-searchable-checkbox"><input type="checkbox" checked={newFieldSearchable} onChange={e => setNewFieldSearchable(e.target.checked)} />Include in search</label>
                            <div className="lfsp-new-field-buttons"><button className="lfsp-add-btn" onClick={addField}>Add</button><button className="lfsp-cancel-btn" onClick={() => { setShowNewField(false); setNewFieldName(''); }}>Cancel</button></div>
                        </div>
                    </div>
                ) : <button className="lfsp-add-btn" style={{ marginTop: 8 }} onClick={() => setShowNewField(true)}>+ Add Field</button>}
            </section>

            <section className="lfsp-section">
                <h2 className="lfsp-section-title">Job Tags</h2>
                <p className="lfsp-section-desc">Manage tags that can be assigned to jobs. Drag to reorder, click color dot to change, click name to rename.</p>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleTagDragEnd}>
                    <SortableContext items={tags.map(t => `tag-${t.id}`)} strategy={verticalListSortingStrategy}>
                        <div className="lfsp-list">{tags.map(tag => <SortableTag key={`tag-${tag.id}`} item={tag} onArchive={() => handleTagArchiveToggle(tag)} onColorChange={c => handleTagColorChange(tag.id, c)} onRename={n => handleTagRename(tag.id, n)} />)}</div>
                    </SortableContext>
                </DndContext>
                <div className="lfsp-add-row lfsp-tag-add-row">
                    <input className="lfsp-input" value={newTagName} onChange={e => setNewTagName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTag()} placeholder="New tag name" />
                    <div className="lfsp-tag-new-palette">{TAG_PALETTE.slice(0, 8).map(c => <button key={c} className={`lfsp-tag-palette-swatch lfsp-swatch-small ${c === newTagColor ? 'lfsp-swatch-active' : ''}`} style={{ backgroundColor: c, border: c === '#FFFFFF' ? '1px solid #d1d5db' : 'none' }} onClick={() => setNewTagColor(c)} />)}</div>
                    <button className="lfsp-add-btn" onClick={addTag}>+ Add Tag</button>
                </div>
            </section>
        </div>
    );
}
