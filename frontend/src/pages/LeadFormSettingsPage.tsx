import { useState, useEffect, useCallback } from 'react';
import { authedFetch } from '../services/apiClient';
import * as jobsApi from '../services/jobsApi';
import type { JobTag } from '../services/jobsApi';
import './LeadFormSettingsPage.css';
import { toast } from 'sonner';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// ─── Types ──────────────────────────────────────────────────────────────────
interface CustomField {
    id: number | null;
    display_name: string;
    api_name: string;
    field_type: string;
    is_system: boolean;
    is_searchable: boolean;
    sort_order: number;
}

interface JobType {
    id: number | null;
    name: string;
    sort_order: number;
}

const FIELD_TYPES = [
    { value: 'text', label: 'Text' },
    { value: 'textarea', label: 'Multiline Text' },
    { value: 'number', label: 'Number' },
    { value: 'file', label: 'File' },
    { value: 'richtext', label: 'Rich Text' },
];

function toApiName(displayName: string): string {
    return displayName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, '_');
}

// ─── Sortable Item Components ───────────────────────────────────────────────
function SortableJobType({
    item,
    onRemove,
}: {
    item: JobType;
    onRemove: () => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: `jt-${item.id ?? item.name}`,
    });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
    };

    return (
        <div ref={setNodeRef} style={style} className="lfsp-sortable-item">
            <span {...attributes} {...listeners} className="lfsp-drag-handle" title="Drag to reorder">☰</span>
            <span className="lfsp-item-name">{item.name}</span>
            <button className="lfsp-remove-btn" onClick={onRemove} title="Remove">🗑</button>
        </div>
    );
}

function SortableField({
    item,
    onRemove,
    onToggleSearchable,
}: {
    item: CustomField;
    onRemove: () => void;
    onToggleSearchable: () => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: `cf-${item.id ?? item.api_name}`,
    });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
    };

    const typeLabel = FIELD_TYPES.find((t) => t.value === item.field_type)?.label || item.field_type;

    return (
        <div ref={setNodeRef} style={style} className="lfsp-sortable-item lfsp-field-item">
            <span {...attributes} {...listeners} className="lfsp-drag-handle" title="Drag to reorder">☰</span>
            <span className="lfsp-field-display">{item.display_name}</span>
            <code className="lfsp-field-api">{item.api_name}</code>
            <span className="lfsp-field-type-badge">{typeLabel}</span>
            <button
                type="button"
                className={`lfsp-searchable-pill ${item.is_searchable ? 'lfsp-searchable-on' : 'lfsp-searchable-off'}`}
                onClick={item.is_system ? undefined : onToggleSearchable}
                disabled={item.is_system}
                title={item.is_system ? 'System field — always included in search' : (item.is_searchable ? 'Click to exclude from search' : 'Click to include in search')}
            >
                {item.is_searchable ? 'Searchable' : 'Not searchable'}
            </button>
            {item.is_system ? (
                <span className="lfsp-lock" title="System field — cannot delete">🔒</span>
            ) : (
                <button className="lfsp-remove-btn" onClick={onRemove} title="Remove">🗑</button>
            )}
        </div>
    );
}

// ─── Color Palette ──────────────────────────────────────────────────────────
const TAG_PALETTE = [
    '#EF4444', '#FCA5A5', // red
    '#F97316', '#FDBA74', // orange
    '#EAB308', '#FDE047', // yellow
    '#22C55E', '#86EFAC', // green
    '#14B8A6', '#5EEAD4', // teal
    '#3B82F6', '#93C5FD', // blue
    '#8B5CF6', '#C4B5FD', // violet
    '#000000', '#FFFFFF',
];

function getContrastText(hex: string): string {
    const c = hex.replace('#', '');
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#000' : '#fff';
}

