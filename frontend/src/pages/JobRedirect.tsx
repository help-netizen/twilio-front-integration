import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { getJob, getJobByCode, type LocalJob } from '../services/jobsApi';

/**
 * JOB-NUMBERING-001 redirect shims. Resolve a job by its global id (`/jobs/by-id/:id`,
 * used by FK-only builders that only hold the id, and by old raw-id links) or by its
 * global public_code (`/j/:code`, durable/external deep links), then replace to the
 * canonical company-relative `/jobs/:seq` URL. Both resolvers are company-scoped /
 * tenant-guarded server-side, so a job outside the caller's company falls through to
 * the jobs list (no cross-tenant leak).
 */
function JobRedirect({ resolve }: { resolve: () => Promise<LocalJob> }) {
    const [seq, setSeq] = useState<number | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        resolve()
            .then(job => {
                if (cancelled) return;
                if (job.job_seq != null) setSeq(job.job_seq);
                else setFailed(true);
            })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (failed) return <Navigate to="/jobs" replace />;
    if (seq == null) return null; // resolving…
    return <Navigate to={`/jobs/${seq}`} replace />;
}

export function JobByIdRedirect() {
    const { id } = useParams<{ id: string }>();
    return <JobRedirect resolve={() => getJob(Number(id))} />;
}

export function JobByCodeRedirect() {
    const { code } = useParams<{ code: string }>();
    return <JobRedirect resolve={() => getJobByCode(String(code))} />;
}
