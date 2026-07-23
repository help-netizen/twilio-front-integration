/**
 * ChatGPT CRM Connector panel harness (CHATGPT-CRM-MCP-001) — renders the REAL
 * ChatgptMcpConnectPanel with a fixture MarketplaceApp, connected/not-connected
 * toggle; no auth/backend.
 *
 * Run:  slot-harness config (npx vite in frontend/)  →  /chatgpt-connect-harness.html
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { Button } from '../components/ui/button';
import { ChatgptMcpConnectPanel } from '../components/settings/ChatgptMcpConnectPanel';
import type { MarketplaceApp } from '../services/marketplaceApi';

function fixtureApp(connected: boolean): MarketplaceApp {
    return {
        id: 1,
        app_key: 'chatgpt-crm-mcp',
        name: 'ChatGPT CRM Connector',
        provider_name: 'Albusto',
        category: 'ai',
        app_type: 'internal',
        short_description: 'Lets an authorized ChatGPT connector read company CRM records.',
        long_description: null,
        logo_url: null,
        docs_url: null,
        support_email: null,
        privacy_url: null,
        requested_scopes: ['jobs:read', 'leads:read', 'contacts:read'],
        access_summary: [
            'Read Jobs, Leads, Contacts, and Schedule',
            'Read Tasks, Estimates, and Invoices',
        ],
        provisioning_mode: 'none',
        status: 'published',
        metadata: {},
        installation: connected
            ? {
                id: 10,
                status: 'connected',
                provisioning_error: null,
                last_used_at: new Date().toISOString(),
            }
            : null,
    } as unknown as MarketplaceApp;
}

function Harness() {
    const [open, setOpen] = useState(true);
    const [connected, setConnected] = useState(true);

    return (
        <div className="min-h-screen bg-[var(--blanc-bg)] p-8">
            <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => setOpen(true)}>Open panel</Button>
                <Button variant="outline" onClick={() => setConnected(value => !value)}>
                    State: {connected ? 'connected' : 'not connected'}
                </Button>
            </div>
            <ChatgptMcpConnectPanel
                open={open}
                onOpenChange={setOpen}
                app={fixtureApp(connected)}
                onDisconnect={() => {
                    // eslint-disable-next-line no-console
                    console.log('[harness] disconnect requested');
                    setOpen(false);
                }}
            />
            <Toaster position="bottom-right" />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
