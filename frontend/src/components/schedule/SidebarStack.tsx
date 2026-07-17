/**
 * SidebarStack — Fixed-position sidebar with "rabbit hole" layer stacking.
 * Desktop: fixed right panel. Mobile/tablet: overlay with backdrop.
 * Layers stack visually with peek strips for underlying layers.
 */

import React, { useState, useEffect } from 'react';
import { X, Phone, Mail, MapPin, User } from 'lucide-react';
import type { SidebarLayer } from '../../hooks/useScheduleData';
import type { ScheduleItem } from '../../services/scheduleApi';
import { ScheduleSidebar } from './ScheduleSidebar';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { getProviderColor } from '../../utils/providerColors';

interface SidebarStackProps {
    stack: SidebarLayer[];
    onPopLayer: () => void;
    onClearStack: () => void;
    onPushLayer: (layer: SidebarLayer) => void;
    timezone?: string;
}

const LAYER_PEEK = 10; // px visible for each underlying layer

const sectionCard: React.CSSProperties = {
    padding: '16px 16px 18px',
    borderRadius: '20px',
    border: '1px solid rgba(118, 106, 89, 0.14)',
    background: 'rgba(255, 255, 255, 0.5)',
};

const sectionEyebrow: React.CSSProperties = {
    fontSize: '11px', fontWeight: 600, letterSpacing: '0.14em',
    textTransform: 'uppercase' as const, color: 'var(--sched-ink-3)', marginBottom: '8px',
};

const sectionRow: React.CSSProperties = {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    gap: '14px', padding: '10px 0', borderBottom: '1px dashed rgba(118, 106, 89, 0.16)',
};

