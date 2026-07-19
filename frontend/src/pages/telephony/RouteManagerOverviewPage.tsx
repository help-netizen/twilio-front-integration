import { useState, useEffect } from 'react';
import { FileText, LayoutDashboard, Music, Phone, Shield, ShieldBan, Users, Zap } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PHONE_SYSTEM_LINKS } from '../../components/settings/settingsNav';
import { telephonyApi } from '../../services/telephonyApi';
import { useAutonomousModeContext } from '../../contexts/AutonomousModeContext';
import { useAuthz } from '../../hooks/useAuthz';
import { useIsMobile } from '../../hooks/useIsMobile';
import { Switch } from '../../components/ui/switch';
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';

const INK1 = 'var(--blanc-ink-1, #202734)';
const INK2 = 'var(--blanc-ink-2, #536070)';
const INK3 = 'var(--blanc-ink-3, #7d8796)';
const JOB = 'var(--blanc-job, #2f63d8)';
const LINE = 'var(--blanc-line, var(--blanc-line))';
const WARNING = 'var(--blanc-warning, #b26a1d)';

export default function RouteManagerOverviewPage() {
    const navigate = useNavigate();
    const isMobile = useIsMobile();
    const { autonomousMode, loading, setAutonomousMode } = useAutonomousModeContext();
    const { hasPermission } = useAuthz();
    const canManage = hasPermission('tenant.telephony.manage');

    const [counts, setCounts] = useState({ user_groups_count: 0, phone_numbers_count: 0, call_flows_count: 0 });
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => { telephonyApi.getOverview().then(setCounts); }, []);

    // Turning ON is guarded by a confirm dialog; turning OFF is immediate.
    const handleToggle = (next: boolean) => {
        if (!canManage || saving) return;
        if (next) { setConfirmOpen(true); return; }
        void persist(false);
    };

    const persist = async (next: boolean) => {
        setSaving(true);
        try {
            await setAutonomousMode(next);
        } catch (err) {
            console.error('[Telephony] autonomous-mode toggle failed:', err);
            alert('Failed to update autonomous mode. Please try again.');
        } finally {
            setSaving(false);
            setConfirmOpen(false);
        }
    };

    const cardContent: Record<(typeof PHONE_SYSTEM_LINKS)[number]['id'], {
        desc: string;
        icon: typeof LayoutDashboard;
        count: string | null;
    }> = {
        'phone-dashboard': { desc: 'Active calls, queues, and agent presence', icon: LayoutDashboard, count: 'Live' },
        'phone-numbers': { desc: 'Buy, route, and assign numbers; SMS compliance', icon: Phone, count: `${counts.phone_numbers_count} numbers` },
        'phone-user-groups': { desc: 'Agent groups with numbers, schedules & call flows', icon: Users, count: `${counts.user_groups_count} groups` },
        'phone-audio-library': { desc: 'Greetings, prompts, hold music', icon: Music, count: null },
        'phone-blacklist': { desc: 'Block unwanted callers and destinations', icon: ShieldBan, count: null },
        'phone-provider-settings': { desc: 'Configure telephony provider credentials', icon: Shield, count: null },
        'phone-routing-logs': { desc: 'Inspect call-routing decisions and outcomes', icon: FileText, count: null },
    };

    const cards = PHONE_SYSTEM_LINKS.map(link => ({ ...link, ...cardContent[link.id] }));

    return (
        <div style={{ padding: isMobile ? '20px 16px' : '28px 24px' }}>
            <div className="blanc-eyebrow">Telephony</div>
            <h1 style={{ fontSize: isMobile ? 22 : 24, fontWeight: 600, margin: '4px 0 4px', fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: INK1 }}>Telephony</h1>
            <p style={{ fontSize: 13, color: INK3, margin: '0 0 20px' }}>Numbers, agent groups, call flows, and live operations.</p>

            {/* Autonomous mode — top of the page. Company-wide operational switch. */}
            <div
                style={{
                    display: 'flex',
                    flexDirection: isMobile ? 'column' : 'row',
                    alignItems: isMobile ? 'flex-start' : 'center',
                    gap: isMobile ? 12 : 16,
                    padding: isMobile ? 16 : '16px 20px',
                    marginBottom: 24,
                    borderRadius: 16,
                    border: `1px solid ${autonomousMode ? 'color-mix(in srgb, var(--blanc-warning, #b26a1d) 40%, transparent)' : LINE}`,
                    background: autonomousMode
                        ? 'color-mix(in srgb, var(--blanc-warning, #b26a1d) 8%, var(--blanc-surface-strong, #fdf8f0))'
                        : 'var(--blanc-surface-strong, #fffdf9)',
                    transition: 'background 0.15s, border-color 0.15s',
                }}
            >
                <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    <Zap size={18} style={{ color: autonomousMode ? WARNING : INK3, marginTop: 2, flexShrink: 0 }} />
                    <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 600, color: INK1 }}>Autonomous mode</div>
                        <div style={{ fontSize: 12.5, color: INK2, marginTop: 2, lineHeight: 1.4 }}>
                            Route every incoming call through the After-Hours branch, ignoring your working-hours schedule.
                        </div>
                    </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, alignSelf: isMobile ? 'stretch' : 'center', justifyContent: isMobile ? 'space-between' : undefined }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: autonomousMode ? WARNING : INK3 }}>
                        {autonomousMode ? 'ON' : 'Off'}
                    </span>
                    <Switch
                        checked={autonomousMode}
                        onCheckedChange={handleToggle}
                        disabled={!canManage || loading || saving}
                        aria-label="Autonomous mode"
                    />
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(260px, 1fr))', gap: isMobile ? 12 : 16 }}>
                {cards.map(card => {
                    const Icon = card.icon;
                    return (
                        <div key={card.id} onClick={() => navigate(card.to)} style={{ background: 'var(--blanc-surface-strong, #fffdf9)', border: `1px solid ${LINE}`, borderRadius: 16, padding: 20, cursor: 'pointer', transition: 'border-color 0.15s' }}
                            onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(25,25,25,0.28)')}
                            onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--blanc-line)')}>
                            <Icon size={20} style={{ color: INK3, marginBottom: 12 }} />
                            <div style={{ fontSize: 15, fontWeight: 600, color: INK1 }}>{card.label}</div>
                            <div style={{ fontSize: 12, color: INK2, marginBottom: 8 }}>{card.desc}</div>
                            {card.count && <div style={{ fontSize: 11, color: JOB, fontWeight: 600 }}>{card.count}</div>}
                        </div>
                    );
                })}
            </div>

            {/* Confirm-on-enable. Turning OFF never reaches here. */}
            <Dialog open={confirmOpen} onOpenChange={open => { if (!open && !saving) setConfirmOpen(false); }}>
                <DialogContent size="sm">
                    <DialogHeader>
                        <DialogTitle>Turn on autonomous mode?</DialogTitle>
                        <DialogDescription>
                            All incoming calls will be handled as after-hours until you turn this off. Continue?
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={saving}>Cancel</Button>
                        <Button onClick={() => void persist(true)} disabled={saving}>{saving ? 'Saving…' : 'Confirm'}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
