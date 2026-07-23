/**
 * OB-34 harness — renders the REAL TemplateLivePreview at a phone-sheet width
 * (380px) and a desktop width (800px) side by side, with the owner's broken
 * configuration: logo + header + document_meta glued into one row. No backend.
 *
 * Run:  slot-harness config (npx vite in frontend/)  →  /template-preview-harness.html
 * Expectation: at 380px the three header sections STACK (no collision, no
 * clipped giant number, everything readable); at 800px the original one-row
 * layout is unchanged. Logo renders from brand.logo_url.
 */
import { createRoot } from 'react-dom/client';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { TemplateLivePreview } from '../components/documents/TemplateLivePreview';
import type { TemplateDescriptorV1 } from '../types/documentTemplates';

const LOGO_SVG = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" rx="16" fill="#7F42E1"/><text x="60" y="72" font-family="sans-serif" font-size="40" fill="#fff" text-anchor="middle">AH</text></svg>'
);

const descriptor: TemplateDescriptorV1 = {
    schema_version: 1,
    layout_preset: 'light',
    brand: {
        name: 'ABC Homes',
        address: '2502 Village Rd W, Norwood, MA 02062',
        email: 'help@bostonmasters.com',
        phone: '(508) 290-4442',
        logo_url: `data:image/svg+xml,${LOGO_SVG}`,
        ach: { bank: 'Bank Of America', routing_number: '011000138', account_number: '466020155621' },
    },
    theme: { accent: '#2563eb', muted: '#5f7085', ink: '#172033', surface: '#fbfcfe', border: '#d8e0ea' },
    sections: [
        { key: 'logo', visible: true, width: 'third', glue_with_next: true },
        { key: 'header', visible: true, width: 'half', glue_with_next: true },
        { key: 'document_meta', visible: true, width: 'third', text_align: 'right' },
        { key: 'ach', visible: true, width: 'full' },
        { key: 'client_addresses', visible: true, width: 'full' },
        { key: 'summary', visible: true, width: 'full' },
        { key: 'items', visible: true, width: 'full' },
        { key: 'totals', visible: true, width: 'full' },
    ],
    footer: { show_page_number: true },
};

function Harness() {
    return (
        <div style={{ display: 'flex', gap: 24, padding: 24, alignItems: 'flex-start', background: 'var(--blanc-bg)', minHeight: '100vh', overflowX: 'auto' }}>
            <div style={{ width: 380, flex: 'none' }} data-testid="narrow">
                <div style={{ font: '12px monospace', marginBottom: 8 }}>380px (мобильная шторка)</div>
                <TemplateLivePreview descriptor={descriptor} />
            </div>
            <div style={{ width: 800, flex: 'none' }} data-testid="wide">
                <div style={{ font: '12px monospace', marginBottom: 8 }}>800px (десктоп)</div>
                <TemplateLivePreview descriptor={descriptor} />
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
