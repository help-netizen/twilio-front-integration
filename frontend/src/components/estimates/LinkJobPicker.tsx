import { useEffect, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogTitle, DialogDescription } from '../ui/dialog';
import { authedFetch } from '../../services/apiClient';

/**
 * Pick the job an estimate belongs to.
 *
 * This replaced `window.prompt('Enter Job ID to link:')` — a browser dialog that
 * asked for a numeric database id from memory. Nobody knows the id of a job;
 * they know it is "the Feldman one on Florida Street", which is exactly what the
 * picker searches on. A prompt that demands a fact the user does not have is a
 * feature that only its author can use.
 */

interface PickerJob {
    id: number;
    job_number: string | null;
    job_seq?: number | null;
    customer_name: string | null;
    address: string | null;
    service_name: string | null;
    start_date: string | null;
    blanc_status: string | null;
}

export function LinkJobPicker({
    open, onOpenChange, onPick,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onPick: (jobId: number) => void;
}) {
    const [query, setQuery] = useState('');
    const [rows, setRows] = useState<PickerJob[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!open) { setQuery(''); setRows([]); setError(''); return; }
        let cancelled = false;
        // Debounced: this runs per keystroke and the search is a substring match.
        const timer = setTimeout(async () => {
            setLoading(true);
            setError('');
            try {
                const res = await authedFetch(`/api/jobs/picker?limit=20&search=${encodeURIComponent(query.trim())}`);
                const json = await res.json();
                if (cancelled) return;
                if (!res.ok || json.ok === false) throw new Error(json.error?.message || json.error || 'Could not search jobs');
                setRows(Array.isArray(json.data) ? json.data : json.data?.jobs || []);
            } catch (err: unknown) {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Could not search jobs');
            } finally {
                if (!cancelled) setLoading(false);
            }
        }, 220);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [open, query]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[20px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Link a job
                    </DialogTitle>
                    <DialogDescription className="sr-only">Search for the job this estimate belongs to</DialogDescription>
                </DialogPanelHeader>
                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px]">
                        <div
                            className="flex items-center gap-2.5 rounded-xl px-3.5"
                            style={{ background: 'var(--blanc-field)', minHeight: 46 }}
                        >
                            <Search className="size-4" style={{ color: 'var(--blanc-ink-3)' }} />
                            <input
                                autoFocus
                                value={query}
                                onChange={event => setQuery(event.target.value)}
                                placeholder="Job number, customer, address…"
                                className="blanc-l2 w-full bg-transparent outline-none"
                                data-testid="link-job-search"
                            />
                        </div>

                        {loading && (
                            <div className="flex justify-center py-8">
                                <Loader2 className="size-5 animate-spin" style={{ color: 'var(--blanc-ink-3)' }} />
                            </div>
                        )}

                        {error && !loading && (
                            <p className="blanc-l2 py-6 text-center" style={{ color: 'var(--blanc-danger)' }}>{error}</p>
                        )}

                        {!loading && !error && rows.length === 0 && (
                            <p className="blanc-l2 blanc-l2-quiet py-8 text-center">
                                {query.trim() ? 'No job matches that.' : 'Start typing to find the job.'}
                            </p>
                        )}

                        <div className="mt-2">
                            {rows.map(job => (
                                <button
                                    key={job.id}
                                    type="button"
                                    onClick={() => { onPick(job.id); onOpenChange(false); }}
                                    className="block w-full rounded-xl px-3.5 py-3 text-left"
                                    style={{ background: 'var(--blanc-surface-strong)', marginTop: 8 }}
                                    data-testid={`link-job-option-${job.id}`}
                                >
                                    <span className="blanc-l2 block" style={{ fontWeight: 600 }}>
                                        {job.customer_name || 'No customer'}
                                        {(job.job_seq ?? job.job_number) ? ` · #${job.job_seq ?? job.job_number}` : ''}
                                    </span>
                                    <span className="blanc-l2 blanc-l2-quiet block">
                                        {[job.service_name, job.address].filter(Boolean).join(' · ') || 'No details'}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                </DialogBody>
            </DialogContent>
        </Dialog>
    );
}
