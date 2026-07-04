import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
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

type EmailRow = { email: string; is_primary: boolean };

// Basic email shape (mirrors the backend's normalize/validate gate).
const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/**
 * Build the initial email rows from a contact (CONTACT-EMAIL-MERGE-001): prefer the
 * richer `emails` shape if the backend surfaced it, else the primary-first `contact_emails`
 * string[], else fall back to the scalar `email`. Always primary-first with exactly one primary.
 */
function initEmailRows(contact: Contact): EmailRow[] {
    const primary = (contact.email || '').trim();

    if (contact.emails && contact.emails.length > 0) {
        const seen = new Set<string>();
        const rows: EmailRow[] = [];
        for (const e of contact.emails) {
            const email = (e.email || '').trim();
            if (!email) continue;
            const key = email.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push({ email, is_primary: !!e.is_primary });
        }
        if (rows.length > 0) {
            if (!rows.some((r) => r.is_primary)) rows[0].is_primary = true;
            return sortPrimaryFirst(rows);
        }
    }

    const rows: EmailRow[] = [];
    const seen = new Set<string>();
    const push = (email: string, is_primary: boolean) => {
        const trimmed = email.trim();
        if (!trimmed) return;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({ email: trimmed, is_primary });
    };
    if (primary) push(primary, true);
    for (const email of contact.contact_emails || []) push(email, false);

    if (rows.length === 0) return [{ email: '', is_primary: true }];
    if (!rows.some((r) => r.is_primary)) rows[0].is_primary = true;
    return sortPrimaryFirst(rows);
}

function sortPrimaryFirst(rows: EmailRow[]): EmailRow[] {
    return [...rows].sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
}

export function EditContactDialog({ contact, open, onOpenChange, onSuccess }: EditContactDialogProps) {
    const [loading, setLoading] = useState(false);
    const [showSecondary, setShowSecondary] = useState(false);
    const [emails, setEmails] = useState<EmailRow[]>([{ email: '', is_primary: true }]);
    const [formData, setFormData] = useState({
        first_name: '',
        last_name: '',
        company_name: '',
        phone_e164: '',
        secondary_phone: '',
        secondary_phone_name: '',
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
                notes: contact.notes || '',
            });
            setEmails(initEmailRows(contact));
            setShowSecondary(!!(contact.secondary_phone || contact.secondary_phone_name));
        }
    }, [open, contact]);

    const updateEmail = (index: number, value: string) => {
        setEmails((prev) => prev.map((row, i) => (i === index ? { ...row, email: value } : row)));
    };

    const setPrimaryEmail = (index: number) => {
        setEmails((prev) => prev.map((row, i) => ({ ...row, is_primary: i === index })));
    };

    const addEmailRow = () => {
        setEmails((prev) => [...prev, { email: '', is_primary: prev.length === 0 }]);
    };

    const removeEmailRow = (index: number) => {
        setEmails((prev) => {
            const next = prev.filter((_, i) => i !== index);
            if (next.length === 0) return [{ email: '', is_primary: true }];
            // Removing the primary promotes the first remaining row.
            if (!next.some((r) => r.is_primary)) next[0] = { ...next[0], is_primary: true };
            return next;
        });
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        // Block Save on any non-empty-but-malformed row; empty rows are dropped silently.
        if (emails.some((r) => r.email.trim() && !isValidEmail(r.email))) {
            toast.error('Please enter a valid email address');
            return;
        }

        // Normalize + de-dupe (case-insensitive), keep display value, drop blanks.
        const seen = new Set<string>();
        const cleaned: EmailRow[] = [];
        for (const row of emails) {
            const email = row.email.trim();
            if (!email) continue;
            const key = email.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            cleaned.push({ email, is_primary: row.is_primary });
        }
        // Guarantee exactly one primary (first flagged wins; else first entry).
        let primaryFixed = false;
        const emailsPayload = cleaned.map((row) => {
            const is_primary = row.is_primary && !primaryFixed;
            if (is_primary) primaryFixed = true;
            return { email: row.email, is_primary };
        });
        if (!primaryFixed && emailsPayload.length > 0) emailsPayload[0].is_primary = true;
        const primaryEmail = emailsPayload.find((r) => r.is_primary)?.email ?? '';

        setLoading(true);
        try {
            await contactsApi.updateContact(contact.id, {
                first_name: formData.first_name,
                last_name: formData.last_name,
                company_name: formData.company_name,
                phone_e164: formData.phone_e164 ? toE164(formData.phone_e164) : '',
                secondary_phone: formData.secondary_phone ? toE164(formData.secondary_phone) : '',
                secondary_phone_name: formData.secondary_phone_name,
                email: primaryEmail,
                emails: emailsPayload,
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
                            {/* Emails: primary + additional (CONTACT-EMAIL-MERGE-001) */}
                            <div className="space-y-3.5">
                                {emails.map((row, index) => (
                                    <div key={index} className="space-y-1.5">
                                        <div className="flex items-center gap-2">
                                            <FloatingField
                                                id={`ec-email-${index}`}
                                                label={row.is_primary ? 'Email (primary)' : 'Email'}
                                                type="email"
                                                containerClassName="flex-1"
                                                value={row.email}
                                                onChange={(e) => updateEmail(index, e.target.value)}
                                            />
                                            {!row.is_primary && (
                                                <button
                                                    type="button"
                                                    onClick={() => removeEmailRow(index)}
                                                    aria-label="Remove email"
                                                    className="shrink-0 rounded-lg p-2 text-[var(--blanc-ink-3)] transition-colors hover:text-[var(--blanc-ink-1)]"
                                                >
                                                    <X className="h-4 w-4" />
                                                </button>
                                            )}
                                        </div>
                                        {!row.is_primary && row.email.trim() && (
                                            <button
                                                type="button"
                                                onClick={() => setPrimaryEmail(index)}
                                                className="text-xs text-primary hover:underline"
                                            >
                                                Set as primary
                                            </button>
                                        )}
                                    </div>
                                ))}
                                <button
                                    type="button"
                                    onClick={addEmailRow}
                                    className="text-xs text-primary hover:underline"
                                >
                                    + Add email
                                </button>
                            </div>
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
