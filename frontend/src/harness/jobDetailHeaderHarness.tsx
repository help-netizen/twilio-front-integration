/**
 * Job detail header harness — renders the REAL JobDetailHeader with no auth/backend,
 * to visually verify JOB-NUMBERING-001 phase 1: the "Job #" eyebrow now reads job_seq,
 * with the fallback chain job_seq ?? job_number ?? id.
 *
 * Run:  npx vite (frontend/)  →  /job-detail-header-harness.html
 * Three cards cover every branch of the fallback so design-qa sees them in one shot.
 */
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { JobDetailHeader } from '../components/jobs/JobDetailHeader';
import type { LocalJob } from '../services/jobsApi';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const mockJob = (over: Partial<LocalJob>): LocalJob => ({
    id: 2066,
    service_name: 'Refrigerator Repair',
    blanc_status: 'Scheduled',
    job_source: 'Google LSA',
    ...over,
} as unknown as LocalJob);

const CASES: { label: string; job: LocalJob }[] = [
    { label: 'job_seq present → "#1917" (the new per-company Job #)', job: mockJob({ job_seq: 1917, public_code: '0IMBQ' }) },
    { label: 'job_seq null, legacy ZB job_number → "#ZB-4421"', job: mockJob({ job_seq: null, job_number: 'ZB-4421' }) },
    { label: 'both null → falls back to id "#2066"', job: mockJob({ job_seq: null, job_number: undefined }) },
];

function Harness() {
    return (
        <QueryClientProvider client={queryClient}>
            <MemoryRouter>
                <div style={{ background: 'var(--blanc-bg)', minHeight: '100vh', padding: 20, fontFamily: 'var(--blanc-font-body, system-ui)' }}>
                    <h1 className="text-lg font-semibold mb-1" style={{ color: 'var(--blanc-ink-1)' }}>
                        JobDetailHeader — "Job #" (JOB-NUMBERING-001)
                    </h1>
                    <p className="text-[12.5px] mb-5" style={{ color: 'var(--blanc-ink-3)' }}>
                        The eyebrow shows job_seq ?? job_number ?? id. Status dropdown is empty (no FSM backend) — expected.
                    </p>
                    <div className="space-y-5">
                        {CASES.map(({ label, job }) => (
                            <div key={label}>
                                <div className="text-[11px] font-medium mb-1.5" style={{ color: 'var(--blanc-ink-3)' }}>{label}</div>
                                <div style={{ maxWidth: 440, background: 'var(--blanc-surface-strong)', borderRadius: 16, border: '1px solid var(--blanc-line)', overflow: 'hidden' }}>
                                    <JobDetailHeader
                                        job={job}
                                        contactInfo={null}
                                        navigate={() => {}}
                                        onBlancStatusChange={() => {}}
                                        onCancel={() => {}}
                                        onCopy={() => {}}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </MemoryRouter>
        </QueryClientProvider>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