function SortableTag({
    item,
    onArchive,
    onColorChange,
    onRename,
}: {
    item: JobTag;
    onArchive: () => void;
    onColorChange: (color: string) => void;
    onRename: (name: string) => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: `tag-${item.id}`,
    });
    const [showPalette, setShowPalette] = useState(false);
    const [editing, setEditing] = useState(false);
    const [editName, setEditName] = useState(item.name);

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
    };

    const isWhite = item.color.toLowerCase() === '#ffffff' || item.color.toLowerCase() === '#fff';

    return (
        <div ref={setNodeRef} style={style} className={`lfsp-sortable-item lfsp-tag-item ${!item.is_active ? 'lfsp-tag-archived' : ''}`}>
            <span {...attributes} {...listeners} className="lfsp-drag-handle" title="Drag to reorder">☰</span>

            {/* Color dot + palette */}
            <span className="lfsp-tag-color-wrapper">
                <button
                    className="lfsp-tag-color-dot"
                    style={{
                        backgroundColor: item.color,
                        border: isWhite ? '1px solid #d1d5db' : '2px solid transparent',
                    }}
                    onClick={() => setShowPalette(!showPalette)}
                    title="Change color"
                />
                {showPalette && (
                    <div className="lfsp-tag-palette">
                        {TAG_PALETTE.map(c => (
                            <button
                                key={c}
                                className={`lfsp-tag-palette-swatch ${c === item.color ? 'lfsp-swatch-active' : ''}`}
                                style={{
                                    backgroundColor: c,
                                    border: c === '#FFFFFF' ? '1px solid #d1d5db' : 'none',
                                }}
                                onClick={() => { onColorChange(c); setShowPalette(false); }}
                            />
                        ))}
                    </div>
                )}
            </span>

            {/* Badge preview */}
            <span
                className="lfsp-tag-badge-preview"
                style={{
                    backgroundColor: item.color,
                    color: getContrastText(item.color),
                    border: isWhite ? '1px solid #d1d5db' : 'none',
                }}
            >
                {item.name}
            </span>

            {/* Name — click to edit */}
            {editing ? (
                <input
                    className="lfsp-input lfsp-tag-name-input"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onBlur={() => {
                        if (editName.trim() && editName.trim() !== item.name) {
                            onRename(editName.trim());
                        }
                        setEditing(false);
                    }}
                    onKeyDown={e => {
                        if (e.key === 'Enter') {
                            if (editName.trim() && editName.trim() !== item.name) {
                                onRename(editName.trim());
                            }
                            setEditing(false);
                        }
                        if (e.key === 'Escape') { setEditName(item.name); setEditing(false); }
                    }}
                    autoFocus
                />
            ) : (
                <span
                    className="lfsp-item-name lfsp-tag-name-editable"
                    onClick={() => { setEditName(item.name); setEditing(true); }}
                    title="Click to rename"
                >
                    {item.name}
                </span>
            )}

            {!item.is_active && <span className="lfsp-tag-archived-label">Archived</span>}

            <button
                className="lfsp-remove-btn"
                onClick={onArchive}
                title={item.is_active ? 'Archive tag' : 'Restore tag'}
            >
                {item.is_active ? '🗑' : '♻️'}
            </button>
        </div>
    );
}

