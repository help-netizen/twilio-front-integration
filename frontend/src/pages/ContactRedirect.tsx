import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { getContact } from '../services/contactsApi';

/**
 * CONTACT-NUMBERING-001 redirect shim. Resolve a contact by its global id
 * (`/contacts/by-id/:id`, used by FK-only builders — tasks parentPath, lead/job
 * cross-links) → its durable `public_code` → replace to the canonical
 * `/contacts/:code` so the global id never stays in the URL. `getContact` is
 * company-scoped server-side, so a contact outside the caller's company falls
 * through to the list.
 */
export function ContactByIdRedirect() {
    const { id } = useParams<{ id: string }>();
    const [code, setCode] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        getContact(Number(id))
            .then(res => {
                if (cancelled) return;
                const c = res.data.contact.public_code;
                if (c) setCode(c); else setFailed(true);
            })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (failed) return <Navigate to="/contacts" replace />;
    if (code == null) return null; // resolving…
    return <Navigate to={`/contacts/${code}`} replace />;
}
