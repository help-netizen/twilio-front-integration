import { Skeleton } from '../ui/skeleton';
import { Building2, Users as UsersIcon } from 'lucide-react';
import { usePlatformStats, type PlatformStats } from '../../hooks/usePlatformAdmin';

function KpiCard({ icon: Icon, label, data }: {
    icon: typeof Building2;
    label: string;
    data: PlatformStats['companies'];
}) {
    return (
        <div className="rounded-2xl border bg-card p-5">
            <div className="flex items-center gap-2">
                <Icon className="size-4 text-muted-foreground" />
                <span className="blanc-eyebrow">{label}</span>
            </div>
            <div className="mt-3 flex items-baseline justify-between gap-3">
                <span className="text-[40px] font-bold leading-none tracking-tight" style={{ fontFamily: 'var(--blanc-font-heading)' }}>
                    {data.total.toLocaleString()}
                </span>
                <span className={`text-sm font-semibold ${data.today > 0 ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                    {data.today > 0 ? `+${data.today} today` : 'none today'}
                </span>
            </div>
            <div className="mt-4 flex gap-6 text-xs text-muted-foreground">
                <span>Last 7 days<strong className="mt-0.5 block text-sm text-foreground">+{data.last7}</strong></span>
                <span>Last 30 days<strong className="mt-0.5 block text-sm text-foreground">+{data.last30}</strong></span>
            </div>
        </div>
    );
}

function GrowthChart({ growth }: { growth: PlatformStats['growth'] }) {
    const max = Math.max(1, ...growth.map(g => Math.max(g.companies, g.users)));
    const tick = (i: number) => i === 0 ? '30d ago' : i === growth.length - 1 ? 'today' : '';

    return (
        <div className="rounded-2xl border bg-card p-5">
            <div className="mb-4 flex items-end justify-between gap-4">
                <span className="blanc-eyebrow">New signups · last 30 days</span>
                <div className="flex gap-4 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-sm" style={{ background: 'var(--blanc-accent, #7F42E1)' }} />Users</span>
                    <span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-blue-600" />Companies</span>
                </div>
            </div>
            <div className="flex h-[140px] items-end gap-[3px]">
                {growth.map((g) => (
                    <div key={g.date} className="flex flex-1 flex-col items-center justify-end gap-[2px]" title={`${g.date}: ${g.users} users, ${g.companies} companies`}>
                        <div className="w-full rounded-t-sm" style={{ height: `${(g.users / max) * 100}%`, minHeight: g.users ? 3 : 0, background: 'var(--blanc-accent, #7F42E1)' }} />
                        <div className="w-full rounded-t-sm bg-blue-600" style={{ height: `${(g.companies / max) * 100}%`, minHeight: g.companies ? 3 : 0 }} />
                    </div>
                ))}
            </div>
            <div className="mt-2 flex gap-[3px]">
                {growth.map((g, i) => (
                    <span key={g.date} className="flex-1 text-center text-[10px] text-muted-foreground">{tick(i)}</span>
                ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Day boundaries in UTC.</p>
        </div>
    );
}

export function PlatformStatsTab() {
    const { stats, loading } = usePlatformStats();

    if (loading || !stats) {
        return (
            <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Skeleton className="h-[150px] w-full rounded-2xl" />
                    <Skeleton className="h-[150px] w-full rounded-2xl" />
                </div>
                <Skeleton className="h-[220px] w-full rounded-2xl" />
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <KpiCard icon={Building2} label="Companies" data={stats.companies} />
                <KpiCard icon={UsersIcon} label="Users" data={stats.users} />
            </div>
            <GrowthChart growth={stats.growth} />
        </div>
    );
}
