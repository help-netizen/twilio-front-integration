import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TAG_PALETTE, getContrastText } from './leadFormTypes';
import type { JobTag } from './leadFormTypes';

export function SortableTag({ item, onArchive, onColorChange, onRename }: {
    item: JobTag; onArchive: () => void; onColorChange: (color: string) => void; onRename: (name: string) => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `tag-${item.id}` });
    const [showPalette, setShowPalette] = useState(false);
    const [editing, setEditing] = useState(false);
    const [editName, setEditName] = useState(item.name);
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
    const isWhite = item.color.toLowerCase() === '#ffffff' || item.color.toLowerCase() === '#fff';

    return (
        <div ref={setNodeRef} style={style} className={`lfsp-sortable-item lfsp-tag-item ${!item.is_active ? 'lfsp-tag-archived' : ''}`}>
            <span {...attributes} {...listeners} className="lfsp-drag-handle" title="Drag to reorder">☰</span>
            <span className="lfsp-tag-color-wrapper">
                <button className="lfsp-tag-color-dot" style={{ backgroundColor: item.color, border: isWhite ? '1px solid #d1d5db' : '2px solid transparent' }} onClick={() => setShowPalette(!showPalette)} title="Change color" />
                {showPalette && (
                    <div className="lfsp-tag-palette">
                        {TAG_PALETTE.map(c => (
                            <button key={c} className={`lfsp-tag-palette-swatch ${c === item.color ? 'lfsp-swatch-active' : ''}`}
                                style={{ backgroundColor: c, border: c === '#FFFFFF' ? '1px solid #d1d5db' : 'none' }}
                                onClick={() => { onColorChange(c); setShowPalette(false); }} />
                        ))}
                    </div>
                )}
            </span>
            <span className="lfsp-tag-badge-preview" style={{ backgroundColor: item.color, color: getContrastText(item.color), border: isWhite ? '1px solid #d1d5db' : 'none' }}>{item.name}</span>
            {editing ? (
                <input className="lfsp-input lfsp-tag-name-input" value={editName} onChange={e => setEditName(e.target.value)}
                    onBlur={() => { if (editName.trim() && editName.trim() !== item.name) onRename(editName.trim()); setEditing(false); }}
                    onKeyDown={e => { if (e.key === 'Enter') { if (editName.trim() && editName.trim() !== item.name) onRename(editName.trim()); setEditing(false); } if (e.key === 'Escape') { setEditName(item.name); setEditing(false); } }}
                    autoFocus />
            ) : (
                <span className="lfsp-item-name lfsp-tag-name-editable" onClick={() => { setEditName(item.name); setEditing(true); }} title="Click to rename">{item.name}</span>
            )}
            {!item.is_active && <span className="lfsp-tag-archived-label">Archived</span>}
            <button className="lfsp-remove-btn" onClick={onArchive} title={item.is_active ? 'Archive tag' : 'Restore tag'}>{item.is_active ? '🗑' : '♻️'}</button>
        </div>
    );
}
