import { useState, useEffect, useCallback } from 'react';
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
}: {
    item: CustomField;
    onRemove: () => void;
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
            {item.is_system ? (
                <span className="lfsp-lock" title="System field — cannot delete">🔒</span>
            ) : (
                <button className="lfsp-remove-btn" onClick={onRemove} title="Remove">🗑</button>
            )}
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

    // New job type input
    const [newJobType, setNewJobType] = useState('');

    // New field inputs
    const [showNewField, setShowNewField] = useState(false);
    const [newFieldName, setNewFieldName] = useState('');
    const [newFieldType, setNewFieldType] = useState('text');

    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    // ── Load ──
    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/settings/lead-form');
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

    // ── Save ──
    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await fetch('/api/settings/lead-form', {
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
                sort_order: fields.length,
            },
        ]);
        setNewFieldName('');
        setNewFieldType('text');
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
                    <h1 className="lfsp-title">Lead Form Settings</h1>
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
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>

                {showNewField ? (
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
                        <button className="lfsp-add-btn" onClick={addField}>Add</button>
                        <button className="lfsp-cancel-btn" onClick={() => { setShowNewField(false); setNewFieldName(''); }}>
                            Cancel
                        </button>
                    </div>
                ) : (
                    <button className="lfsp-add-btn" style={{ marginTop: 8 }} onClick={() => setShowNewField(true)}>
                        + Add Field
                    </button>
                )}
            </section>
        </div>
    );
}
