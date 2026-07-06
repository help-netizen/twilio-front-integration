import { Mail, Phone } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { formatUSPhone } from '../ui/PhoneInput';
import type {
    ContactConflict,
    ContactConflictAttribute,
    ContactConflictParty,
    ContactConflictResolution,
} from '../../types/contact';

/**
 * CONTACT-MERGE-001 — confirmation dialog for "this phone/email already belongs
 * to another contact". Center modal (`variant="dialog"` — confirm class, NOT an
 * entity editor; renders as a BottomSheet on mobile automatically per
 * OVERLAY-CANON-002). One dialog per OWNER: several conflicting attributes of
 * the same owner arrive as one `conflict` entry. Escape / backdrop / corner ×
 * all route through Radix `onOpenChange(false)` → `onCancel`.
 *
 * v1: no inputs, no attribute picker — the three literal actions only.
 */
export interface MergeContactsDialogProps {
    /** The conflict currently shown; null = closed. */
    conflict: ContactConflict | null;
    /** User picked Merge contacts / Transfer — covers the owner's WHOLE attribute set of this dialog. */
    onConfirm: (action: ContactConflictResolution['action']) => void;
    /** Cancel / Escape / backdrop — aborts the whole Save (FR-7). */
    onCancel: () => void;
}

const digitsOf = (value: string) => value.replace(/\D/g, '');

/** Digit-match a stored phone against the conflicting attributes (full or last-10 legs). */
function phoneIsConflicting(value: string, attributes: ContactConflictAttribute[]): boolean {
    const digits = digitsOf(value);
    if (!digits) return false;
    return attributes.some((attr) => {
        if (attr.kind !== 'phone') return false;
        const attrDigits = digitsOf(attr.normalized || attr.value);
        if (!attrDigits) return false;
        if (attrDigits === digits) return true;
        return attrDigits.length >= 10 && digits.length >= 10 && attrDigits.slice(-10) === digits.slice(-10);
    });
}

/** Case-insensitive match of a stored email against the conflicting attributes. */
function emailIsConflicting(email: string, attributes: ContactConflictAttribute[]): boolean {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return false;
    return attributes.some(
        (attr) => attr.kind === 'email' && (attr.normalized || attr.value).trim().toLowerCase() === normalized
    );
}

/** One phone/email row: small type icon + value; conflicting rows carry weight + ink-1. */
function AttributeRow({
    icon: Icon,
    text,
    conflicting,
}: {
    icon: typeof Phone;
    text: string;
    conflicting: boolean;
}) {
    return (
        <div className="flex min-w-0 items-center gap-2">
            <Icon className="size-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
            <span
                className={conflicting ? 'truncate text-sm font-semibold' : 'truncate text-sm'}
                style={{ color: conflicting ? 'var(--blanc-ink-1)' : 'var(--blanc-ink-3)' }}
            >
                {text}
            </span>
        </div>
    );
}

/** One side of the two-column comparison: name + every existing phone/email (no empty rows). */
function ContactColumn({
    title,
    party,
    attributes,
}: {
    title: string;
    party: ContactConflictParty;
    attributes: ContactConflictAttribute[];
}) {
    const name = party.full_name?.trim() || party.company_name?.trim() || 'Unnamed contact';
    const showCompany = Boolean(party.full_name?.trim() && party.company_name?.trim());
    const phones = party.phones.filter((p) => p.value && p.value.trim());
    const emails = party.emails.filter((e) => e.email && e.email.trim());

    return (
        <div className="min-w-0 space-y-2.5">
            <div>
                <span className="blanc-eyebrow">{title}</span>
                <div
                    className="mt-1 truncate text-[15px] font-semibold leading-snug"
                    style={{ color: 'var(--blanc-ink-1)' }}
                >
                    {name}
                </div>
                {showCompany && (
                    <div className="truncate text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                        {party.company_name}
                    </div>
                )}
            </div>
            {(phones.length > 0 || emails.length > 0) && (
                <div className="space-y-1.5">
                    {phones.map((phone) => (
                        <AttributeRow
                            key={`phone-${phone.slot}-${phone.value}`}
                            icon={Phone}
                            text={phone.label ? `${formatUSPhone(phone.value)} · ${phone.label}` : formatUSPhone(phone.value)}
                            conflicting={phoneIsConflicting(phone.value, attributes)}
                        />
                    ))}
                    {emails.map((email) => (
                        <AttributeRow
                            key={`email-${email.email}`}
                            icon={Mail}
                            text={email.email}
                            conflicting={emailIsConflicting(email.email, attributes)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export function MergeContactsDialog({ conflict, onConfirm, onCancel }: MergeContactsDialogProps) {
    if (!conflict) return null;

    const kinds = new Set(conflict.attributes.map((a) => a.kind));
    const transferLabel =
        kinds.size === 2 ? 'Transfer phone & email' : kinds.has('phone') ? 'Transfer phone' : 'Transfer email';
    const transferHint =
        kinds.size === 2
            ? 'Only this phone and email with their threads move; the contact stays.'
            : kinds.has('phone')
                ? 'Only this number and its thread move; the contact stays.'
                : 'Only this email and its thread move; the contact stays.';

    const attributeText = conflict.attributes
        .map((a) => (a.kind === 'phone' ? formatUSPhone(a.value) : a.value))
        .join(', ');
    const belongVerb = conflict.attributes.length > 1 ? 'belong' : 'belongs';

    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open) onCancel();
            }}
        >
            <DialogContent variant="dialog">
                <DialogHeader>
                    <DialogTitle
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Merge contacts?
                    </DialogTitle>
                    <DialogDescription className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                        {attributeText} already {belongVerb} to another contact.
                    </DialogDescription>
                </DialogHeader>

                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                    <ContactColumn title="Contact 1 · editing" party={conflict.editing} attributes={conflict.attributes} />
                    <ContactColumn title="Contact 2 · owner" party={conflict.owner} attributes={conflict.attributes} />
                </div>

                <div className="space-y-3 pt-1">
                    <div className="space-y-1">
                        <Button className="w-full" onClick={() => onConfirm('merge')}>
                            Merge contacts
                        </Button>
                        <p className="text-center text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                            Contact 2 will be deleted; all its history moves here.
                        </p>
                    </div>
                    {conflict.transfer_allowed ? (
                        <div className="space-y-1">
                            <Button variant="secondary" className="w-full" onClick={() => onConfirm('transfer')}>
                                {transferLabel}
                            </Button>
                            <p className="text-center text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                                {transferHint}
                            </p>
                        </div>
                    ) : (
                        <p className="text-center text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                            Transfer isn't available — Contact 2 would be left with no phone and no email.
                        </p>
                    )}
                    <Button variant="ghost" className="w-full" onClick={onCancel}>
                        Cancel
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