// ─── Page ───────────────────────────────────────────────────────────────────
export default function LeadFormSettingsPage() {
    const [jobTypes, setJobTypes] = useState<JobType[]>([]);
    const [fields, setFields] = useState<CustomField[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);

    // Job Tags
    const [tags, setTags] = useState<JobTag[]>([]);
    const [newTagName, setNewTagName] = useState('');
    const [newTagColor, setNewTagColor] = useState('#3B82F6');

    // New job type input
    const [newJobType, setNewJobType] = useState('');

    // New field inputs
    const [showNewField, setShowNewField] = useState(false);
    const [newFieldName, setNewFieldName] = useState('');
    const [newFieldType, setNewFieldType] = useState('text');
    const [newFieldSearchable, setNewFieldSearchable] = useState(true);

    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    // ── Load ──
    const load = useCallback(async () => {
        try {
            const res = await authedFetch('/api/settings/lead-form');
            const data = await res.json();
            if (data.success) {
                setJobTypes(data.jobTypes);
                setFields(data.customFields);
            } else {
                toast.error('Failed to load settings');
            }
        } catch {
            toast.error('Network error loading settings');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    // Load tags
    const loadTags = useCallback(async () => {
        try {
            const data = await jobsApi.listJobTags();
            setTags(data);
        } catch { /* silent */ }
    }, []);
    useEffect(() => { loadTags(); }, [loadTags]);

    // ── Save ──
    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await authedFetch('/api/settings/lead-form', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jobTypes: jobTypes.map((jt) => jt.name),
                    customFields: fields.map((f, i) => ({ ...f, sort_order: i })),
                }),
            });
            const data = await res.json();
            if (data.success) {
                setJobTypes(data.jobTypes);
                setFields(data.customFields);
                setDirty(false);
                toast.success('Settings saved');
            } else {
                toast.error('Failed to save: ' + (data.error || 'Unknown error'));
            }
        } catch {
            toast.error('Network error saving settings');
        } finally {
            setSaving(false);
        }
    };

    // ── Job Types ──
    const addJobType = () => {
        const name = newJobType.trim();
        if (!name) return;
        if (jobTypes.some((jt) => jt.name.toLowerCase() === name.toLowerCase())) {
            toast.warning('Job type already exists');
            return;
        }
        setJobTypes([...jobTypes, { id: null, name, sort_order: jobTypes.length }]);
        setNewJobType('');
        setDirty(true);
    };

    const removeJobType = (index: number) => {
        setJobTypes(jobTypes.filter((_, i) => i !== index));
        setDirty(true);
    };

    const handleJobTypeDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const oldIndex = jobTypes.findIndex((jt) => `jt-${jt.id ?? jt.name}` === active.id);
        const newIndex = jobTypes.findIndex((jt) => `jt-${jt.id ?? jt.name}` === over.id);
        setJobTypes(arrayMove(jobTypes, oldIndex, newIndex));
        setDirty(true);
    };

    // ── Fields ──
    const addField = () => {
        const displayName = newFieldName.trim();
        const apiName = toApiName(displayName);
        if (!displayName || !apiName) {
            toast.warning('Field name is required');
            return;
        }
        if (fields.some((f) => f.api_name === apiName)) {
            toast.warning(`Field "${apiName}" already exists`);
            return;
        }
        setFields([
            ...fields,
            {
                id: null,
                display_name: displayName,
                api_name: apiName,
                field_type: newFieldType,
                is_system: false,
                is_searchable: newFieldSearchable,
                sort_order: fields.length,
            },
        ]);
        setNewFieldName('');
        setNewFieldType('text');
        setNewFieldSearchable(true);
        setShowNewField(false);
        setDirty(true);
    };

    const removeField = (index: number) => {
        if (fields[index].is_system) return;
        setFields(fields.filter((_, i) => i !== index));
        setDirty(true);
    };

    const handleFieldDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const oldIndex = fields.findIndex((f) => `cf-${f.id ?? f.api_name}` === active.id);
        const newIndex = fields.findIndex((f) => `cf-${f.id ?? f.api_name}` === over.id);
        setFields(arrayMove(fields, oldIndex, newIndex));
        setDirty(true);
    };

    // ── Tag Operations ──
    const addTag = async () => {
        const name = newTagName.trim();
        if (!name) return;
        try {
            await jobsApi.createJobTag(name, newTagColor);
            setNewTagName('');
            setNewTagColor('#3B82F6');
            loadTags();
            toast.success('Tag created');
        } catch (err: any) {
            toast.error(err.message || 'Failed to create tag');
        }
    };

    const handleTagArchiveToggle = async (tag: JobTag) => {
        try {
            await jobsApi.updateJobTag(tag.id, { is_active: !tag.is_active });
            loadTags();
            toast.success(tag.is_active ? 'Tag archived' : 'Tag restored');
        } catch (err: any) {
            toast.error(err.message || 'Failed');
        }
    };

    const handleTagColorChange = async (tagId: number, color: string) => {
        try {
            await jobsApi.updateJobTag(tagId, { color });
            loadTags();
        } catch (err: any) {
            toast.error(err.message || 'Failed');
        }
    };

    const handleTagRename = async (tagId: number, name: string) => {
        try {
            await jobsApi.updateJobTag(tagId, { name });
            loadTags();
            toast.success('Tag renamed');
        } catch (err: any) {
            toast.error(err.message || 'Failed');
        }
    };

    const handleTagDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const oldIndex = tags.findIndex(t => `tag-${t.id}` === active.id);
        const newIndex = tags.findIndex(t => `tag-${t.id}` === over.id);
        const reordered = arrayMove(tags, oldIndex, newIndex);
        setTags(reordered);
        try {
            await jobsApi.reorderJobTags(reordered.map(t => t.id));
        } catch {
            loadTags(); // revert on error
        }
    };

    if (loading) {
        return (
            <div style={{ padding: '48px', textAlign: 'center', color: '#888' }}>
                Loading settings...
            </div>
        );
    }

    return (
        <div className="lfsp-page">
            {/* Header */}
            <div className="lfsp-header">
                <div>
                    <h1 className="lfsp-title">Lead & Job Settings</h1>
                    <p className="lfsp-subtitle">Configure job types and form fields for lead management</p>
                </div>
                <button
                    className={`lfsp-save-btn ${dirty ? 'lfsp-save-dirty' : ''}`}
                    onClick={handleSave}
                    disabled={saving || !dirty}
                >
                    {saving ? 'Saving...' : 'Save'}
                </button>
            </div>

            {/* ── Job Types ── */}
            <section className="lfsp-section">
                <h2 className="lfsp-section-title">Job Types</h2>
                <p className="lfsp-section-desc">Manage the list of available job types. Drag to reorder.</p>

                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleJobTypeDragEnd}>
                    <SortableContext
                        items={jobTypes.map((jt) => `jt-${jt.id ?? jt.name}`)}
                        strategy={verticalListSortingStrategy}
                    >
                        <div className="lfsp-list">
                            {jobTypes.map((jt, i) => (
                                <SortableJobType
                                    key={`jt-${jt.id ?? jt.name}`}
                                    item={jt}
                                    onRemove={() => removeJobType(i)}
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>

                <div className="lfsp-add-row">
                    <input
                        className="lfsp-input"
                        value={newJobType}
                        onChange={(e) => setNewJobType(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addJobType()}
                        placeholder="New job type name"
                    />
                    <button className="lfsp-add-btn" onClick={addJobType}>+ Add Job Type</button>
                </div>
            </section>

            {/* ── Metadata Fields ── */}
            <section className="lfsp-section">
                <h2 className="lfsp-section-title">Metadata Fields</h2>
                <p className="lfsp-section-desc">
                    System fields (🔒) cannot be deleted or renamed. Drag to reorder.
                </p>

                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleFieldDragEnd}>
                    <SortableContext
                        items={fields.map((f) => `cf-${f.id ?? f.api_name}`)}
                        strategy={verticalListSortingStrategy}
                    >
                        <div className="lfsp-list">
                            {fields.map((f, i) => (
                                <SortableField
                                    key={`cf-${f.id ?? f.api_name}`}
                                    item={f}
                                    onRemove={() => removeField(i)}
                                    onToggleSearchable={() => {
                                        if (f.is_system) return;
                                        const updated = [...fields];
                                        updated[i] = { ...updated[i], is_searchable: !updated[i].is_searchable };
                                        setFields(updated);
                                        setDirty(true);
                                    }}
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>

                {showNewField ? (
                    <div className="lfsp-new-field-form">
                        <div className="lfsp-new-field-row">
                            <input
                                className="lfsp-input"
                                value={newFieldName}
                                onChange={(e) => {
                                    const val = e.target.value.replace(/[^A-Za-z ]/g, '');
                                    setNewFieldName(val);
                                }}
                                placeholder="Display Name"
                                autoFocus
                            />
                            <div className="lfsp-api-preview">
                                {toApiName(newFieldName) || 'api_name'}
                            </div>
                            <select
                                className="lfsp-select"
                                value={newFieldType}
                                onChange={(e) => setNewFieldType(e.target.value)}
                            >
                                {FIELD_TYPES.map((t) => (
                                    <option key={t.value} value={t.value}>{t.label}</option>
                                ))}
                            </select>
                        </div>
                        <div className="lfsp-new-field-actions">
                            <label className="lfsp-searchable-checkbox">
                                <input
                                    type="checkbox"
                                    checked={newFieldSearchable}
                                    onChange={(e) => setNewFieldSearchable(e.target.checked)}
                                />
                                Include in search
                            </label>
                            <div className="lfsp-new-field-buttons">
                                <button className="lfsp-add-btn" onClick={addField}>Add</button>
                                <button className="lfsp-cancel-btn" onClick={() => { setShowNewField(false); setNewFieldName(''); }}>
                                    Cancel
                                </button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <button className="lfsp-add-btn" style={{ marginTop: 8 }} onClick={() => setShowNewField(true)}>
                        + Add Field
                    </button>
                )}
            </section>

            {/* ── Job Tags ── */}
            <section className="lfsp-section">
                <h2 className="lfsp-section-title">Job Tags</h2>
                <p className="lfsp-section-desc">Manage tags that can be assigned to jobs. Drag to reorder, click color dot to change, click name to rename.</p>

                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleTagDragEnd}>
                    <SortableContext
                        items={tags.map(t => `tag-${t.id}`)}
                        strategy={verticalListSortingStrategy}
                    >
                        <div className="lfsp-list">
                            {tags.map(tag => (
                                <SortableTag
                                    key={`tag-${tag.id}`}
                                    item={tag}
                                    onArchive={() => handleTagArchiveToggle(tag)}
                                    onColorChange={(c) => handleTagColorChange(tag.id, c)}
                                    onRename={(n) => handleTagRename(tag.id, n)}
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>

                <div className="lfsp-add-row lfsp-tag-add-row">
                    <input
                        className="lfsp-input"
                        value={newTagName}
                        onChange={e => setNewTagName(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && addTag()}
                        placeholder="New tag name"
                    />
                    <div className="lfsp-tag-new-palette">
                        {TAG_PALETTE.slice(0, 8).map(c => (
                            <button
                                key={c}
                                className={`lfsp-tag-palette-swatch lfsp-swatch-small ${c === newTagColor ? 'lfsp-swatch-active' : ''}`}
                                style={{
                                    backgroundColor: c,
                                    border: c === '#FFFFFF' ? '1px solid #d1d5db' : 'none',
                                }}
                                onClick={() => setNewTagColor(c)}
                            />
                        ))}
                    </div>
                    <button className="lfsp-add-btn" onClick={addTag}>+ Add Tag</button>
                </div>
            </section>
        </div>
    );
}
