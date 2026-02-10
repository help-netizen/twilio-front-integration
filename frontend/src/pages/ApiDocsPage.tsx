import { useState, useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Field {
    name: string;
    type: string;
    required?: boolean;
    description: string;
}

interface ErrorCode {
    code: string;
    http: number;
    description: string;
}

interface Endpoint {
    id: string;
    method: 'POST' | 'GET' | 'DELETE';
    path: string;
    title: string;
    description: string;
    scope?: string;
    headers?: Field[];
    body?: Field[];
    query?: Field[];
    response: string;
    errors?: ErrorCode[];
    curl: string;
}

// ─── Data ─────────────────────────────────────────────────────────────────────
const ENDPOINTS: Endpoint[] = [
    {
        id: 'create-lead',
        method: 'POST',
        path: '/api/v1/integrations/leads',
        title: 'Create a Lead',
        description: 'Creates a new lead in the system. Requires the `leads:create` scope. At least one identifying field (FirstName, LastName, Phone, or Email) must be provided.',
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
            { name: 'LeadNotes', type: 'string', required: false, description: 'Internal notes about the lead' },
            { name: 'Comments', type: 'string', required: false, description: 'Customer-facing comments' },
            { name: 'Tags', type: 'string', required: false, description: 'Comma-separated tags' },
            { name: 'LeadDateTime', type: 'ISO 8601', required: false, description: 'Scheduled date/time for the lead' },
            { name: 'LeadEndDateTime', type: 'ISO 8601', required: false, description: 'End date/time for the lead window' },
            { name: 'Status', type: 'string', required: false, description: 'Lead status (default: "Submitted")' },
            { name: 'SubStatus', type: 'string', required: false, description: 'Sub-status for custom workflows' },
            { name: 'PaymentDueDate', type: 'ISO 8601', required: false, description: 'Payment due date' },
        ],
        response: `{
  "success": true,
  "lead_id": "4AB4IK",
  "serial_id": 7,
  "request_id": "490336c8-03ce-4d91-9c7a-2c71fd674031"
}`,
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
        curl: `curl -X POST https://your-domain/api/v1/integrations/leads \\
  -H "Content-Type: application/json" \\
  -H "X-BLANC-API-KEY: blanc_abc123..." \\
  -H "X-BLANC-API-SECRET: your_secret_here" \\
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
    "LeadNotes": "Urgent — water leak"
  }'`,
    },
    {
        id: 'list-integrations',
        method: 'GET',
        path: '/api/admin/integrations',
        title: 'List Integrations',
        description: 'Returns all registered API integrations. Internal admin endpoint.',
        headers: [],
        response: `{
  "success": true,
  "integrations": [
    {
      "id": "1",
      "client_name": "Service Direct",
      "key_id": "blanc_e8055f58c35d...",
      "scopes": ["leads:create"],
      "created_at": "2026-02-10T02:49:54.606Z",
      "expires_at": null,
      "revoked_at": null,
      "last_used_at": "2026-02-10T02:50:12.000Z"
    }
  ]
}`,
        curl: `curl https://your-domain/api/admin/integrations`,
    },
    {
        id: 'create-integration',
        method: 'POST',
        path: '/api/admin/integrations',
        title: 'Create Integration',
        description: 'Registers a new API integration and generates credentials. The API secret is returned **once** in this response and is never stored in plaintext.',
        headers: [
            { name: 'Content-Type', type: 'string', required: true, description: 'Must be application/json' },
        ],
        body: [
            { name: 'client_name', type: 'string', required: true, description: 'Human-readable name for the integration' },
            { name: 'scopes', type: 'string[]', required: false, description: 'Permission scopes (default: ["leads:create"])' },
            { name: 'expires_at', type: 'ISO 8601', required: false, description: 'Expiration date (default: never)' },
        ],
        response: `{
  "success": true,
  "integration": {
    "id": "2",
    "client_name": "Service Direct",
    "key_id": "blanc_a9571f66ee3e...",
    "secret": "b8e7e3074e07e21b74da...",
    "scopes": ["leads:create"],
    "created_at": "2026-02-10T02:50:12.000Z",
    "expires_at": null
  }
}`,
        errors: [
            { code: 'VALIDATION', http: 400, description: 'client_name is required' },
        ],
        curl: `curl -X POST https://your-domain/api/admin/integrations \\
  -H "Content-Type: application/json" \\
  -d '{"client_name": "Service Direct", "scopes": ["leads:create"]}'`,
    },
    {
        id: 'revoke-integration',
        method: 'DELETE',
        path: '/api/admin/integrations/:keyId',
        title: 'Revoke Integration',
        description: 'Permanently revokes an API integration. The key can no longer be used for authentication after this call.',
        headers: [],
        response: `{
  "success": true,
  "revoked": {
    "key_id": "blanc_e8055f58c35d...",
    "client_name": "Service Direct",
    "revoked_at": "2026-02-10T03:15:00.000Z"
  }
}`,
        errors: [
            { code: 'NOT_FOUND', http: 404, description: 'Integration with this key_id not found' },
        ],
        curl: `curl -X DELETE https://your-domain/api/admin/integrations/blanc_e8055f58c35d`,
    },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const METHOD_COLORS: Record<string, { bg: string; text: string; border: string }> = {
    GET: { bg: '#e8f5e9', text: '#2e7d32', border: '#a5d6a7' },
    POST: { bg: '#e3f2fd', text: '#1565c0', border: '#90caf9' },
    DELETE: { bg: '#fce4ec', text: '#c62828', border: '#ef9a9a' },
};

function MethodBadge({ method }: { method: string }) {
    const c = METHOD_COLORS[method] || { bg: '#eee', text: '#333', border: '#ccc' };
    return (
        <span
            style={{
                display: 'inline-block',
                padding: '2px 10px',
                borderRadius: '4px',
                fontWeight: 700,
                fontSize: '12px',
                fontFamily: 'monospace',
                letterSpacing: '0.5px',
                background: c.bg,
                color: c.text,
                border: `1px solid ${c.border}`,
            }}
        >
            {method}
        </span>
    );
}

function CodeBlock({ code, lang = 'bash' }: { code: string; lang?: string }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = () => {
        navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };
    return (
        <div style={{ position: 'relative', borderRadius: '8px', overflow: 'hidden' }}>
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '6px 12px',
                    background: '#1e1e1e',
                    borderBottom: '1px solid #333',
                    fontSize: '11px',
                    color: '#999',
                }}
            >
                <span>{lang}</span>
                <button
                    onClick={handleCopy}
                    style={{
                        background: 'none',
                        border: '1px solid #555',
                        borderRadius: '4px',
                        color: '#bbb',
                        padding: '2px 8px',
                        cursor: 'pointer',
                        fontSize: '11px',
                    }}
                >
                    {copied ? '✓ Copied' : 'Copy'}
                </button>
            </div>
            <pre
                style={{
                    background: '#1e1e1e',
                    color: '#d4d4d4',
                    padding: '16px',
                    margin: 0,
                    fontSize: '13px',
                    lineHeight: '1.6',
                    overflowX: 'auto',
                    fontFamily: '"Fira Code", "SF Mono", "Cascadia Code", Consolas, monospace',
                }}
            >
                {code}
            </pre>
        </div>
    );
}

