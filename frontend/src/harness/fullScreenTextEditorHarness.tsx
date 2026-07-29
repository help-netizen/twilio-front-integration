/**
 * FullScreenTextEditor dev harness (INPUT-KBD type B) — the REAL component, no auth/backend.
 * Mirrors the REPORT-POLISH "Report" editor: X + title header, scrolling text, and a bottom
 * action bar (Re-polish + Accept) that rides above the keyboard. ?busy=1 shows the loading state.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { FullScreenTextEditor } from '../components/shared/FullScreenTextEditor';

const SAMPLE = `Technician Report
Make: LG
Appliance Type: French Door Refrigerator
Model: LFX31925ST/00
Serial: Not provided

Failure Issue:
Refrigerator displays ER rF error code and is not cooling properly.

Findings:
Inspection confirmed the evaporator fan motor is blocked by excessive ice buildup, preventing proper airflow into the fresh food compartment. This condition triggers the ER rF error code. The defrost temperature sensor reads out of range.

Needs:
- Complete manual evaporator defrost
- Replace evaporator fan motor assembly
- Replace defrost temperature sensor
- Clean evaporator area and restore airflow
- Test cooling operation and fan performance

Cause:
Excessive ice buildup caused by a defrost control failure, consistent with a failed defrost temperature sensor.

Estimate:
Materials:
• $178.29 – Refrigerator Evaporator Fan Motor Assembly (EAU64824401)
• $64.69 – Defrost Temperature Sensor (ACM73919214)
Materials Total: $242.98
Labor:
• $280.00 – Complete manual defrost, component replacement, evaporator service, and operational testing
Grand Total: $522.98`;

const params = new URLSearchParams(location.search);

function Harness() {
    const [open, setOpen] = useState(true);
    const [busy, setBusy] = useState(params.get('busy') === '1');
    const [val, setVal] = useState(SAMPLE);

    return (
        <div style={{ padding: 24, fontFamily: 'system-ui', color: 'var(--blanc-ink-1)' }}>
            <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Type B — FullScreenTextEditor (Report)</h1>
            <button onClick={() => setOpen(true)} style={{ padding: '10px 16px', borderRadius: 10, background: 'var(--blanc-accent)', color: '#fff', border: 0 }}>
                Open editor
            </button>
            <FullScreenTextEditor
                open={open}
                initialValue={val}
                busy={busy}
                title="Report"
                doneLabel="Accept"
                repolishLabel="Re-polish"
                onRepolish={() => { setBusy(true); setTimeout(() => setBusy(false), 1500); }}
                onDone={(t) => { setVal(t); setOpen(false); }}
                onCancel={() => setOpen(false)}
            />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
