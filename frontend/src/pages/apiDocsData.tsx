import { useState } from 'react';
import { Badge } from '@/components/ui/badge';

// ─── Types ────────────────────────────────────────────────────────────────────
export interface Field { name: string; type: string; required?: boolean; description: string; }
export interface ErrorCode { code: string; http: number; description: string; }
export interface Endpoint { id: string; method: 'POST' | 'GET' | 'DELETE'; path: string; title: string; description: string; scope?: string; headers?: Field[]; body?: Field[]; query?: Field[]; response: string; errors?: ErrorCode[]; curl: string; }

// ─── Data ─────────────────────────────────────────────────────────────────────
export const ENDPOINTS: Endpoint[] = [
    {
        id: 'create-lead', method: 'POST', path: '/api/v1/integrations/leads', title: 'Create a Lead',
        description: 'Creates a new lead in the system. Requires the `leads:create` scope. At least one identifying field (FirstName, LastName, Phone, or Email) must be provided. Custom metadata fields configured in Lead Form Settings can be passed as top-level keys using their api_name (e.g. lead_note, custom_field_1).',
        scope: 'leads:create',
        headers: [
            { name: 'X-BLANC-API-KEY', type: 'string', required: true, description: 'Your API key (starts with blanc_)' },
            { name: 'X-BLANC-API-SECRET', type: 'string', required: true, description: 'Your API secret' },
            { name: 'Content-Type', type: 'string', required: true, description: 'Must be application/json' },
        ],
        body: [
            { name: 'FirstName', type: 'string', required: false, description: 'Contact first name' },
            { name: 'LastName', type: 'string', required: false, description: 'Contact last name' },
            { name: 'Phone', type: 'string', required: false, description: 'Primary phone number (E.164 format recommended)' },
            { name: 'PhoneExt', type: 'string', required: false, description: 'Primary phone extension' },
            { name: 'SecondPhone', type: 'string', required: false, description: 'Alternate phone number' },
            { name: 'SecondPhoneExt', type: 'string', required: false, description: 'Alternate phone extension' },
            { name: 'Email', type: 'string', required: false, description: 'Contact email address' },
            { name: 'Company', type: 'string', required: false, description: 'Company or business name' },
            { name: 'Address', type: 'string', required: false, description: 'Street address' },
            { name: 'Unit', type: 'string', required: false, description: 'Apartment / suite / unit' },
            { name: 'City', type: 'string', required: false, description: 'City' },
            { name: 'State', type: 'string', required: false, description: 'State or province' },
            { name: 'PostalCode', type: 'string', required: false, description: 'ZIP / postal code' },
            { name: 'Country', type: 'string', required: false, description: 'Country (ISO 3166-1)' },
            { name: 'Latitude', type: 'number', required: false, description: 'Latitude coordinate' },
            { name: 'Longitude', type: 'number', required: false, description: 'Longitude coordinate' },
            { name: 'JobType', type: 'string', required: false, description: 'Type of job / service requested' },
            { name: 'JobSource', type: 'string', required: false, description: 'Lead source (e.g. "Google Ads", "Website")' },
            { name: 'ReferralCompany', type: 'string', required: false, description: 'Referring company name' },
            { name: 'Timezone', type: 'string', required: false, description: 'Timezone (e.g. "America/New_York")' },
            { name: 'Description', type: 'string', required: false, description: 'Description of the problem / service needed' },
            { name: 'Comments', type: 'string', required: false, description: 'Customer-facing comments' },
            { name: 'Tags', type: 'string', required: false, description: 'Comma-separated tags' },
            { name: 'LeadDateTime', type: 'ISO 8601', required: false, description: 'Scheduled date/time for the lead' },
            { name: 'LeadEndDateTime', type: 'ISO 8601', required: false, description: 'End date/time for the lead window' },
            { name: 'Status', type: 'string', required: false, description: 'Lead status (default: "Submitted")' },
            { name: 'SubStatus', type: 'string', required: false, description: 'Sub-status for custom workflows' },
            { name: 'PaymentDueDate', type: 'ISO 8601', required: false, description: 'Payment due date' },
            { name: 'Metadata', type: 'object', required: false, description: 'Custom fields as key-value pairs: { "api_name": "value" }' },
            { name: '{custom_field}', type: 'string', required: false, description: 'Any custom field api_name (e.g. lead_note) can be passed as a top-level key' },
        ],
        response: `{\n  "success": true,\n  "lead_id": "4AB4IK",\n  "serial_id": 7,\n  "request_id": "490336c8-03ce-4d91-9c7a-2c71fd674031"\n}`,
        errors: [
            { code: 'AUTH_HEADERS_REQUIRED', http: 401, description: 'X-BLANC-API-KEY and/or X-BLANC-API-SECRET headers missing' },
            { code: 'AUTH_KEY_NOT_FOUND', http: 401, description: 'API key not found in the system' },
            { code: 'AUTH_KEY_REVOKED', http: 401, description: 'API key has been revoked' },
            { code: 'AUTH_KEY_EXPIRED', http: 401, description: 'API key has expired' },
            { code: 'AUTH_SECRET_INVALID', http: 401, description: 'Secret does not match' },
            { code: 'AUTH_LEGACY_REJECTED', http: 401, description: 'Legacy auth_secret in body is not accepted' },
            { code: 'SCOPE_INSUFFICIENT', http: 403, description: 'Integration does not have the required scope' },
            { code: 'PAYLOAD_INVALID', http: 400, description: 'Missing required fields or invalid data' },
            { code: 'RATE_LIMITED', http: 429, description: 'Too many requests — retry after the given window' },
        ],
        curl: `curl -X POST https://your-domain/api/v1/integrations/leads \\\\
  -H "Content-Type: application/json" \\\\
  -H "X-BLANC-API-KEY: blanc_abc123..." \\\\
  -H "X-BLANC-API-SECRET: your_secret_here" \\\\
  -d '{
    "FirstName": "John",
    "LastName": "Doe",
    "Phone": "+16195551234",
    "Email": "john@example.com",
    "Address": "123 Main St",
    "City": "San Diego",
    "State": "CA",
    "PostalCode": "92101",
    "JobType": "Plumbing",
    "JobSource": "Google Ads",
    "Description": "Urgent — water leak",
    "lead_note": "Custom field value",
    "one_more_text": "Another custom value"
  }'`,
    },
    {
        id: 'list-integrations', method: 'GET', path: '/api/admin/integrations', title: 'List Integrations',
        description: 'Returns all registered API integrations. Internal admin endpoint.', headers: [],
        response: `{\n  "success": true,\n  "integrations": [\n    {\n      "id": "1",\n      "client_name": "Service Direct",\n      "key_id": "blanc_e8055f58c35d...",\n      "scopes": ["leads:create"],\n      "created_at": "2026-02-10T02:49:54.606Z",\n      "expires_at": null,\n      "revoked_at": null,\n      "last_used_at": "2026-02-10T02:50:12.000Z"\n    }\n  ]\n}`,
        curl: `curl https://your-domain/api/admin/integrations`,
    },
    {
        id: 'create-integration', method: 'POST', path: '/api/admin/integrations', title: 'Create Integration',
        description: 'Registers a new API integration and generates credentials. The API secret is returned **once** in this response and is never stored in plaintext.',
        headers: [{ name: 'Content-Type', type: 'string', required: true, description: 'Must be application/json' }],
        body: [
            { name: 'client_name', type: 'string', required: true, description: 'Human-readable name for the integration' },
            { name: 'scopes', type: 'string[]', required: false, description: 'Permission scopes (default: ["leads:create"])' },
            { name: 'expires_at', type: 'ISO 8601', required: false, description: 'Expiration date (default: never)' },
        ],
        response: `{\n  "success": true,\n  "integration": {\n    "id": "2",\n    "client_name": "Service Direct",\n    "key_id": "blanc_a9571f66ee3e...",\n    "secret": "b8e7e3074e07e21b74da...",\n    "scopes": ["leads:create"],\n    "created_at": "2026-02-10T02:50:12.000Z",\n    "expires_at": null\n  }\n}`,
        errors: [{ code: 'VALIDATION', http: 400, description: 'client_name is required' }],
        curl: `curl -X POST https://your-domain/api/admin/integrations \\\\
  -H "Content-Type: application/json" \\\\
  -d '{"client_name": "Service Direct", "scopes": ["leads:create"]}'`,
    },
    {
        id: 'revoke-integration', method: 'DELETE', path: '/api/admin/integrations/:keyId', title: 'Revoke Integration',
        description: 'Permanently revokes an API integration. The key can no longer be used for authentication after this call.',
        headers: [],
        response: `{\n  "success": true,\n  "revoked": {\n    "key_id": "blanc_e8055f58c35d...",\n    "client_name": "Service Direct",\n    "revoked_at": "2026-02-10T03:15:00.000Z"\n  }\n}`,
        errors: [{ code: 'NOT_FOUND', http: 404, description: 'Integration with this key_id not found' }],
        curl: `curl -X DELETE https://your-domain/api/admin/integrations/blanc_e8055f58c35d`,
    },
];