function FieldsTable({ fields, title }: { fields: Field[]; title: string }) {
    return (
        <div style={{ marginTop: '16px' }}>
            <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                {title}
            </h4>
            <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                        <tr style={{ background: '#f9fafb' }}>
                            <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, color: '#374151' }}>Field</th>
                            <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, color: '#374151' }}>Type</th>
                            <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, color: '#374151' }}>Description</th>
                        </tr>
                    </thead>
                    <tbody>
                        {fields.map((f, i) => (
                            <tr key={f.name} style={{ background: i % 2 === 0 ? '#fff' : '#fafbfc' }}>
                                <td style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'nowrap' }}>
                                    {f.name}
                                    {f.required && (
                                        <span style={{ color: '#dc2626', marginLeft: '4px', fontSize: '10px', fontWeight: 700 }}>REQUIRED</span>
                                    )}
                                </td>
                                <td style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', color: '#6b7280' }}>{f.type}</td>
                                <td style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', color: '#374151' }}>{f.description}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function ErrorsTable({ errors }: { errors: ErrorCode[] }) {
    return (
        <div style={{ marginTop: '16px' }}>
            <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                Error Codes
            </h4>
            <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                        <tr style={{ background: '#f9fafb' }}>
                            <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, color: '#374151' }}>HTTP</th>
                            <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, color: '#374151' }}>Code</th>
                            <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, color: '#374151' }}>Description</th>
                        </tr>
                    </thead>
                    <tbody>
                        {errors.map((e, i) => (
                            <tr key={e.code} style={{ background: i % 2 === 0 ? '#fff' : '#fafbfc' }}>
                                <td style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', fontFamily: 'monospace', fontWeight: 600, color: e.http >= 500 ? '#dc2626' : e.http >= 400 ? '#d97706' : '#059669' }}>{e.http}</td>
                                <td style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', fontFamily: 'monospace', fontSize: '12px' }}>{e.code}</td>
                                <td style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', color: '#374151' }}>{e.description}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function ApiDocsPage() {
    const [activeEndpoint, setActiveEndpoint] = useState(ENDPOINTS[0].id);
    const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

    // Scroll-spy
    useEffect(() => {
        const handleScroll = () => {
            const container = document.getElementById('docs-content');
            if (!container) return;
            const scrollTop = container.scrollTop + 100;
            for (const ep of ENDPOINTS) {
                const el = sectionRefs.current[ep.id];
                if (el && el.offsetTop <= scrollTop) {
                    setActiveEndpoint(ep.id);
                }
            }
        };
        const container = document.getElementById('docs-content');
        container?.addEventListener('scroll', handleScroll);
        return () => container?.removeEventListener('scroll', handleScroll);
    }, []);

    const scrollTo = (id: string) => {
        sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActiveEndpoint(id);
    };

    return (
        <div style={{ display: 'flex', height: '100vh', background: '#fff' }}>
            {/* ─── Sidebar ─── */}
            <aside
                style={{
                    width: '260px',
                    minWidth: '260px',
                    borderRight: '1px solid #e5e7eb',
                    background: '#fafbfc',
                    overflowY: 'auto',
                    padding: '24px 0',
                }}
            >
                <div style={{ padding: '0 20px', marginBottom: '24px' }}>
                    <h2 style={{ fontSize: '16px', fontWeight: 700, color: '#111', margin: 0 }}>BLANC API</h2>
                    <p style={{ fontSize: '12px', color: '#888', margin: '4px 0 0' }}>Developer Reference</p>
                </div>

                {/* Auth section */}
                <div style={{ padding: '0 20px', marginBottom: '16px' }}>
                    <button
                        onClick={() => scrollTo('authentication')}
                        style={{
                            display: 'block',
                            width: '100%',
                            textAlign: 'left',
                            padding: '6px 8px',
                            borderRadius: '6px',
                            border: 'none',
                            background: activeEndpoint === 'authentication' ? '#e8eaed' : 'transparent',
                            cursor: 'pointer',
                            fontSize: '13px',
                            fontWeight: 600,
                            color: '#374151',
                        }}
                    >
                        🔐 Authentication
                    </button>
                    <button
                        onClick={() => scrollTo('rate-limiting')}
                        style={{
                            display: 'block',
                            width: '100%',
                            textAlign: 'left',
                            padding: '6px 8px',
                            borderRadius: '6px',
                            border: 'none',
                            background: activeEndpoint === 'rate-limiting' ? '#e8eaed' : 'transparent',
                            cursor: 'pointer',
                            fontSize: '13px',
                            fontWeight: 600,
                            color: '#374151',
                        }}
                    >
                        ⏱ Rate Limiting
                    </button>
                </div>

                <div style={{ padding: '0 20px', marginBottom: '8px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '1px' }}>
                        Endpoints
                    </span>
                </div>

                {ENDPOINTS.map((ep) => (
                    <button
                        key={ep.id}
                        onClick={() => scrollTo(ep.id)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            width: '100%',
                            textAlign: 'left',
                            padding: '7px 20px',
                            border: 'none',
                            background: activeEndpoint === ep.id ? '#e8eaed' : 'transparent',
                            cursor: 'pointer',
                            fontSize: '13px',
                            color: activeEndpoint === ep.id ? '#111' : '#555',
                            fontWeight: activeEndpoint === ep.id ? 600 : 400,
                            transition: 'all 0.15s',
                        }}
                    >
                        <MethodBadge method={ep.method} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {ep.title}
                        </span>
                    </button>
                ))}
            </aside>

            {/* ─── Content ─── */}
            <main
                id="docs-content"
                style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: '32px 48px 80px',
                }}
            >
                {/* ─── Intro ─── */}
                <div style={{ maxWidth: '900px' }}>
                    <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#111', margin: '0 0 8px' }}>
                        BLANC API Reference
                    </h1>
                    <p style={{ fontSize: '15px', color: '#666', lineHeight: '1.6', margin: '0 0 32px' }}>
                        Integrate with Blanc to create and manage leads programmatically. All endpoints return JSON responses with a consistent structure.
                    </p>

                    {/* ─── Authentication ─── */}
                    <section
                        ref={(el) => { sectionRefs.current['authentication'] = el; }}
                        id="authentication"
                        style={{ marginBottom: '48px', scrollMarginTop: '24px' }}
                    >
                        <h2 style={{ fontSize: '22px', fontWeight: 700, color: '#111', margin: '0 0 12px', paddingBottom: '8px', borderBottom: '2px solid #e5e7eb' }}>
                            🔐 Authentication
                        </h2>
                        <p style={{ fontSize: '14px', color: '#555', lineHeight: '1.7', margin: '0 0 16px' }}>
                            All external API requests are authenticated using an <strong>API Key</strong> and <strong>API Secret</strong> sent as HTTP headers.
                            Credentials are generated in <a href="/settings/integrations" style={{ color: '#2563eb', textDecoration: 'underline' }}>Settings → Integrations</a>.
                        </p>
                        <div style={{ background: '#f0f7ff', border: '1px solid #bfdbfe', borderRadius: '8px', padding: '16px', marginBottom: '16px' }}>
                            <p style={{ fontSize: '13px', color: '#1e40af', margin: 0, fontWeight: 500 }}>
                                ⚠️ The API secret is shown <strong>only once</strong> at creation time. Store it securely.
                                Secrets are hashed server-side and cannot be recovered.
                            </p>
                        </div>
                        <CodeBlock lang="http" code={`POST /api/v1/integrations/leads HTTP/1.1
Host: your-domain.com
Content-Type: application/json
X-BLANC-API-KEY: blanc_abc123def456...
X-BLANC-API-SECRET: your_secret_here`} />

                        <div style={{ marginTop: '16px', padding: '12px 16px', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: '8px' }}>
                            <p style={{ fontSize: '13px', color: '#92400e', margin: 0 }}>
                                <strong>Legacy auth rejected:</strong> Sending <code style={{ background: '#fde68a', padding: '1px 4px', borderRadius: '2px' }}>auth_secret</code> in the request body or{' '}
                                <code style={{ background: '#fde68a', padding: '1px 4px', borderRadius: '2px' }}>api_key</code> in query params will return <code>401 AUTH_LEGACY_REJECTED</code>.
                            </p>
                        </div>
                    </section>

                    {/* ─── Rate Limiting ─── */}
                    <section
                        ref={(el) => { sectionRefs.current['rate-limiting'] = el; }}
                        id="rate-limiting"
                        style={{ marginBottom: '48px', scrollMarginTop: '24px' }}
                    >
                        <h2 style={{ fontSize: '22px', fontWeight: 700, color: '#111', margin: '0 0 12px', paddingBottom: '8px', borderBottom: '2px solid #e5e7eb' }}>
                            ⏱ Rate Limiting
                        </h2>
                        <p style={{ fontSize: '14px', color: '#555', lineHeight: '1.7', margin: '0 0 16px' }}>
                            Requests are rate-limited per API key and per IP address using a sliding window.
                        </p>
                        <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                                <thead>
                                    <tr style={{ background: '#f9fafb' }}>
                                        <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600 }}>Scope</th>
                                        <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600 }}>Limit</th>
                                        <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600 }}>Window</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr>
                                        <td style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0' }}>Per API Key</td>
                                        <td style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', fontFamily: 'monospace' }}>60 requests</td>
                                        <td style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0' }}>60 seconds</td>
                                    </tr>
                                    <tr style={{ background: '#fafbfc' }}>
                                        <td style={{ padding: '8px 12px' }}>Per IP Address</td>
                                        <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>120 requests</td>
                                        <td style={{ padding: '8px 12px' }}>60 seconds</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        <p style={{ fontSize: '13px', color: '#888', marginTop: '12px' }}>
                            When rate-limited, the API returns <code style={{ background: '#f3f4f6', padding: '1px 4px', borderRadius: '2px' }}>429 Too Many Requests</code> with a <code style={{ background: '#f3f4f6', padding: '1px 4px', borderRadius: '2px' }}>Retry-After</code> header.
                        </p>
                    </section>

                    {/* ─── Endpoints ─── */}
                    {ENDPOINTS.map((ep) => (
                        <section
                            key={ep.id}
                            ref={(el) => { sectionRefs.current[ep.id] = el; }}
                            id={ep.id}
                            style={{ marginBottom: '56px', scrollMarginTop: '24px' }}
                        >
                            {/* Title bar */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px' }}>
                                <MethodBadge method={ep.method} />
                                <h2 style={{ fontSize: '22px', fontWeight: 700, color: '#111', margin: 0 }}>
                                    {ep.title}
                                </h2>
                            </div>

                            {/* Path */}
                            <div
                                style={{
                                    display: 'inline-block',
                                    padding: '4px 12px',
                                    borderRadius: '6px',
                                    background: '#f3f4f6',
                                    fontFamily: 'monospace',
                                    fontSize: '13px',
                                    color: '#374151',
                                    marginBottom: '12px',
                                }}
                            >
                                {ep.path}
                            </div>

                            {/* Description */}
                            <p style={{ fontSize: '14px', color: '#555', lineHeight: '1.7', margin: '0 0 16px' }}>
                                {ep.description}
                            </p>

                            {/* Scope badge */}
                            {ep.scope && (
                                <div style={{ marginBottom: '16px' }}>
                                    <span style={{ fontSize: '12px', color: '#888', marginRight: '8px' }}>Required scope:</span>
                                    <Badge variant="outline">{ep.scope}</Badge>
                                </div>
                            )}

                            {/* Two-column layout: params + code */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
                                {/* Left — parameters */}
                                <div>
                                    {ep.headers && <FieldsTable fields={ep.headers} title="Headers" />}
                                    {ep.body && <FieldsTable fields={ep.body} title="Body Parameters" />}
                                    {ep.query && <FieldsTable fields={ep.query} title="Query Parameters" />}
                                    {ep.errors && ep.errors.length > 0 && <ErrorsTable errors={ep.errors} />}
                                </div>

                                {/* Right — code examples */}
                                <div>
                                    <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px', marginTop: '16px' }}>
                                        Example Request
                                    </h4>
                                    <CodeBlock code={ep.curl} lang="bash" />

                                    <h4 style={{ fontSize: '13px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px', marginTop: '24px' }}>
                                        Response
                                    </h4>
                                    <CodeBlock code={ep.response} lang="json" />
                                </div>
                            </div>
                        </section>
                    ))}

                    {/* ─── Footer ─── */}
                    <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: '24px', marginTop: '40px' }}>
                        <p style={{ fontSize: '13px', color: '#999' }}>
                            Blanc API v1 — All requests and responses use JSON. Every response includes a <code style={{ background: '#f3f4f6', padding: '1px 4px', borderRadius: '2px' }}>request_id</code> for debugging.
                        </p>
                    </div>
                </div>
            </main>
        </div>
    );
}
