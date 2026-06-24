import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle, DialogDescription } from '../ui/dialog';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
import { PhoneInput, toE164, formatUSPhone } from '../ui/PhoneInput';
import { toast } from 'sonner';
import * as contactsApi from '../../services/contactsApi';
import type { Contact } from '../../types/contact';

interface EditContactDialogProps {
    contact: Contact;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
}

export function EditContactDialog({ contact, open, onOpenChange, onSuccess }: EditContactDialogProps) {
    const [loading, setLoading] = useState(false);
    const [showSecondary, setShowSecondary] = useState(false);
    const [formData, setFormData] = useState({
        first_name: '',
        last_name: '',
        company_name: '',
        phone_e164: '',
        secondary_phone: '',
        secondary_phone_name: '',
        email: '',
        notes: '',
    });

    useEffect(() => {
        if (open) {
            setFormData({
                first_name: contact.first_name || '',
                last_name: contact.last_name || '',
                company_name: contact.company_name || '',
                phone_e164: formatUSPhone(contact.phone_e164 || ''),
                secondary_phone: formatUSPhone(contact.secondary_phone || ''),
                secondary_phone_name: contact.secondary_phone_name || '',
                email: contact.email || '',
                notes: contact.notes || '',
            });
            setShowSecondary(!!(contact.secondary_phone || contact.secondary_phone_name));
        }
    }, [open, contact]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            await contactsApi.updateContact(contact.id, {
                first_name: formData.first_name,
                last_name: formData.last_name,
                company_name: formData.company_name,
                phone_e164: formData.phone_e164 ? toE164(formData.phone_e164) : '',
                secondary_phone: formData.secondary_phone ? toE164(formData.secondary_phone) : '',
                secondary_phone_name: formData.secondary_phone_name,
                email: formData.email,
                notes: formData.notes,
            });
            toast.success('Contact updated');
            onOpenChange(false);
            onSuccess();
        } catch (err) {
            toast.error('Failed to update contact', {
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Edit contact
                    </DialogTitle>
                    <DialogDescription className="sr-only">Update contact details</DialogDescription>
                </DialogPanelHeader>

                <form onSubmit={handleSubmit} className="contents">
                    <DialogBody className="md:px-8 md:py-7">
                      <div className="mx-auto w-full max-w-[740px] space-y-6">
                        {/* Client details */}
                        <div className="space-y-3.5">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                <FloatingField
                                    id="ec-first-name"
                                    label="First name"
                                    value={formData.first_name}
                                    onChange={(e) => setFormData({ ...formData, first_name: e.target.value })}
                                />
                                <FloatingField
                                    id="ec-last-name"
                                    label="Last name"
                                    value={formData.last_name}
                                    onChange={(e) => setFormData({ ...formData, last_name: e.target.value })}
                                />
                            </div>
                            <FloatingField
                                id="ec-company"
                                label="Company name"
                                value={formData.company_name}
                                onChange={(e) => setFormData({ ...formData, company_name: e.target.value })}
                            />
                        </div>

                        {/* Contact information */}
                        <div className="space-y-3.5">
                            <PhoneInput
                                id="ec-phone"
                                label="Phone number"
                                value={formData.phone_e164}
                                onChange={(formatted) => setFormData({ ...formData, phone_e164: formatted })}
                            />
                            <FloatingField
                                id="ec-email"
                                label="Email"
                                type="email"
                                value={formData.email}
                                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                            />
                            {showSecondary ? (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                    <PhoneInput
                                        id="ec-secondary-phone"
                                        label="Secondary phone"
                                        value={formData.secondary_phone}
                                        onChange={(formatted) => setFormData({ ...formData, secondary_phone: formatted })}
                                    />
                                    <FloatingField
                                        id="ec-secondary-phone-name"
                                        label="Secondary name"
                                        value={formData.secondary_phone_name}
                                        onChange={(e) => setFormData({ ...formData, secondary_phone_name: e.target.value })}
                                    />
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => setShowSecondary(true)}
                                    className="text-xs text-primary hover:underline"
                                >
                                    + Secondary Phone
                                </button>
                            )}
                        </div>

                        {/* Notes */}
                        <FloatingField
                            id="ec-notes"
                            label="Notes"
                            textarea
                            rows={3}
                            value={formData.notes}
                            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                        />
                      </div>
                    </DialogBody>

                    <DialogPanelFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => onOpenChange(false)}
                            disabled={loading}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={loading}>
                            {loading ? 'Saving...' : 'Save Changes'}
                        </Button>
                    </DialogPanelFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
