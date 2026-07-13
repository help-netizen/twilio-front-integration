import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, Search, Plus, Trash2, Loader2, PlugZap, MapPin, Monitor, Headphones } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import { authedFetch } from '../../services/apiClient';
import { billingApi } from '../../services/billingApi';
import type { PhoneNumber, UserGroup } from '../../types/telephony';
import { A2pStepper } from '../../components/telephony/A2pStepper';
import { PortInPanel, type PortInRequest } from '../../components/telephony/PortInPanel';
import { toast } from 'sonner';
import { SettingsPageShell } from '../../components/settings/SettingsPageShell';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogPanelHeader, DialogTitle, DialogDescription, DialogBody } from '../../components/ui/dialog';

export default function PhoneNumbersPage() {
    const navigate = useNavigate();
    const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
    const [portRequests, setPortRequests] = useState<PortInRequest[]>([]);
    const [groups, setGroups] = useState<UserGroup[]>([]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [savingNumberId, setSavingNumberId] = useState<string | null>(null);

    // ALB-107: tenant telephony connection + number purchasing
    const [telState, setTelState] = useState<{ connected: boolean; mode?: string; status?: string } | null>(null);
    const [buyOpen, setBuyOpen] = useState(false);
    const [areaCode, setAreaCode] = useState('');
    const [containsQ, setContainsQ] = useState('');
    const [tollFree, setTollFree] = useState(false);
    const [searchBusy, setSearchBusy] = useState(false);
    const [found, setFound] = useState<Array<{ phone_number: string; locality: string | null; region: string | null; capabilities: { voice: boolean; sms: boolean }; monthly_price_usd: number }>>([]);
    const [buyingNum, setBuyingNum] = useState<string | null>(null);
    const [releasingSid, setReleasingSid] = useState<string | null>(null);
    const [numberLimit, setNumberLimit] = useState<number | null>(null);
    // Routing mode per phone number (merged from the old Phone Calls page).
    const [routing, setRouting] = useState<Record<string, { id: number; mode: 'sip' | 'client' }>>({});
    const [routingBusy, setRoutingBusy] = useState<string | null>(null);

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

    // ONBTEL-001 §2.5: the connect flow lives in exactly one place — the
    // marketplace wizard. The former local connectTelephony handler is gone.

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
        } catch (e: any) { toast.error(e.message || 'Search failed'); }
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
            toast.success(`${phone} purchased`);
        } catch (e: any) { toast.error(e.message || 'Purchase failed'); }
        finally { setBuyingNum(null); }
    };

    const releaseNumber = async (n: PhoneNumber) => {
        const sid = (n as any).twilio_sid || (n as any).sid;
        if (!sid) { toast.error('This number cannot be released from here'); return; }
        if (!window.confirm(`Release ${n.number}? Incoming calls to it will stop working immediately. This cannot be undone.`)) return;
        setReleasingSid(sid);
        try {
            const r = await authedFetch(`/api/telephony/numbers/${sid}`, { method: 'DELETE' });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error || 'Release failed');
            await loadData();
            toast.success(`${n.number} released`);
        } catch (e: any) { toast.error(e.message || 'Release failed'); }
        finally { setReleasingSid(null); }
    };

    const toggleRouting = async (n: PhoneNumber) => {
        const setting = routing[n.number];
        if (!setting) { toast.error('Routing is not configured for this number yet'); return; }
        const next = setting.mode === 'sip' ? 'client' : 'sip';
        setRoutingBusy(n.number);
        try {
            const r = await authedFetch(`/api/phone-settings/${setting.id}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ routing_mode: next }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || 'Failed to update routing');
            setRouting(prev => ({ ...prev, [n.number]: { ...setting, mode: next } }));
            toast.success(`Calls ring on ${next === 'client' ? 'the browser SoftPhone' : 'Bria (SIP)'}`);
        } catch (e: any) { toast.error(e.message || 'Failed to update routing'); }
        finally { setRoutingBusy(null); }
    };

    const loadData = async () => {
        setLoading(true);
        try {
            // ALB-107: subaccount tenants list numbers through the tenant API;
            // the legacy master-account company falls back to the old endpoint.
            const [tenantRes, groupRes, billing, settingsRes, portInRes] = await Promise.all([
                authedFetch('/api/telephony/numbers').then(r => r.json()).catch(() => null),
                authedFetch('/api/user-groups').then(r => r.json()).catch(() => ({ data: [] })),
                billingApi.overview().catch(() => null),
                authedFetch('/api/phone-settings').then(r => r.json()).catch(() => null),
                authedFetch('/api/telephony/port-in').then(r => r.json()).catch(() => null),
            ]);
            if (Array.isArray(portInRes?.requests)) setPortRequests(portInRes.requests);
            // Routing mode (SoftPhone vs Bria/SIP) per number — merged in from the
            // former standalone Phone Calls page. Keyed by phone number.
            if (settingsRes?.ok && Array.isArray(settingsRes.data)) {
                setRouting(Object.fromEntries(settingsRes.data.map((s: any) => [s.phone_number, { id: s.id, mode: s.routing_mode }])));
            }
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
            toast.error('Failed to update number group');
        } finally {
            setSavingNumberId(null);
        }
    };

    const filtered = numbers.filter(n => !search || n.number.includes(search) || n.friendly_name.toLowerCase().includes(search.toLowerCase()) || (n.group || '').toLowerCase().includes(search.toLowerCase()));
    const atLimit = numberLimit != null && numbers.length >= numberLimit;
    return (
        <SettingsPageShell
            title="Phone Numbers"
            description="Manage Twilio numbers"
            actions={
                <>
                    {telState?.connected && numberLimit != null && (
                        <span style={{ fontSize: 12, fontWeight: 500, color: atLimit ? 'var(--blanc-danger)' : 'var(--blanc-ink-2)' }}>{numbers.length} / {numberLimit} numbers</span>
                    )}
                    {telState?.connected && (
                        <Button onClick={() => setBuyOpen(true)} disabled={atLimit}
                            title={atLimit ? `Your plan includes up to ${numberLimit} numbers — upgrade to add more` : undefined}>
                            <Plus className="size-4" /> Buy number
                        </Button>
                    )}
                </>
            }
        >
            {telState && !telState.connected && (
                <div style={{ padding: 24, border: '1px dashed var(--blanc-line)', borderRadius: 14, display: 'flex', alignItems: 'center', gap: 16, background: 'rgba(25,25,25,0.04)' }}>
                    <div style={{ width: 44, height: 44, borderRadius: 22, background: 'var(--blanc-accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <PlugZap size={20} style={{ color: 'var(--blanc-accent)' }} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>Connect telephony</div>
                        <div style={{ fontSize: 13, color: 'var(--blanc-ink-2)', marginTop: 2 }}>
                            Creates a dedicated, isolated phone environment for your company. After connecting you can buy local numbers (from $1.15/mo) and route calls to your team.
                        </div>
                    </div>
                    <Button onClick={() => navigate('/settings/integrations/telephony-twilio')}>
                        <PlugZap className="size-4" /> Connect in Marketplace
                    </Button>
                </div>
            )}

            {telState?.connected && usage && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'rgba(25,25,25,0.04)', border: '1px solid var(--blanc-line)', borderRadius: 10, fontSize: 12.5, color: 'var(--blanc-ink-2)', width: 'fit-content' }}>
                    <span style={{ fontWeight: 700, color: 'var(--blanc-ink-1)' }}>${usage.total_usd?.toFixed?.(2) ?? usage.total_usd}</span> this month ·
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

            {portRequests.length > 0 && (
                <section className="space-y-3.5">
                    <h2 className="blanc-eyebrow">Number transfers</h2>
                    <PortInPanel
                        initialRequests={portRequests}
                        statusOnly
                        onRequestsChange={setPortRequests}
                    />
                </section>
            )}

            {buyOpen && (
                <Dialog open onOpenChange={open => { if (!open) setBuyOpen(false); }}>
                    <DialogContent variant="panel">
                        <DialogPanelHeader>
                            <DialogTitle>Buy a phone number</DialogTitle>
                            <DialogDescription>Search available US numbers — billed to your workspace at the listed monthly price.</DialogDescription>
                        </DialogPanelHeader>
                        <DialogBody className="md:px-8 md:py-7">
                            <div className="mx-auto w-full max-w-[740px] space-y-6">
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    <input value={areaCode} onChange={e => setAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="Area code (e.g. 617)" style={{ flex: '1 1 120px', padding: '9px 12px', border: '1px solid var(--blanc-line-strong)', borderRadius: 8, fontSize: 13 }} />
                                    <input value={containsQ} onChange={e => setContainsQ(e.target.value)} placeholder="Contains digits (optional)" style={{ flex: '1 1 150px', padding: '9px 12px', border: '1px solid var(--blanc-line-strong)', borderRadius: 8, fontSize: 13 }} />
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--blanc-ink-1)' }}>
                                        <input type="checkbox" checked={tollFree} onChange={e => setTollFree(e.target.checked)} /> Toll-free
                                    </label>
                                    <Button onClick={searchAvailable} disabled={searchBusy}>
                                        {searchBusy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />} Search
                                    </Button>
                                </div>
                                <div>
                                    {found.length === 0 && !searchBusy && (
                                        <div style={{ padding: 24, textAlign: 'center', color: 'var(--blanc-ink-3)', fontSize: 13 }}>Enter an area code and search</div>
                                    )}
                                    {found.map(f => (
                                        <div key={f.phone_number} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 4px', borderBottom: '1px solid var(--blanc-line)' }}>
                                            <Phone size={14} style={{ color: 'var(--blanc-accent)' }} />
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontWeight: 600, fontSize: 14 }}>{f.phone_number}</div>
                                                <div style={{ fontSize: 12, color: 'var(--blanc-ink-2)', display: 'flex', alignItems: 'center', gap: 4 }}>
                                                    <MapPin size={11} /> {[f.locality, f.region].filter(Boolean).join(', ') || 'US'} ·
                                                    {f.capabilities.voice ? ' Voice' : ''}{f.capabilities.sms ? ' · SMS' : ''}
                                                </div>
                                            </div>
                                            <div style={{ fontSize: 12, color: 'var(--blanc-ink-2)' }}>${f.monthly_price_usd}/mo</div>
                                            <Button size="sm" onClick={() => buyNumber(f.phone_number)} disabled={buyingNum === f.phone_number}>
                                                {buyingNum === f.phone_number ? 'Buying…' : 'Buy'}
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </DialogBody>
                    </DialogContent>
                </Dialog>
            )}

            <div className="flex flex-col gap-3">
                <div style={{ position: 'relative', width: 240 }}>
                    <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--blanc-ink-3)' }} />
                    <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." style={{ width: '100%', padding: '8px 12px 8px 32px', border: '1px solid var(--blanc-line)', borderRadius: 8, fontSize: 13, background: 'var(--blanc-panel-surface)', boxSizing: 'border-box' }} />
                </div>
                {loading ? <div style={{ padding: 40, textAlign: 'center', color: 'var(--blanc-ink-3)' }}>Loading...</div> : (
                    <table className="blanc-table-tiles" style={{ fontSize: 13 }}>
                        <thead><tr>
                            {['Number', 'Name', 'Group', 'Routing', 'Status', 'Webhook', ''].map((h, i) => <th key={i} style={{ textAlign: 'left', padding: '8px 12px' }}>{h}</th>)}
                        </tr></thead>
                        <tbody>{filtered.map(n => (
                            <tr key={n.id}>
                                <td style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}><Phone size={14} style={{ color: 'var(--blanc-accent)' }} />{n.number}</td>
                                <td style={{ padding: '10px 12px' }}>{n.friendly_name}</td>
                                <td style={{ padding: '10px 12px' }}>
                                    <select
                                        value={n.group_id || ''}
                                        disabled={savingNumberId === n.id}
                                        onChange={e => assignGroup(n, e.target.value || null)}
                                        style={{ minWidth: 160, padding: '6px 8px', border: '1px solid var(--blanc-line)', borderRadius: 8, fontSize: 12, background: 'var(--blanc-panel-surface)', color: n.group_id ? 'var(--blanc-ink-1)' : 'var(--blanc-ink-2)' }}
                                    >
                                        <option value="">Unassigned</option>
                                        {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                                    </select>
                                </td>
                                <td style={{ padding: '10px 12px' }}>
                                    {routing[n.number] ? (
                                        <button onClick={() => toggleRouting(n)} disabled={routingBusy === n.number}
                                            title="Switch where calls ring"
                                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999, border: '1px solid var(--blanc-line)', background: 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: routing[n.number].mode === 'client' ? 'var(--blanc-accent)' : 'var(--blanc-ink-2)' }}>
                                            {routing[n.number].mode === 'client' ? <Monitor size={13} /> : <Headphones size={13} />}
                                            {routing[n.number].mode === 'client' ? 'SoftPhone' : 'Bria (SIP)'}
                                        </button>
                                    ) : <span style={{ fontSize: 12, color: 'var(--blanc-ink-3)' }}>—</span>}
                                </td>
                                <td style={{ padding: '10px 12px' }}><span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: n.status === 'active' ? 'rgba(27,139,99,0.12)' : 'rgba(178,106,29,0.12)', color: n.status === 'active' ? 'var(--blanc-success)' : 'var(--blanc-warning)' }}>{n.status}</span></td>
                                <td style={{ padding: '10px 12px' }}><span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: n.webhook_configured ? 'rgba(27,139,99,0.12)' : 'rgba(25,25,25,0.08)', color: n.webhook_configured ? 'var(--blanc-success)' : 'var(--blanc-ink-3)' }}>{n.webhook_configured ? 'Configured' : 'Not set'}</span></td>
                                <td style={{ padding: '10px 12px' }}>
                                    <button title="Release number" onClick={() => releaseNumber(n)} disabled={releasingSid === ((n as any).twilio_sid || (n as any).sid)}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--blanc-ink-3)', padding: 4 }}
                                        onMouseEnter={e => (e.currentTarget.style.color = 'var(--blanc-danger)')}
                                        onMouseLeave={e => (e.currentTarget.style.color = 'var(--blanc-ink-3)')}>
                                        <Trash2 size={14} />
                                    </button>
                                </td>
                            </tr>
                        ))}</tbody>
                    </table>
                )}
            </div>
        </SettingsPageShell>
    );
}
