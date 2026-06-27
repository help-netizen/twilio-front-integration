import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { AddressAutocomplete, type AddressFields } from '../AddressAutocomplete';

/**
 * Shared edit form for the base-address editors (ADDR-UX-001).
 *
 * Holds the draft `AddressFields` and renders the controlled `AddressAutocomplete`
 * (NO auto-save). Google picks populate every field incl. lat/lng/place_id; the user can
 * still add an Apt/Unit before saving. Save composes nothing here — it hands the raw draft
 * back to the parent, which performs the upsert (and surfaces a geocode-fail 422 by leaving
 * the form open). Cancel discards the draft.
 *
 * Used by both `CompanyBaseAddress` and the per-technician base editor in
 * `TechnicianPhotosPage`, so the misuse (auto-save + empty edit form) lives in one place.
 */
export function BaseAddressForm({
    initial,
    onSave,
    onCancel,
    idPrefix,
    streetLabel,
    saving = false,
}: {
    /** Pre-fill the draft (structured fields from the stored row, or a parsed fallback). */
    initial: AddressFields;
    /** Persist the draft. Throws on failure → the form stays open. */
    onSave: (fields: AddressFields) => Promise<void>;
    onCancel: () => void;
    idPrefix: string;
    streetLabel: string;
    saving?: boolean;
}) {
    const [draft, setDraft] = useState<AddressFields>(initial);

    const handleSave = async () => {
        try {
            await onSave(draft);
        } catch {
            // Parent toasts the server message (incl. geocode-fail 422); stay in edit.
        }
    };

    return (
        <div className="mt-3 space-y-3">
            <AddressAutocomplete
                value={draft}
                onChange={setDraft}
                idPrefix={idPrefix}
                streetLabel={streetLabel}
                defaultUseDetails
                hideDetailsToggle
            />
            <p className="text-[11px]" style={{ color: 'var(--blanc-ink-3)' }}>
                Pick a suggestion or type the address — we'll find the coordinates on save.
            </p>
            <div className="flex items-center gap-2">
                <Button size="sm" disabled={saving} onClick={handleSave}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
                </Button>
                <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel} style={{ color: 'var(--blanc-ink-3)' }}>
                    Cancel
                </Button>
            </div>
        </div>
    );
}
