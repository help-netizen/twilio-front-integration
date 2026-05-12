// F015: Document Templates — frontend types mirroring schema/v1.json

export type DocumentType = 'estimate' | 'invoice';

export type SectionKey =
    | 'logo'
    | 'header'
    | 'document_meta'
    | 'ach'
    | 'client_addresses'
    | 'summary'
    | 'items'
    | 'totals'
    | 'terms';

export interface BrandAch {
    bank?: string;
    routing_number?: string;
    account_number?: string;
}

export interface Brand {
    name: string;
    address: string;
    email: string;
    phone: string;
    logo_url?: string | null;
    ach?: BrandAch | null;
}

export interface Theme {
    ink?: string;
    muted?: string;
    faint?: string;
    surface?: string;
    border?: string;
    accent?: string;
    danger?: string;
}

export type SectionWidth = 'full' | 'two_thirds' | 'half' | 'third';
export type TextAlign = 'left' | 'center' | 'right';
export type LayoutPreset = 'light' | 'bold' | 'minimal';

export interface SectionDescriptor {
    key: SectionKey;
    visible: boolean;
    body_md?: string | null;
    width?: SectionWidth;
    text_align?: TextAlign;
    /** When true, this section sits flush against the next visible section (no grid gap, no width stretching). */
    glue_with_next?: boolean;
    /** When true, render section attributes inline on a single line (where supported, e.g. ACH). */
    inline?: boolean;
}

export interface FooterDescriptor {
    show_page_number?: boolean;
    text_md?: string | null;
}

export interface InvoiceSettings {
    /** Days from issue date to due date. Default 14 (Net 14). */
    default_due_days?: number;
}

export interface TemplateDescriptorV1 {
    schema_version: 1;
    layout_preset?: LayoutPreset;
    /** Font size scale, 0.7..1.6. Default 1.0 (100%). Applied as CSS `zoom` on the preview. */
    font_scale?: number;
    brand: Brand;
    theme: Theme;
    sections: SectionDescriptor[];
    footer: FooterDescriptor;
    /** Invoice-only document-level defaults. Ignored for non-invoice templates. */
    invoice_settings?: InvoiceSettings;
}

export interface DocumentTemplate {
    id: number;
    document_type: DocumentType;
    name: string;
    slug: string;
    is_default: boolean;
    schema_version: number;
    content: TemplateDescriptorV1;
    archived_at: string | null;
    created_at: string;
    updated_at: string;
}
