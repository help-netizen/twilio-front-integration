/**
 * FullScreenSearchPicker dev harness (INPUT-KBD type C) — renders the REAL canonical
 * component with mock data, no auth/backend. Mirrors the "Change provider" usage.
 *
 * Run:  npx vite  →  http://localhost:3001/search-picker-harness.html  (resize < 768px)
 *
 * What to check: opening does NOT auto-focus the search (keyboard stays down); the list
 * shows all rows first; typing filters; tapping a row toggles the checkmark; Save reads
 * the selection; Close/X dismisses. (Keyboard-inset tracking needs a real device.)
 */
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { FullScreenSearchPicker, SearchPickerRow } from '../components/shared/FullScreenSearchPicker';

const PROVIDERS = [
    { id: '1', name: 'Alex Johnson' },
    { id: '2', name: 'Maria Lopez' },
    { id: '3', name: 'Sam Turner' },
    { id: '4', name: 'Priya Patel' },
    { id: '5', name: 'Chen Wei' },
    { id: '6', name: 'Diego Ramirez' },
    { id: '7', name: 'Fatima Khan' },
    { id: '8', name: 'Liam O’Brien' },
    { id: '9', name: 'Yuki Tanaka' },
    { id: '10', name: 'Nadia Petrov' },
    { id: '11', name: 'Marcus Bell' },
    { id: '12', name: 'Sofia Rossi' },
];

function Harness() {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState<Set<string>>(new Set(['1']));
    const [saved, setSaved] = useState<string>('(none yet)');

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? PROVIDERS.filter(p => p.name.toLowerCase().includes(q)) : PROVIDERS;
    }, [query]);

    const toggle = (id: string) => setSelected(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    const save = () => {
        setSaved(PROVIDERS.filter(p => selected.has(p.id)).map(p => p.name).join(', ') || '(cleared)');
        setOpen(false);
    };

    return (
        <div style={{ padding: 24, fontFamily: 'system-ui', color: 'var(--blanc-ink-1)' }}>
            <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Type C — FullScreenSearchPicker</h1>
            <button
                type="button"
                onClick={() => { setQuery(''); setOpen(true); }}
                className="inline-flex min-h-[34px] items-center gap-1 rounded-full px-3 text-[12px] font-semibold"
                style={{ border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-2)', background: '#fff' }}
            >
                Change provider
            </button>
            <p style={{ marginTop: 16, fontSize: 13, color: 'var(--blanc-ink-2)' }}>Last saved: {saved}</p>

            <FullScreenSearchPicker
                open={open}
                onClose={() => setOpen(false)}
                query={query}
                onQueryChange={setQuery}
                placeholder="Search providers…"
                title="Change provider"
                footer={
                    <>
                        <span className="mr-auto pl-1 text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>{selected.size} selected</span>
                        <button type="button" onClick={() => setOpen(false)} className="rounded-full px-4 py-2 text-sm font-semibold" style={{ color: 'var(--blanc-ink-2)' }}>Cancel</button>
                        <button type="button" onClick={save} className="rounded-full px-4 py-2 text-sm font-semibold" style={{ background: 'var(--blanc-accent)', color: '#fff' }}>Save</button>
                    </>
                }
            >
                {filtered.length === 0 ? (
                    <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--blanc-ink-3)' }}>No providers found.</div>
                ) : (
                    filtered.map(p => (
                        <SearchPickerRow key={p.id} selected={selected.has(p.id)} onClick={() => toggle(p.id)}>
                            <span className="block truncate text-[15px]" style={{ color: 'var(--blanc-ink-1)' }}>{p.name}</span>
                        </SearchPickerRow>
                    ))
                )}
            </FullScreenSearchPicker>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
