import { useState, useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { ENDPOINTS, MethodBadge, CodeBlock, FieldsTable, ErrorsTable } from './apiDocsData';

export default function ApiDocsPage() {
    const [activeEndpoint, setActiveEndpoint] = useState(ENDPOINTS[0].id);
    const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

    useEffect(() => {
        const handleScroll = () => { const container = document.getElementById('docs-content'); if (!container) return; const scrollTop = container.scrollTop + 100; for (const ep of ENDPOINTS) { const el = sectionRefs.current[ep.id]; if (el && el.offsetTop <= scrollTop) setActiveEndpoint(ep.id); } };
        const container = document.getElementById('docs-content');
        container?.addEventListener('scroll', handleScroll);
        return () => container?.removeEventListener('scroll', handleScroll);
    }, []);

    const scrollTo = (id: string) => { sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setActiveEndpoint(id); };

    return (
        <div style={{ display: 'flex', height: '100vh', background: 'var(--blanc-panel-surface)' }}>
            <aside style={{ width: '260px', minWidth: '260px', borderRight: '1px solid var(--blanc-line)', background: 'rgba(25, 25, 25, 0.03)', overflowY: 'auto', padding: '24px 0' }}>
                <div style={{ padding: '0 20px', marginBottom: '24px' }}><h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--blanc-ink-1)', margin: 0 }}>Albusto API</h2><p style={{ fontSize: '12px', color: 'var(--blanc-ink-3)', margin: '4px 0 0' }}>Developer Reference</p></div>
                <div style={{ padding: '0 20px', marginBottom: '16px' }}>
                    <button onClick={() => scrollTo('authentication')} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: '6px', border: 'none', background: activeEndpoint === 'authentication' ? 'var(--blanc-field)' : 'transparent', cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: 'var(--blanc-ink-1)' }}>🔐 Authentication</button>
                    <button onClick={() => scrollTo('rate-limiting')} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: '6px', border: 'none', background: activeEndpoint === 'rate-limiting' ? 'var(--blanc-field)' : 'transparent', cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: 'var(--blanc-ink-1)' }}>⏱ Rate Limiting</button>
                </div>
                <div style={{ padding: '0 20px', marginBottom: '8px' }}><span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--blanc-ink-3)', textTransform: 'uppercase', letterSpacing: '1px' }}>Endpoints</span></div>
                {ENDPOINTS.map(ep => (
                    <button key={ep.id} onClick={() => scrollTo(ep.id)} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', textAlign: 'left', padding: '7px 20px', border: 'none', background: activeEndpoint === ep.id ? 'var(--blanc-field)' : 'transparent', cursor: 'pointer', fontSize: '13px', color: activeEndpoint === ep.id ? 'var(--blanc-ink-1)' : 'var(--blanc-ink-2)', fontWeight: activeEndpoint === ep.id ? 600 : 400, transition: 'all 0.15s' }}>
                        <MethodBadge method={ep.method} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ep.title}</span>
                    </button>
                ))}
            </aside>

            <main id="docs-content" style={{ flex: 1, overflowY: 'auto', padding: '32px 48px 80px' }}>
                <div style={{ maxWidth: '900px' }}>
                    <h1 style={{ fontSize: '28px', fontWeight: 700, color: 'var(--blanc-ink-1)', margin: '0 0 8px' }}>Albusto API Reference</h1>
                    <p style={{ fontSize: '15px', color: 'var(--blanc-ink-2)', lineHeight: '1.6', margin: '0 0 32px' }}>Integrate with Albusto to create and manage leads programmatically. All endpoints return JSON responses with a consistent structure.</p>

                    <section ref={el => { sectionRefs.current['authentication'] = el; }} id="authentication" style={{ marginBottom: '48px', scrollMarginTop: '24px' }}>
                        <h2 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--blanc-ink-1)', margin: '0 0 12px', paddingBottom: '8px', borderBottom: '2px solid var(--blanc-line)' }}>🔐 Authentication</h2>
                        <p style={{ fontSize: '14px', color: 'var(--blanc-ink-2)', lineHeight: '1.7', margin: '0 0 16px' }}>All external API requests are authenticated using an <strong>API Key</strong> and <strong>API Secret</strong> sent as HTTP headers. Credentials are generated in <a href="/settings/integrations?tab=api-keys" style={{ color: 'var(--blanc-accent)', textDecoration: 'underline' }}>Settings → Apps &amp; integrations → API access</a>.</p>
                        <div style={{ background: 'rgba(47, 99, 216, 0.06)', border: '1px solid rgba(47, 99, 216, 0.25)', borderRadius: '8px', padding: '16px', marginBottom: '16px' }}><p style={{ fontSize: '13px', color: 'var(--blanc-info)', margin: 0, fontWeight: 500 }}>⚠️ The API secret is shown <strong>only once</strong> at creation time. Store it securely. Secrets are hashed server-side and cannot be recovered.</p></div>
                        <CodeBlock lang="http" code={`POST /api/v1/integrations/leads HTTP/1.1\nHost: your-domain.com\nContent-Type: application/json\nX-BLANC-API-KEY: blanc_abc123def456...\nX-BLANC-API-SECRET: your_secret_here`} />
                        <div style={{ marginTop: '16px', padding: '12px 16px', background: 'rgba(178, 106, 29, 0.08)', border: '1px solid rgba(178, 106, 29, 0.30)', borderRadius: '8px' }}><p style={{ fontSize: '13px', color: 'var(--blanc-warning)', margin: 0 }}><strong>Legacy auth rejected:</strong> Sending <code style={{ background: 'rgba(178, 106, 29, 0.15)', padding: '1px 4px', borderRadius: '2px' }}>auth_secret</code> in the request body or <code style={{ background: 'rgba(178, 106, 29, 0.15)', padding: '1px 4px', borderRadius: '2px' }}>api_key</code> in query params will return <code>401 AUTH_LEGACY_REJECTED</code>.</p></div>
                    </section>

                    <section ref={el => { sectionRefs.current['rate-limiting'] = el; }} id="rate-limiting" style={{ marginBottom: '48px', scrollMarginTop: '24px' }}>
                        <h2 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--blanc-ink-1)', margin: '0 0 12px', paddingBottom: '8px', borderBottom: '2px solid var(--blanc-line)' }}>⏱ Rate Limiting</h2>
                        <p style={{ fontSize: '14px', color: 'var(--blanc-ink-2)', lineHeight: '1.7', margin: '0 0 16px' }}>Requests are rate-limited per API key and per IP address using a sliding window.</p>
                        <div style={{ border: '1px solid var(--blanc-line)', borderRadius: '8px', overflow: 'hidden' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}><thead><tr style={{ background: 'rgba(25, 25, 25, 0.03)' }}><th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid var(--blanc-line)', fontWeight: 600 }}>Scope</th><th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid var(--blanc-line)', fontWeight: 600 }}>Limit</th><th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid var(--blanc-line)', fontWeight: 600 }}>Window</th></tr></thead><tbody><tr><td style={{ padding: '8px 12px', borderBottom: '1px solid var(--blanc-line)' }}>Per API Key</td><td style={{ padding: '8px 12px', borderBottom: '1px solid var(--blanc-line)', fontFamily: 'monospace' }}>60 requests</td><td style={{ padding: '8px 12px', borderBottom: '1px solid var(--blanc-line)' }}>60 seconds</td></tr><tr style={{ background: 'rgba(25, 25, 25, 0.02)' }}><td style={{ padding: '8px 12px' }}>Per IP Address</td><td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>120 requests</td><td style={{ padding: '8px 12px' }}>60 seconds</td></tr></tbody></table>
                        </div>
                        <p style={{ fontSize: '13px', color: 'var(--blanc-ink-3)', marginTop: '12px' }}>When rate-limited, the API returns <code style={{ background: 'var(--blanc-field)', padding: '1px 4px', borderRadius: '2px' }}>429 Too Many Requests</code> with a <code style={{ background: 'var(--blanc-field)', padding: '1px 4px', borderRadius: '2px' }}>Retry-After</code> header.</p>
                    </section>

                    {ENDPOINTS.map(ep => (
                        <section key={ep.id} ref={el => { sectionRefs.current[ep.id] = el; }} id={ep.id} style={{ marginBottom: '56px', scrollMarginTop: '24px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px' }}><MethodBadge method={ep.method} /><h2 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--blanc-ink-1)', margin: 0 }}>{ep.title}</h2></div>
                            <div style={{ display: 'inline-block', padding: '4px 12px', borderRadius: '6px', background: 'var(--blanc-field)', fontFamily: 'monospace', fontSize: '13px', color: 'var(--blanc-ink-1)', marginBottom: '12px' }}>{ep.path}</div>
                            <p style={{ fontSize: '14px', color: 'var(--blanc-ink-2)', lineHeight: '1.7', margin: '0 0 16px' }}>{ep.description}</p>
                            {ep.scope && <div style={{ marginBottom: '16px' }}><span style={{ fontSize: '12px', color: 'var(--blanc-ink-3)', marginRight: '8px' }}>Required scope:</span><Badge variant="outline">{ep.scope}</Badge></div>}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
                                <div>
                                    {ep.headers && <FieldsTable fields={ep.headers} title="Headers" />}
                                    {ep.body && <FieldsTable fields={ep.body} title="Body Parameters" />}
                                    {ep.query && <FieldsTable fields={ep.query} title="Query Parameters" />}
                                    {ep.errors && ep.errors.length > 0 && <ErrorsTable errors={ep.errors} />}
                                </div>
                                <div>
                                    <h4 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--blanc-ink-2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px', marginTop: '16px' }}>Example Request</h4>
                                    <CodeBlock code={ep.curl} lang="bash" />
                                    <h4 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--blanc-ink-2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px', marginTop: '24px' }}>Response</h4>
                                    <CodeBlock code={ep.response} lang="json" />
                                </div>
                            </div>
                        </section>
                    ))}

                    <div style={{ borderTop: '1px solid var(--blanc-line)', paddingTop: '24px', marginTop: '40px' }}><p style={{ fontSize: '13px', color: 'var(--blanc-ink-3)' }}>Albusto API v1 — All requests and responses use JSON. Every response includes a <code style={{ background: 'var(--blanc-field)', padding: '1px 4px', borderRadius: '2px' }}>request_id</code> for debugging.</p></div>
                </div>
            </main>
        </div>
    );
}
