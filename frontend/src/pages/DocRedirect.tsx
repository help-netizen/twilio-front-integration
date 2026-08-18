import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { fetchEstimate } from '../services/estimatesApi';
import { fetchInvoice } from '../services/invoicesApi';

/**
 * INVOICE-ESTIMATE-NUMBERING-001 redirect shims. Resolve an estimate/invoice by its
 * global id (`/estimates/by-id/:id`, used by FK-only builders — tasks parentPath,
 * estimate↔invoice cross-links — and old `?openId` links) → its durable `public_code`
 * → replace to the canonical `/estimates/:code` so the global id never stays in the URL.
 * Both fetches are company-scoped server-side, so a doc outside the caller's company
 * falls through to the list (no cross-tenant leak).
 */
function DocRedirect({ base, resolve }: { base: string; resolve: () => Promise<{ public_code?: string | null }> }) {
    const [code, setCode] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        resolve()
            .then(doc => {
                if (cancelled) return;
                if (doc.public_code) setCode(doc.public_code);
                else setFailed(true);
            })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (failed) return <Navigate to={base} replace />;
    if (code == null) return null; // resolving…
    return <Navigate to={`${base}/${code}`} replace />;
}

export function EstimateByIdRedirect() {
    const { id } = useParams<{ id: string }>();
    return <DocRedirect base="/estimates" resolve={() => fetchEstimate(Number(id))} />;
}

export function InvoiceByIdRedirect() {
    const { id } = useParams<{ id: string }>();
    return <DocRedirect base="/invoices" resolve={() => fetchInvoice(Number(id))} />;
}
