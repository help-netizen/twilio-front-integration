/**
 * PlaceAutocompleteInput dev harness — renders the REAL component against the REAL
 * Google Places API (needs VITE_GOOGLE_MAPS_API_KEY in frontend/.env), no auth/backend.
 * Mirrors the technician "Start location" usage in CompanyUserDialogs.
 *
 * Run:  npx vite  →  http://localhost:3001/place-autocomplete-harness.html
 *
 * What to check:
 *  - typing "301 Common St, Brain" lists Google suggestions (the New Job behaviour);
 *  - a BARE ZIP ("02184") also suggests — the first-space gate is deliberately absent;
 *  - picking a suggestion fills the field AND reports lat/lng (that is what gets saved,
 *    so the server never re-geocodes the text into the wrong spot);
 *  - typing by hand after a pick clears the coordinates (falls back to server geocode);
 *  - ↑/↓ moves, Enter picks, Esc closes.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { PlaceAutocompleteInput } from '../components/PlaceAutocompleteInput';
import type { AddressFields } from '../components/addressAutoHelpers';

function Harness() {
    const [value, setValue] = useState('');
    const [picked, setPicked] = useState<AddressFields | null>(null);

    return (
        <div style={{ background: 'var(--blanc-bg)', minHeight: '100vh', padding: 24 }}>
            <div style={{ maxWidth: 560, margin: '0 auto' }}>
                <h1 className="text-xl font-semibold mb-1" style={{ color: 'var(--blanc-ink-1)' }}>
                    Start location — Places autocomplete
                </h1>
                <p className="text-[12.5px] mb-5" style={{ color: 'var(--blanc-ink-3)' }}>
                    Try “301 Common St, Brain”, then a bare ZIP “02184”.
                </p>

                <PlaceAutocompleteInput
                    id="tech-start-location"
                    label="Start location"
                    value={value}
                    onChange={text => { setValue(text); setPicked(null); }}
                    onPick={({ address, fields }) => { setValue(address); setPicked(fields); }}
                />
                <p className="text-[12.5px] mt-1.5" style={{ color: 'var(--blanc-ink-3)' }}>
                    Address or just a ZIP — drive time and slot suggestions count from here.
                </p>

                <pre
                    data-testid="picked"
                    className="mt-6 rounded-xl p-3 text-[12px] overflow-auto"
                    style={{ background: 'var(--blanc-surface-muted)', color: 'var(--blanc-ink-2)' }}
                >
{JSON.stringify({ value, picked: picked ?? '(none — server would geocode the text)' }, null, 2)}
                </pre>
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
