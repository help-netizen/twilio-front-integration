import { useState, useEffect } from 'react';
import { Phone, Search, Plus, Trash2, Loader2, PlugZap, MapPin } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import { authedFetch } from '../../services/apiClient';
import { billingApi } from '../../services/billingApi';
import type { PhoneNumber, UserGroup } from '../../types/telephony';
import { A2pStepper } from '../../components/telephony/A2pStepper';

export default function PhoneNumbersPage() {
    const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
    const [groups, setGroups] = useState<UserGroup[]>([]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [savingNumberId, setSavingNumberId] = useState<string | null>(null);

    // ALB-107: tenant telephony connection + number purchasing
    const [telState, setTelState] = useState<{ connected: boolean; mode?: string; status?: string } | null>(null);
    const [connecting, setConnecting] = useState(false);
    const [buyOpen, setBuyOpen] = useState(false);
    const [areaCode, setAreaCode] = useState('');
    const [containsQ, setContainsQ] = useState('');
    const [tollFree, setTollFree] = useState(false);
    const [searchBusy, setSearchBusy] = useState(false);
    const [found, setFound] = useState<Array<{ phone_number: string; locality: string | null; region: string | null; capabilities: { voice: boolean; sms: boolean }; monthly_price_usd: number }>>([]);
    const [buyingNum, setBuyingNum] = useState<string | null>(null);
    const [releasingSid, setReleasingSid] = useState<string | null>(null);
    const [numberLimit, setNumberLimit] = useState<number | null>(null);

    // Phase 2: usage + A2P compliance
    const [usage, setUsage] = useState<{ total_usd: number; calls: { count: number }; sms: { count: number }; numbers: { count: number } } | null>(null);
    const [a2p, setA2p] = useState<any>(null);
    const [a2pBusy, setA2pBusy] = useState(false);
    const [a2pError, setA2pError] = useState<string | null>(null);
    const [a2pRefreshing, setA2pRefreshing] = useState(false);
    const [biz, setBiz] = useState<Record<string, string>>({
        legal_name: '', ein: '', website: '', address_street: '', address_city: '',
        address_state: '', address_zip: '', contact_first_name: '', contact_last_name: '',
        contact_email: '', contact_phone: '',
    });

    const loadPhase2 = async () => {
        try {
            const [u, a] = await Promise.all([
                authedFetch('/api/telephony/numbers/usage').then(r => r.json()).catch(() => null),
                authedFetch('/api/telephony/numbers/a2p').then(r => r.json()).catch(() => null),
            ]);
            if (u?.usage) setUsage(u.usage);
            if (a?.registration) setA2p(a.registration);
        } catch { /* non-blocking */ }
    };
    useEffect(() => { loadPhase2(); }, []);

    const submitA2p = async () => {
        setA2pBusy(true); setA2pError(null);
        try {
            const r = await authedFetch('/api/telephony/numbers/a2p/register', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ business: biz }),
            });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error || 'Registration failed');
            setA2p(j.registration);
        } catch (e: any) { setA2pError(e.message || 'Registration failed'); }
        finally { setA2pBusy(false); }
    };

    const submitCampaign = async () => {
        setA2pBusy(true); setA2pError(null);
        try {
            const r = await authedFetch('/api/telephony/numbers/a2p/campaign', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ campaign: {} }),
            });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error || 'Campaign failed');
            setA2p(j.registration);
        } catch (e: any) { setA2pError(e.message || 'Campaign failed'); }
        finally { setA2pBusy(false); }
    };

    const refreshA2p = async () => {
        setA2pRefreshing(true); setA2pError(null);
        try {
            const a = await authedFetch('/api/telephony/numbers/a2p').then(r => r.json());
            if (a?.registration) setA2p(a.registration);
        } catch { /* non-blocking */ }
        finally { setA2pRefreshing(false); }
    };

    const loadTelState = async () => {
        try {
            const r = await authedFetch('/api/telephony/numbers/status');
            const j = await r.json();
            setTelState(j.state || { connected: false });
        } catch { setTelState({ connected: false }); }
    };
    useEffect(() => { loadTelState(); }, []);

    const connectTelephony = async () => {
        setConnecting(true);
        try {
            const r = await authedFetch('/api/telephony/numbers/connect', { method: 'POST' });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error || 'Failed');
            setTelState(j.state);
            // Provision browser-softphone creds in the new subaccount (best-effort)
            authedFetch('/api/telephony/numbers/softphone/setup', { method: 'POST' }).catch(() => {});
            loadPhase2();
        } catch (e: any) {
            alert(e.message || 'Failed to connect telephony');
        } finally { setConnecting(false); }
    };

    const searchAvailable = async () => {
        setSearchBusy(true); setFound([]);
        try {
            const qs = new URLSearchParams();
            if (areaCode) qs.set('area_code', areaCode);
            if (containsQ) qs.set('contains', containsQ);
            if (tollFree) qs.set('toll_free', 'true');
            const r = await authedFetch(`/api/telephony/numbers/search?${qs}`);
            const j = await r.json();
            if (!r.ok) throw new Error(j.error || 'Search failed');
            setFound(j.results || []);
        } catch (e: any) { alert(e.message || 'Search failed'); }
        finally { setSearchBusy(false); }
    };

    const buyNumber = async (phone: string) => {
        setBuyingNum(phone);
        try {
            const r = await authedFetch('/api/telephony/numbers/buy', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone_number: phone }),
            });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error || 'Purchase failed');
            setBuyOpen(false); setFound([]);
            await loadData();
        } catch (e: any) { alert(e.message || 'Purchase failed'); }
        finally { setBuyingNum(null); }
    };

    const releaseNumber = async (n: PhoneNumber) => {
        const sid = (n as any).twilio_sid || (n as any).sid;
        if (!sid) { alert('This number cannot be released from here'); return; }
        if (!window.confirm(`Release ${n.number}? Incoming calls to it will stop working immediately. This cannot be undone.`)) return;
        setReleasingSid(sid);
        try {
            const r = await authedFetch(`/api/telephony/numbers/${sid}`, { method: 'DELETE' });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error || 'Release failed');
            await loadData();
        } catch (e: any) { alert(e.message || 'Release failed'); }
        finally { setReleasingSid(null); }
    };

    const loadData = async () => {
        setLoading(true);
        try {
            // ALB-107: subaccount tenants list numbers through the tenant API;
            // the legacy master-account company falls back to the old endpoint.
            const [tenantRes, groupRes, billing] = await Promise.all([
                authedFetch('/api/telephony/numbers').then(r => r.json()).catch(() => null),
                authedFetch('/api/user-groups').then(r => r.json()).catch(() => ({ data: [] })),
                billingApi.overview().catch(() => null),
            ]);
            if (billing) {
                // Only cap when the company actually has a billing subscription;
                // unbilled/platform companies (no subscription) have no limit.
                const cur = billing.subscription?.plan_id;
                const p = cur ? billing.plans.find((x) => x.id === cur) : null;
                setNumberLimit(p?.max_phone_numbers ?? null);
            }
            if (tenantRes?.ok && !tenantRes.not_connected && Array.isArray(tenantRes.numbers) && tenantRes.numbers.length > 0) {
                setNumbers(tenantRes.numbers.map((n: any) => ({
                    id: n.sid,
                    sid: n.sid,
                    twilio_sid: n.sid,
                    number: n.phone_number,
                    friendly_name: n.friendly_name,
                    provider: 'twilio',
                    group_id: n.group_id,
                    group: n.group_name,
                    status: 'active',
                    webhook_configured: !!n.webhook_ok,
                } as unknown as PhoneNumber)));
            } else {
                setNumbers(await telephonyApi.listNumbers());
            }
            setGroups(groupRes.data || []);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { loadData(); }, []);

    const assignGroup = async (number: PhoneNumber, groupId: string | null, force = false) => {
        setSavingNumberId(number.id);
        try {
            const res = await authedFetch(`/api/phone-numbers/${number.id}/group`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group_id: groupId, force }),
            });
            const data = await res.json();
            if (res.status === 409) {
                const ok = window.confirm(data.message || 'This number is already assigned to another group. Move it?');
                if (ok) await assignGroup(number, groupId, true);
                return;
            }
            if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to update number group');
            setNumbers(current => current.map(n => n.id === number.id ? data.data : n));
        } catch (err) {
            console.error('[PhoneNumbers] group assignment failed:', err);
            alert('Failed to update number group');
        } finally {
            setSavingNumberId(null);
        }
    };

    const filtered = numbers.filter(n => !search || n.number.includes(search) || n.friendly_name.toLowerCase().includes(search.toLowerCase()) || (n.group || '').toLowerCase().includes(search.toLowerCase()));
    const atLimit = numberLimit != null && numbers.length >= numberLimit;
    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div><h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Phone Numbers</h1><p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Manage Twilio numbers</p></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {telState?.connected && numberLimit != null && (
                        <span style={{ fontSize: 12, fontWeight: 500, color: atLimit ? '#d44d3c' : '#6b7280' }}>{numbers.length} / {numberLimit} numbers</span>
                    )}
                    {telState?.connected && (
                        <button onClick={() => setBuyOpen(true)} disabled={atLimit}
                            title={atLimit ? `Your plan includes up to ${numberLimit} numbers — upgrade to add more` : undefined}
                            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: '#111827', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: atLimit ? 'default' : 'pointer', opacity: atLimit ? 0.45 : 1 }}>
                            <Plus size={14} /> Buy number
                        </button>
                    )}
                    <div style={{ position: 'relative' }}>
                        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
                        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." style={{ padding: '8px 12px 8px 32px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, width: 240 }} />
                    </div>
                </div>
            </div>
            {telState && !telState.connected && (
                <div style={{ margin: '8px 0 20px', padding: 24, border: '1px dashed #d1d5db', borderRadius: 14, display: 'flex', alignItems: 'center', gap: 16, background: '#fafafa' }}>
                    <div style={{ width: 44, height: 44, borderRadius: 22, background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <PlugZap size={20} style={{ color: '#6366f1' }} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>Connect telephony</div>
                        <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
                            Creates a dedicated, isolated phone environment for your company. After connecting you can buy local numbers (from $1.15/mo) and route calls to your team.
                        </div>
                    </div>
                    <button onClick={connectTelephony} disabled={connecting} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 18px', background: '#111827', color: '#fff', border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: connecting ? 0.7 : 1 }}>
                        {connecting ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />} Connect
                    </button>
                </div>
            )}

            {telState?.connected && usage && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'rgba(117,106,89,0.04)', border: '1px solid var(--blanc-line, rgba(117,106,89,0.18))', borderRadius: 10, fontSize: 12.5, color: 'var(--blanc-ink-2, #536070)', margin: '0 0 14px', width: 'fit-content' }}>
                    <span style={{ fontWeight: 700, color: 'var(--blanc-ink-1, #202734)' }}>${usage.total_usd?.toFixed?.(2) ?? usage.total_usd}</span> this month ·
                    {' '}{usage.calls.count} calls · {usage.sms.count} SMS · {usage.numbers.count} numbers
                </div>
            )}

            {telState?.connected && (
                <A2pStepper
                    reg={a2p}
                    biz={biz}
                    setBiz={setBiz}
                    busy={a2pBusy}
                    error={a2pError}
                    onRegister={submitA2p}
                    onCreateCampaign={submitCampaign}
                    onRefresh={refreshA2p}
                    refreshing={a2pRefreshing}
                />
            )}

            {buyOpen && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setBuyOpen(false)}>
                    <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 560, background: '#fff', borderRadius: 16, padding: 24, maxHeight: '85vh', overflowY: 'auto' }}>
                        <h2 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700 }}>Buy a phone number</h2>
                        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>Search available US numbers — billed to your workspace at the listed monthly price.</p>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                            <input value={areaCode} onChange={e => setAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="Area code (e.g. 617)" style={{ flex: '1 1 120px', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 }} />
                            <input value={containsQ} onChange={e => setContainsQ(e.target.value)} placeholder="Contains digits (optional)" style={{ flex: '1 1 150px', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 }} />
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151' }}>
                                <input type="checkbox" checked={tollFree} onChange={e => setTollFree(e.target.checked)} /> Toll-free
                            </label>
                            <button onClick={searchAvailable} disabled={searchBusy} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', background: '#111827', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                                {searchBusy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Search
                            </button>
                        </div>
                        {found.length === 0 && !searchBusy && (
                            <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Enter an area code and search</div>
                        )}
                        {found.map(f => (
                            <div key={f.phone_number} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 4px', borderBottom: '1px solid #f3f4f6' }}>
                                <Phone size={14} style={{ color: '#6366f1' }} />
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 600, fontSize: 14 }}>{f.phone_number}</div>
                                    <div style={{ fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}>
                                        <MapPin size={11} /> {[f.locality, f.region].filter(Boolean).join(', ') || 'US'} ·
                                        {f.capabilities.voice ? ' Voice' : ''}{f.capabilities.sms ? ' · SMS' : ''}
                                    </div>
                                </div>
                                <div style={{ fontSize: 12, color: '#6b7280' }}>${f.monthly_price_usd}/mo</div>
                                <button onClick={() => buyNumber(f.phone_number)} disabled={buyingNum === f.phone_number} style={{ padding: '7px 14px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                                    {buyingNum === f.phone_number ? 'Buying…' : 'Buy'}
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {loading ? <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div> : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead><tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                        {['Number', 'Name', 'Provider', 'Group', 'Status', 'Webhook', ''].map((h, i) => <th key={i} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' }}>{h}</th>)}
                    </tr></thead>
                    <tbody>{filtered.map(n => (
                        <tr key={n.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}><Phone size={14} style={{ color: '#6366f1' }} />{n.number}</td>
                            <td style={{ padding: '10px 12px' }}>{n.friendly_name}</td>
                            <td style={{ padding: '10px 12px' }}>{n.provider}</td>
                            <td style={{ padding: '10px 12px' }}>
                                <select
                                    value={n.group_id || ''}
                                    disabled={savingNumberId === n.id}
                                    onChange={e => assignGroup(n, e.target.value || null)}
                                    style={{ minWidth: 160, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 12, background: '#fff', color: n.group_id ? '#111827' : '#6b7280' }}
                                >
                                    <option value="">Unassigned</option>
                                    {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                                </select>
                            </td>
                            <td style={{ padding: '10px 12px' }}><span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: n.status === 'active' ? '#d1fae5' : '#fef3c7', color: n.status === 'active' ? '#065f46' : '#92400e' }}>{n.status}</span></td>
                            <td style={{ padding: '10px 12px' }}>{n.webhook_configured ? '✓ Configured' : '✗ Not set'}</td>
                            <td style={{ padding: '10px 12px' }}>
                                <button title="Release number" onClick={() => releaseNumber(n)} disabled={releasingSid === ((n as any).twilio_sid || (n as any).sid)}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 4 }}
                                    onMouseEnter={e => (e.currentTarget.style.color = '#dc2626')}
                                    onMouseLeave={e => (e.currentTarget.style.color = '#9ca3af')}>
                                    <Trash2 size={14} />
                                </button>
                            </td>
                        </tr>
                    ))}</tbody>
                </table>
            )}
        </div>
    );
}
