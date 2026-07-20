/**
 * Day-off filter dev harness (TECH-DAYOFF-002) — renders the REAL schedule
 * views (DayView mobile agenda / TimelineView / TimelineWeekView) with explicit
 * time off, partial schedule gaps, technician days off, company closure, jobs,
 * and a toggleable provider filter; no auth/backend.
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

const mixedDay = new Date(); mixedDay.setHours(0, 0, 0, 0);
const closedDay = new Date(mixedDay); closedDay.setDate(closedDay.getDate() + 1);
const atDay = (day: Date, h: number, m = 0) => {
    const d = new Date(day);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
};

const mkItem = (id: number, techId: string, techName: string, h1: number, h2: number, name: string): ScheduleItem => ({
    entity_type: 'job', entity_id: id, title: `Job #${id}`, subtitle: 'COD Service', status: 'Submitted',
    start_at: atDay(mixedDay, h1), end_at: atDay(mixedDay, h2), address_summary: '12 Main St', city: 'Boston',
    lat: null, lng: null, normalized_address: null, geocoding_status: null, google_maps_url: null,
    customer_name: name, customer_phone: '+16175550100', customer_email: '',
    assigned_techs: [{ id: techId, name: techName }], job_type: null, job_source: null, tags: null,
});

const items: ScheduleItem[] = [
    mkItem(101, 't1', 'Alex Johnson', 9, 10, 'Smith'),
    mkItem(102, 't1', 'Alex Johnson', 12, 13, 'Brown'),
    mkItem(103, 't3', 'Sam Perry', 10, 11, 'Garcia'),
];

const mixedDayEnd = new Date(mixedDay); mixedDayEnd.setDate(mixedDayEnd.getDate() + 1);
const closedDayEnd = new Date(closedDay); closedDayEnd.setDate(closedDayEnd.getDate() + 1);
const unavailability: UnavailabilityBlock[] = [
    // Mixed day: these two schedule-derived edges are the noise under test.
    { id: 'gap-before', kind: 'schedule_gap', technician_id: 't1', technician_name: 'Alex Johnson', starts_at: mixedDay.toISOString(), ends_at: atDay(mixedDay, 8), source: 'work_schedule', mutable: false },
    { id: 'gap-after', kind: 'schedule_gap', technician_id: 't1', technician_name: 'Alex Johnson', starts_at: atDay(mixedDay, 18), ends_at: mixedDayEnd.toISOString(), source: 'work_schedule', mutable: false },
    // Mixed day: Maria is off while Alex and Sam still have jobs.
    { id: 'tech-day-off', kind: 'schedule_gap', technician_id: 't2', technician_name: 'Maria Lopez', starts_at: mixedDay.toISOString(), ends_at: mixedDayEnd.toISOString(), source: 'work_schedule', mutable: false },
    // Explicit persisted Time off must remain exactly visible.
    { id: 'time-off', kind: 'time_off', technician_id: 't1', technician_name: 'Alex Johnson', starts_at: atDay(mixedDay, 14), ends_at: atDay(mixedDay, 16), note: 'Dentist', source: 'individual', mutable: true },
    // Company-closed day: one derived row per lane in the scoped payload; mobile
    // must aggregate these into one anonymous Company closed row.
    ...providers.map(provider => ({
        id: `company-closed-${provider.id}`,
        kind: 'schedule_gap' as const,
        technician_id: provider.id,
        technician_name: provider.name,
        starts_at: closedDay.toISOString(),
        ends_at: closedDayEnd.toISOString(),
        source: 'company' as const,
        mutable: false,
    })),
];

/* ── Harness shell ── */
function Harness() {
    const [view, setView] = useState<'day' | 'timeline' | 'week'>('timeline');
    const [scenario, setScenario] = useState<'mixed' | 'closed'>('mixed');
    const [filtered, setFiltered] = useState(false);
    const providerFilterIds = filtered ? ['t1'] : undefined;
    const shownItems = filtered
        ? items.filter(i => i.assigned_techs?.some(t => t.id === 't1'))
        : items;
    const currentDate = scenario === 'mixed' ? mixedDay : closedDay;
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
                <button onClick={() => setScenario('mixed')} data-scenario-mixed
                    style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #999', background: scenario === 'mixed' ? '#7a4de8' : '#fff', color: scenario === 'mixed' ? '#fff' : '#191919' }}>
                    Mixed day
                </button>
                <button onClick={() => setScenario('closed')} data-scenario-closed
                    style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #999', background: scenario === 'closed' ? '#7a4de8' : '#fff', color: scenario === 'closed' ? '#fff' : '#191919' }}>
                    Company closed day
                </button>
            </div>
            {view === 'day' && (
                <DayView currentDate={currentDate} items={shownItems} settings={settings}
                    onSelectItem={noop} unavailability={unavailability} providerFilterIds={providerFilterIds} />
            )}
            {view === 'timeline' && (
                <TimelineView currentDate={currentDate} items={shownItems} settings={settings}
                    allProviders={providers} onSelectItem={noop} unavailability={unavailability} providerFilterIds={providerFilterIds} />
            )}
            {view === 'week' && (
                <TimelineWeekView currentDate={currentDate} items={shownItems} settings={settings}
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
