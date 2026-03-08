import type { JobTag } from '../services/jobsApi';

// ─── Types ──────────────────────────────────────────────────────────────────
export interface CustomField {
    id: number | null;
    display_name: string;
    api_name: string;
    field_type: string;
    is_system: boolean;
    is_searchable: boolean;
    sort_order: number;
}

export interface JobType {
    id: number | null;
    name: string;
    sort_order: number;
}

export const FIELD_TYPES = [
    { value: 'text', label: 'Text' },
    { value: 'textarea', label: 'Multiline Text' },
    { value: 'number', label: 'Number' },
    { value: 'file', label: 'File' },
    { value: 'richtext', label: 'Rich Text' },
];

export function toApiName(displayName: string): string {
    return displayName.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, '_');
}

// ─── Color Palette ──────────────────────────────────────────────────────────
export const TAG_PALETTE = [
    '#EF4444', '#FCA5A5', '#F97316', '#FDBA74',
    '#EAB308', '#FDE047', '#22C55E', '#86EFAC',
    '#14B8A6', '#5EEAD4', '#3B82F6', '#93C5FD',
    '#8B5CF6', '#C4B5FD', '#000000', '#FFFFFF',
];

export function getContrastText(hex: string): string {
    const c = hex.replace('#', '');
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#000' : '#fff';
}

export type { JobTag };
