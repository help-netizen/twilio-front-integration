import type { Lead } from '../../types/lead';

export interface QuickMessage { id: string; title: string; content: string; sort_order: number; }

/** A composer destination: an SMS phone or a contact email. */
export type MessageChannel = 'sms' | 'email';
export interface MessageTarget {
    channel: MessageChannel;
    value: string; // phone (E.164) or email address
    label: string; // human label shown in the dropdown
}

export interface SmsFormProps {
    onSend: (message: string, files: File[] | undefined, target: { channel: MessageChannel; value: string }) => void;
    onAiFormat?: (message: string) => Promise<string>;
    disabled?: boolean;
    lead?: Lead | null;
    mainPhone?: string;
    secondaryPhone?: string;
    secondaryPhoneName?: string;
    /** Contact email addresses (channel = 'email'). First entry is the primary. */
    emails?: string[];
    /** True when the company Gmail mailbox is connected; false → email is a connect-CTA only. */
    emailConnected?: boolean;
    /** Currently selected target (phone or email). */
    selectedTarget?: MessageTarget;
    onTargetChange?: (target: MessageTarget) => void;
}

/**
 * Build the ordered target list for the composer: main phone, optional secondary
 * phone, then each contact email. Phones come first (SMS is the default channel).
 */
export function buildMessageTargets(
    mainPhone: string | undefined,
    secondaryPhone: string | undefined,
    secondaryPhoneName: string | undefined,
    emails: string[] | undefined,
): MessageTarget[] {
    const targets: MessageTarget[] = [];
    if (mainPhone) targets.push({ channel: 'sms', value: mainPhone, label: `${formatDisplayPhone(mainPhone)} — Main number` });
    const mainD = (mainPhone || '').replace(/\D/g, '');
    const secD = (secondaryPhone || '').replace(/\D/g, '');
    if (secondaryPhone && secD && secD !== mainD) {
        targets.push({ channel: 'sms', value: secondaryPhone, label: `${formatDisplayPhone(secondaryPhone)}${secondaryPhoneName ? ` — ${secondaryPhoneName}` : ''}` });
    }
    const seenEmails = new Set<string>();
    for (const raw of emails || []) {
        const email = (raw || '').trim();
        if (!email) continue;
        const key = email.toLowerCase();
        if (seenEmails.has(key)) continue;
        seenEmails.add(key);
        targets.push({ channel: 'email', value: email, label: email });
    }
    return targets;
}

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function formatDisplayPhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    return phone;
}

const CORE_FIELD_MAP: Record<string, keyof Lead> = {
    'First Name': 'FirstName', 'Last Name': 'LastName', 'Phone': 'Phone', 'Email': 'Email',
    'Company': 'Company', 'Address': 'Address', 'City': 'City', 'State': 'State',
    'Postal Code': 'PostalCode', 'Job Type': 'JobType', 'Job Source': 'JobSource',
    'Description': 'Description', 'Created Date': 'CreatedDate',
};

export function resolveVariables(text: string, lead: Lead | null | undefined): string {
    if (!lead) return text;
    return text.replace(/\{([^}]+)\}/g, (_match, fieldName: string) => {
        const trimmed = fieldName.trim();
        const coreKey = CORE_FIELD_MAP[trimmed];
        if (coreKey) { const val = lead[coreKey]; if (val != null && String(val).trim() !== '') return String(val); return `{${trimmed}}`; }
        const metaVal = lead.Metadata?.[trimmed];
        if (metaVal != null && metaVal.trim() !== '') return metaVal;
        return `{${trimmed}}`;
    });
}
