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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
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
            <DialogContent size="wide">
                <DialogHeader>
                    <DialogTitle>New job</DialogTitle>
                    <DialogDescription>
                        {timeLabel}{providerName ? ` · ${providerName}` : ''}
                    </DialogDescription>
                </DialogHeader>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 py-1">
                    <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor="njm-title" className="text-sm font-medium">Title</Label>
                        <Input
                            id="njm-title"
                            value={title}
                            autoFocus
                            placeholder="e.g. Dishwasher repair"
                            onChange={(e) => setTitle(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                        />
                    </div>
                    <div className="sm:col-span-2">
                        <AddressAutocomplete
                            header={<Label className="text-sm font-medium">Address</Label>}
                            idPrefix="njm"
                            defaultUseDetails
                            value={addr}
                            onChange={setAddr}
                        />
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={close}>Cancel</Button>
                    <Button onClick={submit}>Create job</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
