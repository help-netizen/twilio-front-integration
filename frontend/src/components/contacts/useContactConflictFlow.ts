import { useCallback, useRef, useState } from 'react';
import { updateContact, ContactsApiError, type UpdateContactFields } from '../../services/contactsApi';
import type { Contact, ContactConflict, ContactConflictResolution } from '../../types/contact';

/**
 * CONTACT-MERGE-001 — shared save → conflict → retry state machine, used by both
 * v1 surfaces (EditContactDialog, PulseContactPanel — wired in CM1-T4).
 *
 * Flow:
 *   save(contactId, fields)
 *     → `updateContact`; on 409 `CONTACT_ATTRIBUTE_CONFLICT` read `details.conflicts`
 *     → show `MergeContactsDialog` SEQUENTIALLY per owner (one conflict entry = one dialog)
 *     → collect `resolutions[]` → ONE retry `updateContact(fields, resolutions)`
 *     → a retry that 409s again (stale echo) restarts the dialog round with the fresh payload
 *     → any Cancel (button / Escape / backdrop) aborts the WHOLE save with NO retry —
 *       round 1 committed nothing server-side, the editor keeps its entered values (FR-7).
 *
 * A 409 conflict never surfaces as a generic error toast: it is consumed here and
 * resolved to `{ status: 'saved' | 'cancelled' }`. Every OTHER error is re-thrown
 * so the calling surface keeps today's toast handling.
 *
 * Wiring:
 *   const flow = useContactConflictFlow();
 *   ...
 *   const result = await flow.save(contact.id, fields);   // in the submit handler
 *   ...
 *   <MergeContactsDialog conflict={flow.activeConflict} onConfirm={flow.confirm} onCancel={flow.cancel} />
 */

export type ContactConflictAction = ContactConflictResolution['action'];

/** Outcome of a `save()` run once every conflict (if any) is settled. */
export type ContactConflictFlowResult =
    | { status: 'saved'; contact: Contact }
    | { status: 'cancelled' };

export interface ContactConflictFlow {
    /**
     * Save the contact through the conflict round-trip. Resolves 'saved' on
     * success (with the server's post-resolution contact), 'cancelled' when the
     * user aborted a conflict dialog. Rejects with the original error for
     * anything that is not a CONTACT_ATTRIBUTE_CONFLICT 409.
     */
    save: (contactId: number, fields: UpdateContactFields) => Promise<ContactConflictFlowResult>;
    /** The conflict to render in `MergeContactsDialog`; null = no dialog open. */
    activeConflict: ContactConflict | null;
    /** Dialog "Merge contacts" / "Transfer …" click — resolves the current dialog. */
    confirm: (action: ContactConflictAction) => void;
    /** Dialog Cancel / Escape / backdrop — aborts the whole save, no retry. */
    cancel: () => void;
}

export function useContactConflictFlow(): ContactConflictFlow {
    const [activeConflict, setActiveConflict] = useState<ContactConflict | null>(null);
    // Resolver of the promise the save() loop is currently awaiting on. Also the
    // "a dialog round is active" flag — set before the state update, cleared on settle.
    const resolverRef = useRef<((choice: ContactConflictAction | null) => void) | null>(null);

    const askUser = useCallback((conflict: ContactConflict) => {
        return new Promise<ContactConflictAction | null>((resolve) => {
            resolverRef.current = resolve;
            setActiveConflict(conflict);
        });
    }, []);

    const settle = useCallback((choice: ContactConflictAction | null) => {
        const resolve = resolverRef.current;
        resolverRef.current = null;
        resolve?.(choice);
    }, []);

    const confirm = useCallback((action: ContactConflictAction) => settle(action), [settle]);
    const cancel = useCallback(() => settle(null), [settle]);

    const save = useCallback(
        async (contactId: number, fields: UpdateContactFields): Promise<ContactConflictFlowResult> => {
            if (resolverRef.current) {
                throw new Error('A contact save is already awaiting conflict confirmation');
            }
            let resolutions: ContactConflictResolution[] | undefined;
            for (;;) {
                try {
                    const res = await updateContact(contactId, fields, resolutions);
                    return { status: 'saved', contact: res.data.contact };
                } catch (err) {
                    const conflicts =
                        err instanceof ContactsApiError && err.code === 'CONTACT_ATTRIBUTE_CONFLICT'
                            ? err.details?.conflicts
                            : undefined;
                    // Not a conflict 409 (or a malformed one) → the surface's own error
                    // handling (today's toasts) takes over.
                    if (!conflicts || conflicts.length === 0) throw err;

                    // Sequential dialogs — one per owner entry, in payload order.
                    const collected: ContactConflictResolution[] = [];
                    let cancelled = false;
                    for (const conflict of conflicts) {
                        const choice = await askUser(conflict);
                        if (choice === null) {
                            cancelled = true;
                            break;
                        }
                        collected.push({
                            owner_contact_id: conflict.owner.id,
                            action: choice,
                            // Strict echo of the DETECTED attribute set (staleness check server-side).
                            attributes: conflict.attributes.map((a) => ({ kind: a.kind, value: a.value })),
                        });
                    }
                    setActiveConflict(null);
                    // FR-7: cancel aborts everything — round 1 committed nothing, no retry.
                    if (cancelled) return { status: 'cancelled' };
                    // ONE retry carrying the whole round's resolutions. If it 409s again
                    // (stale echo), the loop restarts the round with the FRESH payload and
                    // freshly collected resolutions replace these entirely.
                    resolutions = collected;
                }
            }
        },
        [askUser]
    );

    return { save, activeConflict, confirm, cancel };
}
