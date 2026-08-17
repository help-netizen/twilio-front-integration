import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import * as leadsApi from '../services/leadsApi';
import type { Lead } from '../types/lead';

/**
 * LEAD-NUMBERING-001 redirect shims. Resolve a lead by its global id (`/leads/by-id/:id`,
 * used by FK-only builders that only hold the id — schedule/tasks/contacts/notifications —
 * and by old raw-id links), its uuid (`/leads/by-uuid/:uuid`, notification refs / the
 * durable API handle), or its global public_code (`/l/:code`, durable/external deep links),
 * then replace to the canonical company-relative `/leads/:seq`. Every resolver is
 * company-scoped / tenant-guarded server-side, so a lead outside the caller's company
 * falls through to the leads list (no cross-tenant leak).
 */
function LeadRedirect({ resolve }: { resolve: () => Promise<Lead> }) {
    const [seq, setSeq] = useState<number | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        resolve()
            .then(lead => {
                if (cancelled) return;
                if (lead.LeadSeq != null) setSeq(lead.LeadSeq);
                else setFailed(true);
            })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (failed) return <Navigate to="/leads" replace />;
    if (seq == null) return null; // resolving…
    return <Navigate to={`/leads/${seq}`} replace />;
}

export function LeadByIdRedirect() {
    const { id } = useParams<{ id: string }>();
    return <LeadRedirect resolve={async () => (await leadsApi.getLeadById(Number(id))).data.lead} />;
}

export function LeadByUuidRedirect() {
    const { uuid } = useParams<{ uuid: string }>();
    return <LeadRedirect resolve={async () => (await leadsApi.getLeadByUUID(String(uuid))).data.lead} />;
}

export function LeadByCodeRedirect() {
    const { code } = useParams<{ code: string }>();
    return <LeadRedirect resolve={async () => (await leadsApi.getLeadByCode(String(code))).data.lead} />;
}
