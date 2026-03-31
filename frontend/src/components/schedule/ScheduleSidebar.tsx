/**
 * ScheduleSidebar — Detail panel for selected schedule item.
 * Sprint 7 Design Refresh: frosted glass, rail visualization, detail sections in cards.
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Briefcase, UserPlus, CheckSquare, ChevronRight } from 'lucide-react';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import type { ScheduleItem } from '../../services/scheduleApi';
import type { SidebarLayer } from '../../hooks/useScheduleData';
import { formatDateTimeInTZ, formatTimeInTZ } from '../../utils/companyTime';

interface ScheduleSidebarProps {
    item: ScheduleItem;
    onClose: () => void;
    onPushLayer?: (layer: SidebarLayer) => void;
    timezone?: string;
    isStackedLayer?: boolean;
}

const ENTITY_LABELS: Record<string, { label: string; icon: React.ElementType; color: string }> = {
    job:  { label: 'Job',  icon: Briefcase,    color: 'var(--sched-job)' },
    lead: { label: 'Lead', icon: UserPlus,     color: 'var(--sched-lead)' },
    task: { label: 'Task', icon: CheckSquare,  color: 'var(--sched-task)' },
};

const ENTITY_BADGE_STYLES: Record<string, React.CSSProperties> = {
    job:  { background: 'var(--sched-job-soft)',  borderColor: 'rgba(47, 99, 216, 0.18)', color: 'var(--sched-job)' },
    lead: { background: 'var(--sched-lead-soft)', borderColor: 'rgba(178, 106, 29, 0.18)', color: 'var(--sched-lead)' },
    task: { background: 'var(--sched-task-soft)', borderColor: 'rgba(27, 139, 99, 0.18)', color: 'var(--sched-task)' },
};

const sectionCard: React.CSSProperties = {
    padding: '16px 16px 18px',
    borderRadius: '20px',
    border: '1px solid rgba(118, 106, 89, 0.14)',
    background: 'rgba(255, 255, 255, 0.5)',
};

const eyebrow: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.14em',
    textTransform: 'uppercase' as const,
    color: 'var(--sched-ink-3)',
    marginBottom: '8px',
};

const infoRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '14px',
    padding: '10px 0',
    borderBottom: '1px dashed rgba(118, 106, 89, 0.16)',
};

function getDetailLink(item: ScheduleItem): string {
    switch (item.entity_type) {
        case 'job':  return `/jobs/${item.entity_id}`;
        case 'lead': return `/leads/${item.entity_id}`;
        default:     return '#';
    }
}

export const ScheduleSidebar: React.FC<ScheduleSidebarProps> = ({ item, onClose, onPushLayer, timezone, isStackedLayer }) => {
    const navigate = useNavigate();
    const entityInfo = ENTITY_LABELS[item.entity_type] ?? ENTITY_LABELS.task;
    const badgeStyle = ENTITY_BADGE_STYLES[item.entity_type] ?? ENTITY_BADGE_STYLES.task;
    const Icon = entityInfo.icon;

    return (
        <div
            className="schedule-sidebar-shell flex-shrink-0 flex flex-col overflow-hidden h-full"
            style={{
                background: 'var(--sched-surface)',
                borderRadius: isStackedLayer ? 0 : undefined,
            }}
        >
            {/* Header */}
            <div
                className="px-6 py-6 pb-5"
                style={{
                    background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.76), rgba(242, 235, 223, 0.52))',
                    borderBottom: '1px solid var(--sched-line)',
                }}
            >
                <div className="flex items-center gap-2.5 mb-3">
                    <span
                        className="inline-flex items-center gap-1 min-h-[28px] px-2.5 rounded-full text-[11px] font-bold tracking-widest uppercase"
                        style={{ ...badgeStyle, border: `1px solid ${badgeStyle.borderColor}` }}
                    >
                        <Icon className="size-3" />
                        {entityInfo.label} #{String(item.entity_id).padStart(6, '0')}
                    </span>
                    {item.status && (
                        <span
                            className="inline-flex items-center min-h-[28px] px-2.5 rounded-full text-xs font-semibold"
                            style={{ background: 'rgba(255, 255, 255, 0.72)', color: 'var(--sched-ink-2)' }}
                        >
                            {item.status}
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={onClose}
                        className="ml-auto w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/50 transition-colors"
                    >
                        <X className="size-4" style={{ color: 'var(--sched-ink-2)' }} />
                    </button>
                </div>
                <h2
                    className="text-[28px] leading-none font-bold mb-1.5"
                    style={{ fontFamily: 'Manrope, sans-serif', letterSpacing: '-0.05em', color: 'var(--sched-ink-1)', margin: '12px 0 6px' }}
                >
                    {item.title}
                </h2>
                {item.subtitle && (
                    <p className="text-sm" style={{ color: 'var(--sched-ink-2)', margin: 0 }}>{item.subtitle}</p>
                )}
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
                {/* Scheduled time + rail */}
                {item.start_at && (
                    <div style={sectionCard}>
                        <p style={eyebrow}>Scheduled</p>
                        <div className="text-lg leading-tight font-semibold" style={{ fontFamily: 'Manrope, sans-serif', letterSpacing: '-0.03em', color: 'var(--sched-ink-1)' }}>
                            {formatDateTimeInTZ(new Date(item.start_at), timezone)}
                        </div>
                        {item.end_at && (
                            <div className="mt-1 text-[13px]" style={{ color: 'var(--sched-ink-2)' }}>
                                {formatTimeInTZ(new Date(item.start_at), timezone)} - {formatTimeInTZ(new Date(item.end_at), timezone)} local time
                            </div>
                        )}
                        {/* Schedule rail visualization */}
                        <div className="grid gap-1.5 mt-3.5" style={{ gridTemplateColumns: '1fr 1.8fr 0.8fr' }}>
                            <div className="h-2.5 rounded-full" style={{ background: 'rgba(118, 106, 89, 0.16)' }} />
                            <div className="h-2.5 rounded-full" style={{ background: 'linear-gradient(90deg, rgba(47, 99, 216, 0.78), rgba(47, 99, 216, 0.46))' }} />
                            <div className="h-2.5 rounded-full" style={{ background: 'rgba(118, 106, 89, 0.16)' }} />
                        </div>
                    </div>
                )}

                {/* Contact info */}
                {(item.customer_name || item.customer_phone || item.customer_email) && (
                    <div style={sectionCard}>
                        <p style={eyebrow}>Contact</p>
                        {item.customer_name && (
                            <div style={infoRow}>
                                <span className="text-[13px]" style={{ color: 'var(--sched-ink-3)' }}>Customer</span>
                                {onPushLayer ? (
                                    <button
                                        type="button"
                                        onClick={() => onPushLayer({
                                            type: 'customer',
                                            data: {
                                                name: item.customer_name,
                                                phone: item.customer_phone,
                                                email: item.customer_email,
                                                address: item.address_summary,
                                                sourceItem: item,
                                            },
                                            title: item.customer_name,
                                        })}
                                        className="flex items-center gap-1 text-right text-[13px] font-semibold hover:underline"
                                        style={{ color: 'var(--sched-job)', background: 'none', border: 'none', cursor: 'pointer' }}
                                    >
                                        {item.customer_name}
                                        <ChevronRight className="size-3 flex-shrink-0" />
                                    </button>
                                ) : (
                                    <span className="text-right text-[13px] font-semibold" style={{ color: 'var(--sched-ink-1)' }}>{item.customer_name}</span>
                                )}
                            </div>
                        )}
                        {item.customer_phone && (
                            <div style={infoRow}>
                                <span className="text-[13px]" style={{ color: 'var(--sched-ink-3)' }}>Phone</span>
                                <div className="flex items-center gap-2">
                                    <span className="text-right text-[13px] font-semibold" style={{ color: 'var(--sched-ink-1)' }}>{item.customer_phone}</span>
                                    <ClickToCallButton phone={item.customer_phone} contactName={item.customer_name} inline />
                                </div>
                            </div>
                        )}
                        {item.customer_email && (
                            <div style={{ ...infoRow, borderBottom: 0, paddingBottom: 0 }}>
                                <span className="text-[13px]" style={{ color: 'var(--sched-ink-3)' }}>Email</span>
                                <span className="text-right text-[13px] font-semibold truncate" style={{ color: 'var(--sched-ink-1)' }}>{item.customer_email}</span>
                            </div>
                        )}
                    </div>
                )}

                {/* Address */}
                {item.address_summary && (
                    <div style={sectionCard}>
                        <p style={eyebrow}>Location</p>
                        <div className="text-lg leading-tight font-semibold" style={{ fontFamily: 'Manrope, sans-serif', letterSpacing: '-0.03em', color: 'var(--sched-ink-1)' }}>
                            {item.address_summary}
                        </div>
                    </div>
                )}

                {/* Assigned crew */}
                <div style={sectionCard}>
                    <p style={eyebrow}>Providers</p>
                    <div className="flex flex-wrap gap-2.5">
                        {item.assigned_techs && item.assigned_techs.length > 0 ? (
                            item.assigned_techs.map((tech: any) => (
                                onPushLayer ? (
                                    <button
                                        key={tech.id || tech.name}
                                        type="button"
                                        onClick={() => onPushLayer({
                                            type: 'provider',
                                            data: { id: tech.id, name: tech.name, sourceItem: item },
                                            title: tech.name,
                                        })}
                                        className="inline-flex items-center gap-1 min-h-[34px] px-3.5 rounded-full text-[13px] font-medium hover:shadow-md transition-shadow cursor-pointer"
                                        style={{
                                            background: 'rgba(47, 99, 216, 0.08)',
                                            border: '1px solid rgba(47, 99, 216, 0.12)',
                                            color: 'var(--sched-job)',
                                        }}
                                    >
                                        {tech.name}
                                        <ChevronRight className="size-3" />
                                    </button>
                                ) : (
                                    <span
                                        key={tech.id || tech.name}
                                        className="inline-flex items-center justify-center min-h-[34px] px-3.5 rounded-full text-[13px] font-medium"
                                        style={{
                                            background: 'rgba(47, 99, 216, 0.08)',
                                            border: '1px solid rgba(47, 99, 216, 0.12)',
                                            color: 'var(--sched-job)',
                                        }}
                                    >
                                        {tech.name}
                                    </span>
                                )
                            ))
                        ) : (
                            <span
                                className="inline-flex items-center justify-center min-h-[34px] px-3.5 rounded-full text-[13px] font-medium italic"
                                style={{
                                    background: 'rgba(243, 244, 246, 0.7)',
                                    border: '1px solid rgba(107, 114, 128, 0.18)',
                                    color: 'var(--sched-ink-3)',
                                }}
                            >
                                Unassigned
                            </span>
                        )}
                    </div>
                </div>

                {/* Tags */}
                {item.tags && item.tags.length > 0 && (
                    <div style={sectionCard}>
                        <p style={eyebrow}>Tags</p>
                        <div className="flex flex-wrap gap-2.5">
                            {item.tags.map(tag => (
                                <span
                                    key={tag}
                                    className="inline-flex items-center justify-center min-h-[34px] px-3.5 rounded-full text-[13px] font-medium"
                                    style={{
                                        background: 'rgba(255, 255, 255, 0.72)',
                                        border: '1px solid var(--sched-line)',
                                        color: 'var(--sched-ink-2)',
                                    }}
                                >
                                    {tag}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {/* Actions */}
                <div style={sectionCard}>
                    <p style={eyebrow}>Actions</p>
                    <div className="space-y-2.5">
                        <button
                            type="button"
                            onClick={() => navigate(getDetailLink(item))}
                            className="w-full min-h-[44px] text-sm font-bold"
                            style={{
                                background: 'linear-gradient(180deg, #365fd8, #234aa8)',
                                color: '#fff',
                                borderRadius: '14px',
                                boxShadow: '0 12px 24px rgba(36, 74, 168, 0.22)',
                                border: 'none',
                            }}
                        >
                            Open {entityInfo.label} detail
                        </button>
                        <button
                            type="button"
                            onClick={() => navigate(`/pulse?search=${encodeURIComponent(item.customer_phone || item.customer_name || '')}`)}
                            className="w-full min-h-[44px] text-sm font-bold"
                            style={{
                                background: 'rgba(255, 255, 255, 0.74)',
                                border: '1px solid rgba(118, 106, 89, 0.14)',
                                borderRadius: '14px',
                                color: 'var(--sched-ink-1)',
                            }}
                        >
                            Open in Pulse
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
