import { Variable } from 'lucide-react';

interface VariablePickerProps {
    variableFields: { label: string; group: string }[];
    isOpen: boolean;
    onToggle: () => void;
    onClose: () => void;
    contentRef: React.RefObject<HTMLTextAreaElement | null>;
    content: string;
    setContent: (val: string) => void;
}

export function VariablePicker({ variableFields, isOpen, onToggle, onClose, contentRef, content, setContent }: VariablePickerProps) {
    return (
        <div style={{ position: 'absolute', left: '100%', top: 0, marginLeft: 8 }}>
            <button type="button" onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 12, fontWeight: 500, color: '#7c3aed', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <Variable className="w-3.5 h-3.5" /> + Add Variable
            </button>
            {isOpen && (
                <>
                    <div className="fixed inset-0 z-10" onClick={onClose} />
                    <div style={{ position: 'absolute', left: 0, top: '100%', marginTop: 4, width: 220, maxHeight: 260, overflowY: 'auto', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 20, padding: '4px 0' }}>
                        {['Main', 'Metadata'].map(group => {
                            const items = variableFields.filter(f => f.group === group);
                            if (items.length === 0) return null;
                            return (
                                <div key={group}>
                                    <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', padding: '6px 12px 2px', textTransform: 'uppercase' }}>{group}</div>
                                    {items.map(f => (
                                        <button key={f.label} onClick={() => {
                                            const ta = contentRef.current;
                                            const insert = `{${f.label}}`;
                                            if (ta) {
                                                const start = ta.selectionStart;
                                                const end = ta.selectionEnd;
                                                const newVal = content.slice(0, start) + insert + content.slice(end);
                                                setContent(newVal);
                                                setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + insert.length; }, 0);
                                            } else {
                                                setContent(content + insert);
                                            }
                                            onClose();
                                        }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 12px', fontSize: 13, color: '#374151', background: 'transparent', border: 'none', cursor: 'pointer' }}
                                            onMouseEnter={e => { e.currentTarget.style.background = '#f3f4f6'; }}
                                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
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
    );
}
