import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CustomField, JobType } from './leadFormTypes';
import { FIELD_TYPES } from './leadFormTypes';

export function SortableJobType({ item, onRemove }: { item: JobType; onRemove: () => void }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `jt-${item.id ?? item.name}` });
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
    return (
        <div ref={setNodeRef} style={style} className="lfsp-sortable-item">
            <span {...attributes} {...listeners} className="lfsp-drag-handle" title="Drag to reorder">☰</span>
            <span className="lfsp-item-name">{item.name}</span>
            <button className="lfsp-remove-btn" onClick={onRemove} title="Remove">🗑</button>
        </div>
    );
}

export function SortableField({ item, onRemove, onToggleSearchable }: { item: CustomField; onRemove: () => void; onToggleSearchable: () => void }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `cf-${item.id ?? item.api_name}` });
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
    const typeLabel = FIELD_TYPES.find((t) => t.value === item.field_type)?.label || item.field_type;
    return (
        <div ref={setNodeRef} style={style} className="lfsp-sortable-item lfsp-field-item">
            <span {...attributes} {...listeners} className="lfsp-drag-handle" title="Drag to reorder">☰</span>
            <span className="lfsp-field-display">{item.display_name}</span>
            <code className="lfsp-field-api">{item.api_name}</code>
            <span className="lfsp-field-type-badge">{typeLabel}</span>
            <button type="button" className={`lfsp-searchable-pill ${item.is_searchable ? 'lfsp-searchable-on' : 'lfsp-searchable-off'}`}
                onClick={item.is_system ? undefined : onToggleSearchable} disabled={item.is_system}
                title={item.is_system ? 'System field — always included in search' : (item.is_searchable ? 'Click to exclude from search' : 'Click to include in search')}>
                {item.is_searchable ? 'Searchable' : 'Not searchable'}
            </button>
            {item.is_system ? <span className="lfsp-lock" title="System field — cannot delete">🔒</span> : <button className="lfsp-remove-btn" onClick={onRemove} title="Remove">🗑</button>}
        </div>
    );
}
