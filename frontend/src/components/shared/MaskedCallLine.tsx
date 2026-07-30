/**
 * MaskedCallLine — CALL-MASKING-001. Privacy gate for a customer phone row.
 *
 * When the company has masking on AND the viewer is a field tech (holds
 * `call_masking.use`), the tech sees ONLY the masked line — the customer's real
 * number is replaced, so the tech can't bypass masking (every masked call is
 * recorded and the customer never sees the tech's line). Tapping dials
 * `tel:<masking#>,,<code>` (post-dial DTMF).
 *
 * Otherwise (no permission, masking off, or lookup failed) it renders `children`
 * — the normal real-number row. Techs briefly render nothing while the lookup is
 * in flight, so the real number never flashes before being masked.
 */
import { useEffect, useState, type ReactNode } from 'react';
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
    /** The VIEWER's team profile has no phone — the masked call can't route. */
    caller_phone_missing?: boolean;
}

interface MaskedCallLineProps {
    entityType: 'job' | 'contact';
    entityId: string | number;
    /** The normal real-number row, shown when masking does not apply to this viewer. */
    children: ReactNode;
}

export function MaskedCallLine({ entityType, entityId, children }: MaskedCallLineProps) {
    const { hasPermission } = useAuthz();
    const canMask = hasPermission('call_masking.use');
    const [dial, setDial] = useState<MaskedDial | null>(null);
    // Non-techs resolve immediately (real number shown at once); techs wait for
    // the lookup so the real number never flashes before it can be masked.
    const [resolved, setResolved] = useState(!canMask);

    useEffect(() => {
        if (!canMask || entityId == null) { setResolved(true); return; }
        let alive = true;
        setResolved(false);
        (async () => {
            try {
                const res = await authedFetch(`/api/${entityType}s/${entityId}/call-masking`);
                if (!res.ok) return;
                const json = await res.json().catch(() => null);
                const data: MaskedDial | undefined = json?.data ?? json;
                if (alive && data?.enabled && data.tel_uri) setDial(data);
            } catch {
                /* silent — fall back to the real number */
            } finally {
                if (alive) setResolved(true);
            }
        })();
        return () => { alive = false; };
    }, [entityType, entityId, canMask]);

    if (!resolved) return null;

    if (dial?.enabled && dial.tel_uri) {
        return (
            <span className="inline-flex flex-col items-start gap-0.5">
                <a
                    href={dial.tel_uri}
                    className="inline-flex items-center gap-1.5 text-[13px] font-semibold hover:underline"
                    style={{ color: 'var(--blanc-accent)' }}
                    title="Call the customer through your company number — recorded, and your line stays private"
                >
                    <ShieldCheck className="size-3.5 shrink-0" />
                    {formatPhone(dial.masking_number || '')} · {dial.code}
                </a>
                {dial.caller_phone_missing && (
                    <span className="text-[12px] leading-snug" style={{ color: 'var(--blanc-danger)' }}>
                        Add your mobile number to your team profile — masked calls only connect from it.
                    </span>
                )}
            </span>
        );
    }

    return <>{children}</>;
}
