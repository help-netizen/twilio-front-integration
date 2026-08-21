/** AGENT-EXCLUSION-001 design-qa — real AgentExclusionsSection with a seeded
 *  react-query cache (manual + from_blacklist), no network. Run: /agent-exclusions-harness.html */
import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { AuthProvider } from '../auth/AuthProvider';
import { AgentExclusionsSection } from '../pages/telephony/AgentExclusionsSection';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
queryClient.setQueryData(['telephony-agent-exclusions'], {
    manual: [
        { id: '1', phone_e164: '+16175550142', created_at: '2026-08-21T12:00:00Z' },
        { id: '2', phone_e164: '+15085551990', created_at: '2026-08-21T12:00:00Z' },
    ],
    from_blacklist: [
        { id: '9', phone_e164: '+18575550100', created_at: '2026-08-20T12:00:00Z' },
    ],
});

function App() {
    return (
        <div className="fixed inset-0 overflow-auto bg-[var(--blanc-bg,#F1F1F0)] p-8">
            <div className="mx-auto w-full max-w-[720px]">
                <AgentExclusionsSection />
            </div>
        </div>
    );
}
class Boundary extends Component<{ children: ReactNode }, { err: unknown }> {
    state = { err: null as unknown };
    static getDerivedStateFromError(err: unknown) { return { err }; }
    render() { return this.state.err ? <pre style={{ padding: 20 }}>{String((this.state.err as any)?.stack || this.state.err)}</pre> : this.props.children; }
}
createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <AuthProvider><MemoryRouter><Boundary><App /></Boundary></MemoryRouter></AuthProvider>
        <Toaster />
    </QueryClientProvider>,
);
