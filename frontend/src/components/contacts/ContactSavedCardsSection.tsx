import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthz } from '../../hooks/useAuthz';
import * as contactsApi from '../../services/contactsApi';
import type { SavedPaymentMethod } from '../../types/savedCard';
import { Button } from '../ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '../ui/dialog';

function cardBrand(brand: string): string {
    return brand ? `${brand.charAt(0).toUpperCase()}${brand.slice(1)}` : 'Card';
}

export function savedCardExpiry(card: Pick<SavedPaymentMethod, 'exp_month' | 'exp_year'>): string {
    return `${String(card.exp_month).padStart(2, '0')}/${String(card.exp_year).slice(-2)}`;
}

export function ContactSavedCardsSection({
    contactId,
    className = 'px-5 pb-5',
}: {
    contactId: number;
    className?: string;
}) {
    const { hasPermission } = useAuthz();
    const canView = hasPermission('contacts.view') && hasPermission('payments.view');
    const canRemove = canView && hasPermission('contacts.edit');
    const queryClient = useQueryClient();
    const [removeTarget, setRemoveTarget] = useState<SavedPaymentMethod | null>(null);
    const [removing, setRemoving] = useState(false);
    const queryKey = ['contact-saved-payment-methods', contactId];
    const { data: cards = [] } = useQuery({
        queryKey,
        queryFn: () => contactsApi.listSavedPaymentMethods(contactId),
        enabled: canView && contactId > 0,
    });

    if (!canView || cards.length === 0) return null;

    const remove = async () => {
        if (!removeTarget || removing) return;
        setRemoving(true);
        try {
            await contactsApi.removeSavedPaymentMethod(contactId, removeTarget.id);
            await queryClient.invalidateQueries({ queryKey });
            setRemoveTarget(null);
            toast.success('Saved card removed');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Could not remove saved card');
        } finally {
            setRemoving(false);
        }
    };

    return (
        <>
            <section className={`${className} space-y-3.5`} aria-label="Saved cards">
                <p className="blanc-eyebrow">Saved cards</p>
                <div className="space-y-3.5">
                    {cards.map(card => (
                        <div key={card.id} className="flex items-center gap-3">
                            <CreditCard className="size-4 shrink-0 text-[var(--blanc-ink-3)]" aria-hidden="true" />
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-[var(--blanc-ink-1)]">
                                    {cardBrand(card.brand)} •••• {card.last4}
                                </p>
                                <p className="text-xs text-[var(--blanc-ink-2)]">
                                    {savedCardExpiry(card)}
                                </p>
                            </div>
                            {canRemove && (
                                <button
                                    type="button"
                                    onClick={() => setRemoveTarget(card)}
                                    className="flex items-center gap-1.5 rounded-lg p-2 text-xs font-medium text-[var(--blanc-ink-3)] transition-colors hover:text-[var(--blanc-danger)]"
                                    aria-label={`Remove ${cardBrand(card.brand)} ending ${card.last4}`}
                                >
                                    <Trash2 className="size-4" aria-hidden="true" />
                                    Remove
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            </section>

            <Dialog open={!!removeTarget} onOpenChange={open => { if (!open && !removing) setRemoveTarget(null); }}>
                <DialogContent variant="dialog" size="sm">
                    <DialogHeader>
                        <DialogTitle>Remove saved card?</DialogTitle>
                        <DialogDescription>
                            {removeTarget
                                ? `${cardBrand(removeTarget.brand)} •••• ${removeTarget.last4}`
                                : 'Saved card'}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setRemoveTarget(null)} disabled={removing}>Cancel</Button>
                        <Button variant="destructive" onClick={remove} disabled={removing}>
                            {removing && <Loader2 className="size-4 animate-spin" />}
                            Remove card
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
