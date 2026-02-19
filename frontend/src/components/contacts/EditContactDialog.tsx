import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { PhoneInput, toE164, formatUSPhone } from '../ui/PhoneInput';
import { Textarea } from '../ui/textarea';
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
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Edit Contact</DialogTitle>
                    <DialogDescription>
                        Update contact details below.
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-5">
                    {/* Client Details */}
                    <div className="space-y-3">
                        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
                            Client Details
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <Label htmlFor="ec-first-name" className="mb-1.5">First Name</Label>
                                <Input
                                    id="ec-first-name"
                                    value={formData.first_name}
                                    onChange={(e) => setFormData({ ...formData, first_name: e.target.value })}
                                    placeholder="First Name"
                                />
                            </div>
                            <div>
                                <Label htmlFor="ec-last-name" className="mb-1.5">Last Name</Label>
                                <Input
                                    id="ec-last-name"
                                    value={formData.last_name}
                                    onChange={(e) => setFormData({ ...formData, last_name: e.target.value })}
                                    placeholder="Last Name"
                                />
                            </div>
                        </div>
                        <div>
                            <Label htmlFor="ec-company" className="mb-1.5">Company Name</Label>
                            <Input
                                id="ec-company"
                                value={formData.company_name}
                                onChange={(e) => setFormData({ ...formData, company_name: e.target.value })}
                                placeholder="Company Name"
                            />
                        </div>
                    </div>

                    {/* Contact Information */}
                    <div className="space-y-3">
                        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
                            Contact Information
                        </h3>
                        <div>
                            <div className="flex items-center justify-between mb-1.5">
                                <Label htmlFor="ec-phone">Phone Number</Label>
                                {!showSecondary && (
                                    <button
                                        type="button"
                                        onClick={() => setShowSecondary(true)}
                                        className="text-xs text-primary hover:underline"
                                    >
                                        + Secondary Phone
                                    </button>
                                )}
                            </div>
                            <PhoneInput
                                id="ec-phone"
                                value={formData.phone_e164}
                                onChange={(formatted) => setFormData({ ...formData, phone_e164: formatted })}
                            />
                        </div>
                        {showSecondary && (
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <Label htmlFor="ec-secondary-phone" className="mb-1.5">Secondary Phone</Label>
                                    <PhoneInput
                                        id="ec-secondary-phone"
                                        value={formData.secondary_phone}
                                        onChange={(formatted) => setFormData({ ...formData, secondary_phone: formatted })}
                                    />
                                </div>
                                <div>
                                    <Label htmlFor="ec-secondary-phone-name" className="mb-1.5">Secondary Name</Label>
                                    <Input
                                        id="ec-secondary-phone-name"
                                        value={formData.secondary_phone_name}
                                        onChange={(e) => setFormData({ ...formData, secondary_phone_name: e.target.value })}
                                        placeholder="e.g. Tenant, Wife"
                                    />
                                </div>
                            </div>
                        )}
                        <div>
                            <Label htmlFor="ec-email" className="mb-1.5">Email</Label>
                            <Input
                                id="ec-email"
                                type="email"
                                value={formData.email}
                                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                                placeholder="email@example.com"
                            />
                        </div>
                    </div>

                    {/* Notes */}
                    <div className="space-y-3">
                        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
                            Notes
                        </h3>
                        <Textarea
                            id="ec-notes"
                            value={formData.notes}
                            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                            rows={3}
                            className="min-h-[60px] resize-y"
                            placeholder="Notes..."
                        />
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                            disabled={loading}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={loading}>
                            {loading ? 'Saving...' : 'Save Changes'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
