/**
 * Slot Picker dev harness (JOB-SLOT-SHEET-001) — renders the REAL CustomTimeModal
 * with mocked network + a no-op Google Maps stub, no auth/backend needed.
 *
 * Run:  npx vite  →  http://localhost:3001/harness.html
 * Resize under 768px (or open with a mobile viewport) → the BottomSheet variant.
 *
 * House lesson (mobile-select fix): a real-component Vite harness beats
 * synthetic repros — this mounts the exact production component.
 */

import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import '../styles/schedule-redesign.css';
import { CustomTimeModal } from '../components/conversations/CustomTimeModal';

/* ── Minimal Google Maps stub — enough for JobMap to mount without crashing ── */
class GStub { setMap() {} addListener() { return { remove() {} }; } setCenter() {} setZoom() {} getZoom() { return 11; } fitBounds() {} setOptions() {} open() {} close() {} setContent() {} extend() {} isEmpty() { return false; } getCenter() { return { lat: () => 42.36, lng: () => -71.05 }; } }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).google = {
    maps: {
        Map: GStub, Marker: GStub, InfoWindow: GStub, LatLngBounds: GStub,
        Size: class { w: number; h: number; constructor(w: number, h: number) { this.w = w; this.h = h; } },
        Point: class { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } },
        event: { addListener: () => ({ remove() {} }), trigger() {}, clearInstanceListeners() {} },
        places: { PlacesService: class { searchByText() {} findPlaceFromQuery(_q: unknown, cb: (r: null, s: string) => void) { cb(null, 'ZERO_RESULTS'); } } },
    },
};

/* ── Fixture data ── */
const tz = 'America/New_York';
const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const tomorrowStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(Date.now() + 86400000));
const atToday = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };

const teamMembers = [
    { id: 't1', name: 'Alex Johnson', assigned_territories: [{ id: 'terr1', name: 'Boston' }], is_service_provider: true },
    { id: 't2', name: 'Maria Lopez', assigned_territories: [{ id: 'terr1', name: 'Boston' }], is_service_provider: true },
    { id: 't3', name: 'Sam Perry', assigned_territories: [{ id: 'terr2', name: 'Worcester' }], is_service_provider: true },
];

const mkJob = (id: number, techId: string, techName: string, h1: number, h2: number, name: string, addr: string, lat: number, lng: number) => ({
    id, blanc_status: 'Submitted', zb_status: 'scheduled', service_name: 'COD Service',
    customer_name: name, customer_phone: '+16175550100', address: addr, lat, lng,
    start_date: atToday(h1), end_date: atToday(h2),
    assigned_techs: [{ id: techId, name: techName }],
});
const jobs = [
    mkJob(101, 't1', 'Alex Johnson', 9, 11, 'Dana Whitfield', '12 Beacon St, Boston', 42.358, -71.062),
    mkJob(102, 't1', 'Alex Johnson', 13, 15, 'Omar Reyes', '88 Salem St, Boston', 42.364, -71.056),
    mkJob(103, 't2', 'Maria Lopez', 10, 12, 'Priya Nair', '5 Pleasant St, Cambridge', 42.373, -71.11),
    mkJob(104, 't3', 'Sam Perry', 8, 10, 'Ted Brooks', '2 Main St, Worcester', 42.262, -71.802),
];

const recommendations = [
    { rank: 1, date: todayStr, time_frame: { start: '15:30', end: '17:30' }, technicians: [{ id: 't1', name: 'Alex Johnson' }], score: 93, explanation: '2 mi from previous stop', requires_dispatch_confirmation: false },
    { rank: 2, date: todayStr, time_frame: { start: '12:30', end: '14:30' }, technicians: [{ id: 't2', name: 'Maria Lopez' }], score: 81, explanation: 'Light day nearby', requires_dispatch_confirmation: true },
    { rank: 3, date: tomorrowStr, time_frame: { start: '09:00', end: '11:00' }, technicians: [{ id: 't1', name: 'Alex Johnson' }], score: 74, explanation: 'First stop of the day', requires_dispatch_confirmation: false },
];

/* ── Network mock — answer the three endpoints the modal calls ── */
const okJson = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const origFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/zenbooker/team-members')) return okJson(teamMembers);
    if (url.includes('/api/jobs')) return okJson({ results: jobs, total: jobs.length, offset: 0, limit: 200, has_more: false });
    if (url.includes('/api/schedule/slot-recommendations')) {
        return okJson({
            enabled: true, engine_status: 'ok', recommendations,
            coverage: { technicians_with_base: 2, technicians_total: 3 },
        });
    }
    return origFetch(input, init);
};

createRoot(document.getElementById('root')!).render(
    <MemoryRouter>
        <CustomTimeModal
            open
            onClose={() => console.log('[harness] close')}
            onConfirm={(slot) => console.log('[harness] confirm', slot)}
            newJobCoords={{ lat: 42.361, lng: -71.057 }}
            newJobAddress="45 School St, Boston, MA"
            newJobDuration={120}
            territoryId="terr1"
        />
    </MemoryRouter>
);
