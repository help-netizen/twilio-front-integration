import type { Lead } from '../../types/lead';

export interface QuickMessage { id: string; title: string; content: string; sort_order: number; }

export interface SmsFormProps {
    onSend: (message: string, files?: File[], targetPhone?: string) => void;
    onAiFormat?: (message: string) => Promise<string>;
    disabled?: boolean;
    lead?: Lead | null;
    mainPhone?: string;
    secondaryPhone?: string;
    secondaryPhoneName?: string;
    selectedPhone?: string;
    onPhoneChange?: (phone: string) => void;
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
