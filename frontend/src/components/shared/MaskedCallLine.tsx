/**
 * MaskedCallLine — CALL-MASKING-001. When the company has call masking enabled,
 * a field tech sees the masked line to call the customer THROUGH the company
 * number (customer never sees the tech's phone; the call is recorded). Tapping
 * dials `tel:<masking#>,,<code>` — the post-dial DTMF path.
 *
 * Renders nothing unless the viewer holds `call_masking.use` AND masking is on
 * for this entity's contact. Safe to drop next to any customer phone row.
 */
import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { authedFetch } from '../../services/apiClient';
import { useAuthz } from '../../hooks/useAuthz';
import { formatPhoneDisplay as formatPhone } from '../../utils/phoneUtils';

interface MaskedDial {
    enabled: boolean;
    masking_number: string | null;
    code: string | null;
    display_number: string | null;
    tel_uri: string | null;
}

interface MaskedCallLineProps {
    entityType: 'job' | 'contact';
    entityId: string | number;
}

export function MaskedCallLine({ entityType, entityId }: MaskedCallLineProps) {
    const { hasPermission } = useAuthz();
    const canMask = hasPermission('call_masking.use');
    const [dial, setDial] = useState<MaskedDial | null>(null);

    useEffect(() => {
        if (!canMask || entityId == null) return;
        let alive = true;
        (async () => {
            try {
                const res = await authedFetch(`/api/${entityType}s/${entityId}/call-masking`);
                if (!res.ok) return;
                const json = await res.json().catch(() => null);
                const data: MaskedDial | undefined = json?.data ?? json;
                if (alive && data?.enabled && data.tel_uri) setDial(data);
            } catch { /* silent — masking is optional */ }
        })();
        return () => { alive = false; };
    }, [entityType, entityId, canMask]);

    if (!dial?.enabled || !dial.tel_uri) return null;

    return (
        <a
            href={dial.tel_uri}
            className="inline-flex items-center gap-1.5 text-[13px] font-semibold hover:underline"
            style={{ color: 'var(--blanc-accent)' }}
            title="Call the customer through your company number — recorded, and your line stays private"
        >
            <ShieldCheck className="size-3.5 shrink-0" />
            {formatPhone(dial.masking_number || '')} · {dial.code}
        </a>
    );
}
