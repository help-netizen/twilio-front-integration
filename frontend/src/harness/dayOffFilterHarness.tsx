/**
 * Day-off filter dev harness (TECH-DAYOFF-002) — renders the REAL schedule
 * views (DayView mobile agenda / TimelineView / TimelineWeekView) with fixture
 * jobs + time-off blocks and a toggleable provider filter; no auth/backend.
 *
 * Run:  npx vite  →  http://localhost:3001/dayoff-harness.html
 * Expectation: with the "Alex only" filter active, Maria's time-off must NOT
 * render in any view; with no filter, both blocks show.
 *
 * House lesson (mobile-select fix): a real-component Vite harness beats
 * synthetic repros — this mounts the exact production components.
 */

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import '../styles/schedule-redesign.css';
import { DayView } from '../components/schedule/DayView';
import { TimelineView } from '../components/schedule/TimelineView';
import { TimelineWeekView } from '../components/schedule/TimelineWeekView';
import type { ScheduleItem, DispatchSettings, UnavailabilityBlock } from '../services/scheduleApi';

/* ── Fixtures ── */
const settings: DispatchSettings = {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    work_start_time: '08:00',
    work_end_time: '18:00',
    work_days: [1, 2, 3, 4, 5],
    slot_duration: 60,
    distance_unit: 'mi',
};

const providers = [
    { id: 't1', name: 'Alex Johnson' },
    { id: 't2', name: 'Maria Lopez' },
    { id: 't3', name: 'Sam Perry' },
];

const atToday = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };

const mkItem = (id: number, techId: string, techName: string, h1: number, h2: number, name: string): ScheduleItem => ({
    entity_type: 'job', entity_id: id, title: `Job #${id}`, subtitle: 'COD Service', status: 'Submitted',
    start_at: atToday(h1), end_at: atToday(h2), address_summary: '12 Main St', city: 'Boston',
    lat: null, lng: null, normalized_address: null, geocoding_status: null, google_maps_url: null,
    customer_name: name, customer_phone: '+16175550100', customer_email: '',
    assigned_techs: [{ id: techId, name: techName }], job_type: null, job_source: null, tags: null,
});

const items: ScheduleItem[] = [
    mkItem(101, 't1', 'Alex Johnson', 9, 10, 'Smith'),
    mkItem(102, 't1', 'Alex Johnson', 12, 13, 'Brown'),
    mkItem(103, 't2', 'Maria Lopez', 10, 11, 'Garcia'),
];

const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
const dayEnd = new Date(dayStart.getTime() + 86400000);
const unavailability: UnavailabilityBlock[] = [
    { id: 'off-1', kind: 'time_off', technician_id: 't2', technician_name: 'Maria Lopez', starts_at: dayStart.toISOString(), ends_at: dayEnd.toISOString(), note: 'Vacation — Cancun', source: 'individual', mutable: true },
    { id: 'off-2', kind: 'time_off', technician_id: 't1', technician_name: 'Alex Johnson', starts_at: atToday(14), ends_at: atToday(16), note: 'Dentist', source: 'individual', mutable: true },
];

/* ── Harness shell ── */
function Harness() {
    const [view, setView] = useState<'day' | 'timeline' | 'week'>('timeline');
    const [filtered, setFiltered] = useState(false);
    const providerFilterIds = filtered ? ['t1'] : undefined;
    const shownItems = filtered
        ? items.filter(i => i.assigned_techs?.some(t => t.id === 't1'))
        : items;
    const noop = () => {};

    return (
        <div style={{ padding: 12 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }} data-harness-controls>
                {(['day', 'timeline', 'week'] as const).map(v => (
                    <button key={v} onClick={() => setView(v)}
                        style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #999', background: view === v ? '#1b8b63' : '#fff', color: view === v ? '#fff' : '#191919' }}>
                        {v}
                    </button>
                ))}
                <button onClick={() => setFiltered(f => !f)} data-filter-toggle
                    style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #999', background: filtered ? '#7a4de8' : '#fff', color: filtered ? '#fff' : '#191919' }}>
                    {filtered ? 'Filter: Alex only' : 'Filter: off (all techs)'}
                </button>
            </div>
            {view === 'day' && (
                <DayView currentDate={new Date()} items={shownItems} settings={settings}
                    onSelectItem={noop} unavailability={unavailability} providerFilterIds={providerFilterIds} />
            )}
            {view === 'timeline' && (
                <TimelineView currentDate={new Date()} items={shownItems} settings={settings}
                    allProviders={providers} onSelectItem={noop} unavailability={unavailability} providerFilterIds={providerFilterIds} />
            )}
            {view === 'week' && (
                <TimelineWeekView currentDate={new Date()} items={shownItems} settings={settings}
                    allProviders={providers} onSelectItem={noop} unavailability={unavailability} providerFilterIds={providerFilterIds} />
            )}
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    <MemoryRouter>
        <Harness />
    </MemoryRouter>,
);
