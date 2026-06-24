/**
 * NewJobModal — SCHED-ROUTE-001 FR-001.
 * Captures a title + address for a manual Albusto job created from a schedule
 * slot. When AddressAutocomplete yields coordinates they are sent through so
 * the server skips the paid geocode; otherwise the server geocodes async.
 * The job is created unassigned (slot provider ids are ZenBooker ids, not the
 * internal crm_users.id the route engine keys on — assignment is done after,
 * via the existing reassign DnD).
 */
import { useState } from 'react';
import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle, DialogDescription } from '../ui/dialog';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
import { AddressAutocomplete } from '../AddressAutocomplete';
import { EMPTY_ADDRESS, type AddressFields } from '../addressAutoHelpers';
import { formatTimeInTZ } from '../../utils/companyTime';
import type { CreateFromSlotPayload } from '../../services/scheduleApi';

interface NewJobModalProps {
    open: boolean;
    startAt: string;
    endAt: string;
    timezone: string;
    providerId?: string;
    providerName?: string;
    onClose: () => void;
    onSubmit: (payload: CreateFromSlotPayload) => void;
}

function composeAddress(a: AddressFields): string {
    const street = [a.street, a.apt].filter(Boolean).join(' ');
    return [street, a.city, a.state, a.zip].filter(Boolean).join(', ');
}

export function NewJobModal({ open, startAt, endAt, timezone, providerId, providerName, onClose, onSubmit }: NewJobModalProps) {
    const [title, setTitle] = useState('');
    const [addr, setAddr] = useState<AddressFields>(EMPTY_ADDRESS);

    const reset = () => { setTitle(''); setAddr(EMPTY_ADDRESS); };
    const close = () => { reset(); onClose(); };

    const submit = () => {
        const address = composeAddress(addr);
        onSubmit({
            title: title.trim() || 'New job',
            start_at: startAt,
            end_at: endAt,
            entity_type: 'job',
            // Assign to the lane's provider (ZenBooker shape; server resolves the
            // internal crm_users.id mirror so routing + grouping line up).
            assigned_techs: providerId ? [{ id: providerId, name: providerName || '' }] : undefined,
            address: address || undefined,
            lat: addr.lat ?? null,
            lng: addr.lng ?? null,
            normalized_address: address || null,
            zb_address: {
                line1: [addr.street, addr.apt].filter(Boolean).join(' ') || undefined,
                city: addr.city || undefined,
                state: addr.state || undefined,
                postal_code: addr.zip || undefined,
            },
        });
        reset();
    };

    const timeLabel = `${formatTimeInTZ(new Date(startAt), timezone)} – ${formatTimeInTZ(new Date(endAt), timezone)}`;

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        New job
                    </DialogTitle>
                    <DialogDescription>
                        {timeLabel}{providerName ? ` · ${providerName}` : ''}
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                  <div className="mx-auto w-full max-w-[740px] space-y-6">
                    <FloatingField
                        id="njm-title"
                        label="Title"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                    />
                    <AddressAutocomplete
                        idPrefix="njm"
                        defaultUseDetails
                        hideDetailsToggle
                        value={addr}
                        onChange={setAddr}
                    />
                  </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button variant="ghost" onClick={close}>Cancel</Button>
                    <Button onClick={submit}>Create job</Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}