// ─── Helper Components ────────────────────────────────────────────────────────
const METHOD_COLORS: Record<string, { bg: string; text: string; border: string }> = {
    GET: { bg: '#e8f5e9', text: '#2e7d32', border: '#a5d6a7' },
    POST: { bg: '#e3f2fd', text: '#1565c0', border: '#90caf9' },
    DELETE: { bg: '#fce4ec', text: '#c62828', border: '#ef9a9a' },
};

export function MethodBadge({ method }: { method: string }) {
    const c = METHOD_COLORS[method] || { bg: '#eee', text: '#333', border: '#ccc' };
    return <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: '4px', fontWeight: 700, fontSize: '12px', fontFamily: 'monospace', letterSpacing: '0.5px', background: c.bg, color: c.text, border: `1px solid ${c.border}` }}>{method}</span>;
}

export function CodeBlock({ code, lang = 'bash' }: { code: string; lang?: string }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = () => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); };
    return (
        <div style={{ position: 'relative', borderRadius: '8px', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 12px', background: '#1e1e1e', borderBottom: '1px solid #333', fontSize: '11px', color: '#999' }}>
                <span>{lang}</span>
                <button onClick={handleCopy} style={{ background: 'none', border: '1px solid #555', borderRadius: '4px', color: '#bbb', padding: '2px 8px', cursor: 'pointer', fontSize: '11px' }}>{copied ? '✓ Copied' : 'Copy'}</button>
            </div>
            <pre style={{ background: '#1e1e1e', color: '#d4d4d4', padding: '16px', margin: 0, fontSize: '13px', lineHeight: '1.6', overflowX: 'auto', fontFamily: '"Fira Code", "SF Mono", "Cascadia Code", Consolas, monospace' }}>{code}</pre>
        </div>
    );
}

export function FieldsTable({ fields, title }: { fields: Field[]; title: string }) {
    return (
        <div style={{ marginTop: '16px' }}>
            <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>{title}</h4>
            <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead><tr style={{ background: '#f9fafb' }}>
                        <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, color: '#374151' }}>Field</th>
                        <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, color: '#374151' }}>Type</th>
                        <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, color: '#374151' }}>Description</th>
                    </tr></thead>
                    <tbody>{fields.map((f, i) => (
                        <tr key={f.name} style={{ background: i % 2 === 0 ? '#fff' : '#fafbfc' }}>
                            <td style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'nowrap' }}>{f.name}{f.required && <span style={{ color: '#dc2626', marginLeft: '4px', fontSize: '10px', fontWeight: 700 }}>REQUIRED</span>}</td>
                            <td style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', color: '#6b7280' }}>{f.type}</td>
                            <td style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', color: '#374151' }}>{f.description}</td>
                        </tr>
                    ))}</tbody>
                </table>
            </div>
        </div>
    );
}

export function ErrorsTable({ errors }: { errors: ErrorCode[] }) {
    return (
        <div style={{ marginTop: '16px' }}>
            <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Error Codes</h4>
            <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead><tr style={{ background: '#f9fafb' }}>
                        <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, color: '#374151' }}>HTTP</th>
                        <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, color: '#374151' }}>Code</th>
                        <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, color: '#374151' }}>Description</th>
                    </tr></thead>
                    <tbody>{errors.map((e, i) => (
                        <tr key={e.code} style={{ background: i % 2 === 0 ? '#fff' : '#fafbfc' }}>
                            <td style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', fontFamily: 'monospace', fontWeight: 600, color: e.http >= 500 ? '#dc2626' : e.http >= 400 ? '#d97706' : '#059669' }}>{e.http}</td>
                            <td style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', fontFamily: 'monospace', fontSize: '12px' }}>{e.code}</td>
                            <td style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', color: '#374151' }}>{e.description}</td>
                        </tr>
                    ))}</tbody>
                </table>
            </div>
        </div>
    );
}