export const SidebarStack: React.FC<SidebarStackProps> = ({
    stack, onPopLayer, onClearStack, onPushLayer, timezone,
}) => {
    const [hoverStack, setHoverStack] = useState(false);
    const [isMobile, setIsMobile] = useState(false);

    useEffect(() => {
        const check = () => setIsMobile(window.innerWidth <= 1024);
        check();
        window.addEventListener('resize', check);
        return () => window.removeEventListener('resize', check);
    }, []);

    // Close on Escape
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (stack.length > 1) onPopLayer();
                else onClearStack();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [stack.length, onPopLayer, onClearStack]);

    if (stack.length === 0) return null;

    const totalPeek = (stack.length - 1) * LAYER_PEEK;

    const renderLayerContent = (layer: SidebarLayer, index: number) => {
        if (layer.type === 'schedule-item') {
            return (
                <ScheduleSidebar
                    item={layer.data as ScheduleItem}
                    onClose={index === 0 ? onClearStack : onPopLayer}
                    onPushLayer={onPushLayer}
                    timezone={timezone}
                    isStackedLayer={index < stack.length - 1}
                />
            );
        }
        if (layer.type === 'customer') {
            const d = layer.data as Record<string, any>;
            return (
                <div className="flex flex-col h-full overflow-hidden" style={{ background: 'var(--sched-surface)' }}>
                    {/* Header */}
                    <div className="px-6 py-6 pb-5" style={{
                        background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.76), rgba(242, 235, 223, 0.52))',
                        borderBottom: '1px solid var(--sched-line)',
                    }}>
                        <div className="flex items-center justify-between mb-3">
                            <span className="inline-flex items-center gap-1 min-h-[28px] px-2.5 rounded-full text-[11px] font-bold tracking-widest uppercase"
                                style={{ background: 'rgba(47, 99, 216, 0.08)', border: '1px solid rgba(47, 99, 216, 0.14)', color: 'var(--sched-job)' }}>
                                <User className="size-3" /> Customer
                            </span>
                            <button type="button" onClick={index === 0 ? onClearStack : onPopLayer}
                                className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/50 transition-colors lg:hidden">
                                <X className="size-4" style={{ color: 'var(--sched-ink-2)' }} />
                            </button>
                        </div>
                        <h2 className="text-[28px] leading-none font-bold"
                            style={{ fontFamily: 'Manrope, sans-serif', letterSpacing: '-0.05em', color: 'var(--sched-ink-1)', margin: '12px 0 0' }}>
                            {d.name}
                        </h2>
                    </div>
                    {/* Content */}
                    <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
                        {/* Contact card */}
                        <div style={sectionCard}>
                            <p style={sectionEyebrow}>Contact info</p>
                            {d.phone && (
                                <div style={sectionRow}>
                                    <span className="flex items-center gap-1.5 text-[13px]" style={{ color: 'var(--sched-ink-3)' }}>
                                        <Phone className="size-3" /> Phone
                                    </span>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[13px] font-semibold" style={{ color: 'var(--sched-ink-1)' }}>{d.phone}</span>
                                        <ClickToCallButton phone={d.phone} contactName={d.name} inline />
                                    </div>
                                </div>
                            )}
                            {d.email && (
                                <div style={sectionRow}>
                                    <span className="flex items-center gap-1.5 text-[13px]" style={{ color: 'var(--sched-ink-3)' }}>
                                        <Mail className="size-3" /> Email
                                    </span>
                                    <a href={`mailto:${d.email}`} className="text-[13px] font-semibold truncate hover:underline"
                                        style={{ color: 'var(--sched-job)' }}>{d.email}</a>
                                </div>
                            )}
                            {d.address && (
                                <div style={{ ...sectionRow, borderBottom: 'none', paddingBottom: 0 }}>
                                    <span className="flex items-center gap-1.5 text-[13px]" style={{ color: 'var(--sched-ink-3)' }}>
                                        <MapPin className="size-3" /> Address
                                    </span>
                                    <span className="text-[13px] font-semibold text-right" style={{ color: 'var(--sched-ink-1)' }}>{d.address}</span>
                                </div>
                            )}
                        </div>
                        {/* Source item reference */}
                        {d.sourceItem && (
                            <div style={sectionCard}>
                                <p style={sectionEyebrow}>Opened from</p>
                                <button type="button" onClick={onPopLayer}
                                    className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-white/60 transition-colors text-[13px] font-semibold"
                                    style={{ color: 'var(--sched-ink-1)', background: 'rgba(255,255,255,0.4)', border: '1px solid var(--sched-line)' }}>
                                    ← {(d.sourceItem as ScheduleItem).title}
                                </button>
                            </div>
                        )}
                        {/* Actions */}
                        <div style={sectionCard}>
                            <p style={sectionEyebrow}>Actions</p>
                            <button type="button"
                                onClick={() => window.open(`/pulse?search=${encodeURIComponent(d.phone || d.name || '')}`, '_self')}
                                className="w-full min-h-[44px] text-sm font-bold"
                                style={{
                                    background: 'linear-gradient(180deg, #365fd8, #234aa8)', color: '#fff',
                                    borderRadius: '14px', boxShadow: '0 12px 24px rgba(36, 74, 168, 0.22)', border: 'none',
                                }}>
                                Open in Pulse
                            </button>
                        </div>
                    </div>
                </div>
            );
        }

        if (layer.type === 'provider') {
            const d = layer.data as Record<string, any>;
            const provColor = getProviderColor(d.id || d.name);
            return (
                <div className="flex flex-col h-full overflow-hidden" style={{ background: 'var(--sched-surface)' }}>
                    {/* Header */}
                    <div className="px-6 py-6 pb-5" style={{
                        background: `linear-gradient(180deg, ${provColor.bg}, rgba(242, 235, 223, 0.52))`,
                        borderBottom: '1px solid var(--sched-line)',
                    }}>
                        <div className="flex items-center justify-between mb-3">
                            <span className="inline-flex items-center gap-1 min-h-[28px] px-2.5 rounded-full text-[11px] font-bold tracking-widest uppercase"
                                style={{ background: provColor.bg, border: `1px solid ${provColor.border}`, color: provColor.text }}>
                                Provider
                            </span>
                            <button type="button" onClick={index === 0 ? onClearStack : onPopLayer}
                                className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/50 transition-colors lg:hidden">
                                <X className="size-4" style={{ color: 'var(--sched-ink-2)' }} />
                            </button>
                        </div>
                        <h2 className="text-[28px] leading-none font-bold"
                            style={{ fontFamily: 'Manrope, sans-serif', letterSpacing: '-0.05em', color: 'var(--sched-ink-1)', margin: '12px 0 0' }}>
                            {d.name}
                        </h2>
                    </div>
                    {/* Content */}
                    <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
                        <div style={sectionCard}>
                            <p style={sectionEyebrow}>Provider details</p>
                            <div style={sectionRow}>
                                <span className="text-[13px]" style={{ color: 'var(--sched-ink-3)' }}>ID</span>
                                <span className="text-[13px] font-semibold" style={{ color: 'var(--sched-ink-1)' }}>{d.id || '—'}</span>
                            </div>
                            <div style={{ ...sectionRow, borderBottom: 'none', paddingBottom: 0 }}>
                                <span className="text-[13px]" style={{ color: 'var(--sched-ink-3)' }}>Color</span>
                                <span className="inline-flex items-center gap-1.5">
                                    <span className="w-4 h-4 rounded-full" style={{ background: provColor.accent }} />
                                    <span className="text-[13px] font-semibold" style={{ color: 'var(--sched-ink-1)' }}>{provColor.accent}</span>
                                </span>
                            </div>
                        </div>
                        {/* Source item reference */}
                        {d.sourceItem && (
                            <div style={sectionCard}>
                                <p style={sectionEyebrow}>Opened from</p>
                                <button type="button" onClick={onPopLayer}
                                    className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-white/60 transition-colors text-[13px] font-semibold"
                                    style={{ color: 'var(--sched-ink-1)', background: 'rgba(255,255,255,0.4)', border: '1px solid var(--sched-line)' }}>
                                    ← {(d.sourceItem as ScheduleItem).title}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            );
        }

        // Fallback
        return (
            <div className="p-6">
                <p className="text-sm" style={{ color: 'var(--sched-ink-2)' }}>
                    {layer.title}
                </p>
            </div>
        );
    };

    // ── Mobile overlay ────────────────────────────────────────────────────
    if (isMobile) {
        return (
            <>
                {/* Backdrop */}
                <div
                    className="fixed inset-0 z-[50]"
                    style={{ background: 'rgba(32, 39, 52, 0.55)', backdropFilter: 'blur(4px)' }}
                    onClick={onClearStack}
                />
                {/* Panel */}
                <div
                    className="fixed z-[51] flex flex-col overflow-hidden"
                    style={{
                        top: 0, right: 0, bottom: 0,
                        width: 'min(90vw, 400px)',
                        animation: 'slideInRight 0.25s ease-out',
                    }}
                >
                    {stack.map((layer, i) => {
                        const isTop = i === stack.length - 1;
                        if (!isTop) return null; // mobile shows only top layer
                        return (
                            <div key={i} className="flex-1 flex flex-col overflow-hidden">
                                {/* Back button for stacked layers */}
                                {stack.length > 1 && (
                                    <button
                                        type="button"
                                        onClick={onPopLayer}
                                        className="flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-semibold"
                                        style={{
                                            background: 'rgba(255, 253, 249, 0.96)',
                                            color: 'var(--sched-ink-2)',
                                            borderBottom: '1px solid var(--sched-line)',
                                        }}
                                    >
                                        <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                                        </svg>
                                        Back · {stack.length - 1} more
                                    </button>
                                )}
                                {renderLayerContent(layer, i)}
                            </div>
                        );
                    })}
                </div>
            </>
        );
    }

    // ── Desktop fixed panel ───────────────────────────────────────────────
    const closeAllZone = 44; // px extra on left for the close-all button hover zone
    return (
        <div
            className="fixed z-[40]"
            style={{
                top: '80px',
                right: '30px',
                bottom: '30px',
                width: `${380 + totalPeek + closeAllZone}px`,
                pointerEvents: 'none',
            }}
            onMouseEnter={() => setHoverStack(true)}
            onMouseLeave={() => setHoverStack(false)}
        >
            {/* Close-all hover zone — invisible area that keeps hover state while cursor moves to the button */}
            {stack.length > 0 && (
                <div
                    style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        width: `${closeAllZone}px`,
                        height: '80px',
                        pointerEvents: 'auto',
                    }}
                >
                    <button
                        type="button"
                        onClick={onClearStack}
                        className="absolute flex items-center justify-center transition-all"
                        style={{
                            left: '8px',
                            top: '12px',
                            width: '28px',
                            height: '28px',
                            borderRadius: '50%',
                            background: hoverStack ? 'var(--sched-ink-1)' : 'transparent',
                            color: hoverStack ? '#fff' : 'transparent',
                            border: hoverStack ? 'none' : '1px solid transparent',
                            opacity: hoverStack ? 1 : 0,
                            boxShadow: hoverStack ? '0 4px 12px rgba(0,0,0,0.15)' : 'none',
                        }}
                        title="Close all"
                    >
                        <X className="size-3.5" />
                    </button>
                </div>
            )}

            {/* Stacked layers */}
            {stack.map((layer, i) => {
                const isTop = i === stack.length - 1;
                const offsetLeft = i * LAYER_PEEK;

                return (
                    <div
                        key={i}
                        className="absolute flex flex-col overflow-hidden"
                        style={{
                            top: 0,
                            bottom: 0,
                            left: `${closeAllZone + offsetLeft}px`,
                            right: 0,
                            width: '380px',
                            zIndex: i + 1,
                            background: 'var(--sched-surface)',
                            border: '1px solid rgba(255, 255, 255, 0.55)',
                            borderRadius: 'var(--sched-radius-xl)',
                            backdropFilter: 'blur(24px)',
                            boxShadow: isTop
                                ? 'var(--sched-shadow-main)'
                                : '-4px 0 16px rgba(48, 39, 28, 0.08)',
                            transition: 'transform 0.2s ease-out, opacity 0.2s ease-out',
                            transform: isTop ? 'none' : 'scale(0.98)',
                            opacity: isTop ? 1 : 0.6,
                            pointerEvents: isTop ? 'auto' : 'none',
                        }}
                    >
                        {isTop ? (
                            renderLayerContent(layer, i)
                        ) : (
                            // Peek strip for underlying layer — just show title
                            <div
                                className="h-full flex items-start pt-6 pl-3"
                                style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
                            >
                                <span
                                    className="text-[11px] font-semibold truncate"
                                    style={{ color: 'var(--sched-ink-3)', maxHeight: '200px' }}
                                >
                                    {layer.title}
                                </span>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};
