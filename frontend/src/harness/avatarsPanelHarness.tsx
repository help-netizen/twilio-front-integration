/**
 * AvatarsPanel harness (AVATARS-001 Phase D) — the real hub with a fetch stub
 * standing in for GET /api/avatars + the self-consent endpoints. Toggle the
 * scenario buttons: connected / not-connected / not-enabled. No backend.
 * Run: slot-harness (npx vite in frontend/) → /avatars-panel-harness.html
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { Button } from '../components/ui/button';
import { AvatarsPanel } from '../components/settings/AvatarsPanel';

type Scenario = 'connected' | 'claude' | 'fresh' | 'disabled';
let scenario: Scenario = 'connected';
let connectedBase: 'chatgpt' | 'claude' = 'chatgpt';
let writes = true;
let sends = false;

function meObj() {
    return { connected: true, base: connectedBase, mode: 'mcp', writes_enabled: writes, sends_enabled: sends };
}

function body() {
    const enabled = scenario !== 'disabled';
    const me = (scenario === 'connected' || scenario === 'claude') ? meObj() : null;
    const roster = enabled ? [
        { owner_user_id: 'me', owner_name: 'Rustam G.', base: connectedBase, connection_status: 'connected', presence: 'active', is_me: true },
        { owner_user_id: 'u2', owner_name: 'Maria K.', base: 'claude', connection_status: 'connected', presence: 'active', is_me: false },
        { owner_user_id: 'u3', owner_name: 'John D.', base: 'chatgpt', connection_status: 'connected', presence: 'idle', is_me: false },
    ] : [];
    return JSON.stringify({ installation_enabled: enabled, me, roster });
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const ok = (b: string) => new Response(b, { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/avatars')) return ok(body());
    if (url.includes('/api/avatars/me/connect')) { connectedBase = JSON.parse(String(init?.body || '{}')).base || 'chatgpt'; scenario = 'connected'; return ok(JSON.stringify(meObj())); }
    if (url.includes('/api/avatars/me/writes')) { writes = JSON.parse(String(init?.body || '{}')).enabled; return ok(JSON.stringify(meObj())); }
    if (url.includes('/api/avatars/me/sends')) { sends = JSON.parse(String(init?.body || '{}')).enabled; return ok(JSON.stringify(meObj())); }
    if (url.includes('/api/avatars/me/disconnect')) { scenario = 'fresh'; return ok(JSON.stringify({ success: true })); }
    return realFetch(input, init);
};

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Harness() {
    const [open, setOpen] = useState(true);
    const [, force] = useState(0);
    const set = (s: Scenario) => {
        scenario = s;
        if (s === 'connected') connectedBase = 'chatgpt';
        if (s === 'claude') connectedBase = 'claude';
        qc.invalidateQueries({ queryKey: ['avatars'] }); force(x => x + 1);
    };
    return (
        <div className="min-h-screen bg-[var(--blanc-bg)] p-6">
            <div className="flex flex-wrap gap-2">
                <Button onClick={() => setOpen(true)}>Open</Button>
                <Button variant="outline" onClick={() => set('connected')}>ChatGPT connected</Button>
                <Button variant="outline" onClick={() => set('claude')}>Claude connected</Button>
                <Button variant="outline" onClick={() => set('fresh')}>Not connected</Button>
                <Button variant="outline" onClick={() => set('disabled')}>Not enabled</Button>
            </div>
            <AvatarsPanel open={open} onOpenChange={setOpen} myName="Rustam G." companyName="ABC Homes" />
            <Toaster position="bottom-right" />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={qc}><Harness /></QueryClientProvider>
);
