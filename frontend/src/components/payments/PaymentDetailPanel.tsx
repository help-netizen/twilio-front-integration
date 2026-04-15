/**
 * PaymentDetailPanel — two-column layout matching Job/Lead/Contact panels.
 *
 * LEFT:  Header (amount + client + status pills) → Invoice tile → Job tile → Provider tile
 * RIGHT: Attachments gallery → Metadata → Check deposit
 */
import { useState, useEffect, useRef } from 'react';
import {
    Loader2, FileText, ChevronDown, ChevronLeft, ChevronRight as ChevronRightIcon,
    ExternalLink, RotateCcw, Receipt,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import type { PaymentDetail } from './paymentTypes';
import { formatPaymentDate, formatCurrency } from './paymentTypes';

// ─── Shared tile styles ──────────────────────────────────────────────────────

const sectionCard: React.CSSProperties = {
    padding: '16px 16px 18px',
    borderRadius: '20px',
    border: '1px solid rgba(117, 106, 89, 0.14)',
    background: 'rgba(255, 255, 255, 0.5)',
};

const eyebrow: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.14em',
    textTransform: 'uppercase' as const,
    color: 'var(--blanc-ink-3)',
    marginBottom: '8px',
};

const infoRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 0',
    borderBottom: '1px dashed rgba(117, 106, 89, 0.16)',
};

const infoLabel: React.CSSProperties = {
    fontSize: '13px',
    color: 'var(--blanc-ink-3)',
    flexShrink: 0,
    width: '72px',
};

// ─── Status colors ───────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
    'succeeded': '#1B8B63', 'paid': '#1B8B63',
    'failed': '#EF4444', 'refunded': '#EF4444', 'voided': '#EF4444',
    'pending': '#F59E0B', 'processing': '#F59E0B',
};

function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function statusPill(label: string) {
    const color = STATUS_COLORS[label.toLowerCase()] || '#6B7280';
    return (
        <span
            className="inline-flex items-center px-3 text-xs font-semibold"
            style={{ background: hexToRgba(color, 0.1), color, minHeight: 28, borderRadius: 8 }}
        >
            {label}
        </span>
    );
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PaymentDetailPanel({
    detail, loading, onClose: _onClose, onToggleDeposited,
}: {
    detail: PaymentDetail | null;
    loading: boolean;
    onClose: () => void;
    onToggleDeposited: (deposited: boolean) => void;
}) {
    const navigate = useNavigate();
    const [showMetadata, setShowMetadata] = useState(false);
    const [galleryIndex, setGalleryIndex] = useState(0);
    const [rotation, setRotation] = useState(0);
    const [showLargePreview, setShowLargePreview] = useState(false);

    useEffect(() => {
        setGalleryIndex(0);
        setShowLargePreview(false);
        setShowMetadata(false);
    }, [detail?.transaction_id]);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full" style={{ color: 'var(--blanc-ink-3)' }}>
                <Loader2 className="size-5 animate-spin" />
            </div>
        );
    }

    if (!detail) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3" style={{ color: 'var(--blanc-ink-3)' }}>
                <Receipt className="size-10 opacity-20" />
                <p className="text-sm">Unable to load payment details.</p>
            </div>
        );
    }

    const allAttachments = detail.attachments || [];
    const method = detail.display_payment_method || detail.payment_methods || '';
    const isCheck = method.toLowerCase() === 'check';

    return (
        <div className="flex flex-col h-full overflow-y-auto">

            {/* ═══ TOP: Header + Tiles (two-column on desktop) ═══ */}
            <div className="flex flex-col md:flex-row">

            {/* LEFT: Header + Tiles */}
            <div className="w-full md:w-1/2 flex flex-col">
                {/* Header */}
                <div className="px-5 pt-5 pb-3">
                    <div className="mb-2">
                        <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--blanc-ink-3)', letterSpacing: '0.12em' }}>
                            Payment {method && `· ${method}`} · {formatPaymentDate(detail.payment_date)}
                        </span>
                    </div>
                    <h2
                        className="text-2xl font-bold leading-tight mb-1"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)', letterSpacing: '-0.03em' }}
                    >
                        {formatCurrency(detail.amount_paid)}
                    </h2>
                    <p className="text-sm mb-3" style={{ color: 'var(--blanc-ink-2)' }}>
                        Paid by <strong style={{ color: 'var(--blanc-ink-1)' }}>{detail.client}</strong> for <strong style={{ color: 'var(--blanc-ink-1)' }}>#{detail.job_number}</strong>
                    </p>
                    {/* Status pills */}
                    <div className="flex items-center gap-2 flex-wrap">
                        {statusPill(detail.transaction_status)}
                        {detail.invoice && statusPill(detail.invoice.paid_in_full ? 'Paid In Full' : `Due: ${formatCurrency(detail.invoice.amount_due)}`)}
                        {isCheck && (
                            <Popover>
                                <PopoverTrigger asChild>
                                    <button
                                        className="inline-flex items-center px-3 text-xs font-semibold cursor-pointer"
                                        style={{
                                            background: hexToRgba(detail.check_deposited ? '#1B8B63' : '#EF4444', 0.1),
                                            color: detail.check_deposited ? '#1B8B63' : '#EF4444',
                                            minHeight: 28, borderRadius: 8, border: 'none',
                                        }}
                                    >
                                        {detail.check_deposited ? 'Deposited' : 'Not Deposited'}
                                    </button>
                                </PopoverTrigger>
                                <PopoverContent className="w-auto p-1" align="start">
                                    <button className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded text-sm hover:bg-muted" onClick={() => onToggleDeposited(true)}>
                                        <span className="size-2 rounded-full" style={{ background: '#1B8B63' }} /> Deposited
                                    </button>
                                    <button className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded text-sm hover:bg-muted" onClick={() => onToggleDeposited(false)}>
                                        <span className="size-2 rounded-full" style={{ background: '#EF4444' }} /> Not Deposited
                                    </button>
                                </PopoverContent>
                            </Popover>
                        )}
                    </div>
                </div>

                {/* Warning */}
                {detail._warning && (
                    <div className="mx-5 mb-3 px-3 py-2 rounded-xl text-[12px]" style={{ background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.2)', color: 'var(--blanc-ink-2)' }}>
                        {detail._warning}
                    </div>
                )}

                {/* Tiles */}
                <div className="px-4 py-4 space-y-3">
                    {/* Invoice tile */}
                    {detail.invoice && (
                        <div style={sectionCard}>
                            <p style={eyebrow}>Invoice</p>
                            <div style={infoRow}>
                                <span style={infoLabel}>Total</span>
                                <span className="text-[13px] font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>{formatCurrency(detail.invoice.total)}</span>
                            </div>
                            <div style={infoRow}>
                                <span style={infoLabel}>Paid</span>
                                <span className="text-[13px] font-semibold" style={{ color: '#1B8B63' }}>{formatCurrency(detail.invoice.amount_paid)}</span>
                            </div>
                            <div style={{ ...infoRow, borderBottom: 'none', paddingBottom: 0 }}>
                                <span style={infoLabel}>Due</span>
                                <span className="text-[13px] font-semibold" style={{ color: parseFloat(detail.invoice.amount_due) > 0 ? '#EF4444' : 'var(--blanc-ink-1)' }}>
                                    {formatCurrency(detail.invoice.amount_due)}
                                </span>
                            </div>
                        </div>
                    )}

                </div>

            </div>

            {/* RIGHT: Job + Providers + Metadata */}
            <div className="w-full md:w-1/2 flex flex-col px-4 py-4 space-y-3">
                {/* Job tile */}
                {detail.job && (
                    <div
                        style={{ ...sectionCard, cursor: detail.local_job_id ? 'pointer' : 'default' }}
                        onClick={() => detail.local_job_id && navigate(`/jobs/${detail.local_job_id}`)}
                        className={detail.local_job_id ? 'transition-opacity hover:opacity-80' : ''}
                    >
                        <p style={eyebrow}>Job</p>
                        <div
                            className="text-[15px] leading-snug font-semibold"
                            style={{ fontFamily: 'var(--blanc-font-heading)', letterSpacing: '-0.02em', color: 'var(--blanc-ink-1)' }}
                        >
                            {detail.job.job_number && `#${detail.job.job_number}`}
                            {detail.job.service_name && ` · ${detail.job.service_name}`}
                        </div>
                        {detail.job.service_address && (
                            <div className="text-[13px] mt-1" style={{ color: 'var(--blanc-ink-2)' }}>
                                {detail.job.service_address}
                            </div>
                        )}
                    </div>
                )}

                {/* Provider tile */}
                {detail.job && detail.job.providers.length > 0 && (
                    <div style={sectionCard}>
                        <p style={eyebrow}>Providers</p>
                        <div className="flex flex-wrap gap-2">
                            {detail.job.providers.map((p, i) => (
                                <span
                                    key={i}
                                    className="inline-flex items-center gap-1 min-h-[34px] px-3.5 rounded-full text-[13px] font-medium"
                                    style={{ background: 'rgba(117, 106, 89, 0.07)', border: '1px solid rgba(117, 106, 89, 0.14)', color: 'var(--blanc-ink-1)' }}
                                >
                                    {p.name}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                <MetadataSection metadata={detail.metadata} showMetadata={showMetadata} setShowMetadata={setShowMetadata} />
            </div>

            </div>

            {/* ═══ BOTTOM: Attachments (full width) ═══ */}
            <div className="px-4 pb-4">
                <AttachmentsSection
                    attachments={allAttachments}
                    galleryIndex={galleryIndex} setGalleryIndex={setGalleryIndex}
                    rotation={rotation} setRotation={setRotation}
                    showLargePreview={showLargePreview} setShowLargePreview={setShowLargePreview}
                />
            </div>
        </div>
    );
}

// ─── Attachments Section ─────────────────────────────────────────────────────

function AttachmentsSection({ attachments, galleryIndex, setGalleryIndex, rotation, setRotation, showLargePreview, setShowLargePreview }: {
    attachments: PaymentDetail['attachments'];
    galleryIndex: number; setGalleryIndex: (v: number | ((n: number) => number)) => void;
    rotation: number; setRotation: (v: number | ((n: number) => number)) => void;
    showLargePreview: boolean; setShowLargePreview: (v: boolean) => void;
}) {
    const [fullscreen, setFullscreen] = useState(false);

    if (attachments.length === 0) return null;

    return (
        <div>
            <p style={eyebrow}>Attachments ({attachments.length})</p>
            <div className="flex gap-2 overflow-x-auto pb-1">
                {attachments.map((att, i) => (
                    <button
                        key={i}
                        onClick={() => { setGalleryIndex(i); setShowLargePreview(true); setRotation(0); }}
                        className="shrink-0 overflow-hidden transition-all"
                        style={{
                            width: 56, height: 56, borderRadius: 10,
                            border: galleryIndex === i && showLargePreview ? '2px solid var(--blanc-info)' : '1px solid var(--blanc-line)',
                            background: 'rgba(117,106,89,0.04)',
                        }}
                    >
                        {att.kind === 'image' ? (
                            <img src={att.url} alt={att.filename} className="w-full h-full object-cover" />
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full text-[9px] font-semibold" style={{ color: 'var(--blanc-ink-3)' }}>
                                <FileText className="size-4 mb-0.5" />
                                {att.filename.split('.').pop()?.toUpperCase()}
                            </div>
                        )}
                    </button>
                ))}
            </div>
            {showLargePreview && attachments[galleryIndex] && (
                <div className="mt-2 rounded-xl overflow-hidden" style={{ border: '1px solid var(--blanc-line)' }}>
                    <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--blanc-line)', background: 'var(--blanc-surface-strong)' }}>
                        <button disabled={galleryIndex === 0} onClick={() => { setGalleryIndex(i => i - 1); setRotation(0); }} className="p-1 disabled:opacity-30"><ChevronLeft className="size-4" /></button>
                        <span className="text-[12px] font-medium" style={{ color: 'var(--blanc-ink-2)' }}>{galleryIndex + 1} / {attachments.length}</span>
                        <button disabled={galleryIndex >= attachments.length - 1} onClick={() => { setGalleryIndex(i => i + 1); setRotation(0); }} className="p-1 disabled:opacity-30"><ChevronRightIcon className="size-4" /></button>
                        <button onClick={() => setRotation(r => r - 90)} className="p-1 ml-auto" style={{ color: 'var(--blanc-ink-3)' }}><RotateCcw className="size-3.5" /></button>
                        <a href={attachments[galleryIndex].url} target="_blank" rel="noopener noreferrer" className="p-1" style={{ color: 'var(--blanc-info)' }}><ExternalLink className="size-3.5" /></a>
                    </div>
                    <div
                        className="flex items-center justify-center p-3"
                        style={{ background: 'rgba(30,30,30,0.95)', minHeight: 200, overflow: 'hidden', cursor: attachments[galleryIndex].kind === 'image' ? 'zoom-in' : undefined }}
                        onClick={() => { if (attachments[galleryIndex].kind === 'image') setFullscreen(true); }}
                    >
                        {attachments[galleryIndex].kind === 'image' ? (
                            <RotatableImage
                                src={attachments[galleryIndex].url}
                                alt={attachments[galleryIndex].filename}
                                rotation={rotation}
                            />
                        ) : (
                            <div className="flex flex-col items-center gap-2 text-white/60">
                                <FileText className="size-10" />
                                <span className="text-sm">{attachments[galleryIndex].filename}</span>
                                <a href={attachments[galleryIndex].url} target="_blank" rel="noopener noreferrer" className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'var(--blanc-info)', color: '#fff' }}>Open File</a>
                            </div>
                        )}
                    </div>
                </div>
            )}
            {fullscreen && attachments[galleryIndex]?.kind === 'image' && (
                <FullscreenViewer
                    attachments={attachments}
                    index={galleryIndex}
                    setIndex={setGalleryIndex}
                    rotation={rotation}
                    setRotation={setRotation}
                    onClose={() => setFullscreen(false)}
                />
            )}
        </div>
    );
}

// ─── Fullscreen Image Viewer ─────────────────────────────────────────────────

function FullscreenViewer({ attachments, index, setIndex, rotation, setRotation, onClose }: {
    attachments: PaymentDetail['attachments'];
    index: number;
    setIndex: (v: number | ((n: number) => number)) => void;
    rotation: number;
    setRotation: (v: number | ((n: number) => number)) => void;
    onClose: () => void;
}) {
    const imageAttachments = attachments.filter(a => a.kind === 'image');
    const currentAtt = attachments[index];

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose();
        if (e.key === 'ArrowLeft' && index > 0) { setIndex(i => i - 1); setRotation(0); }
        if (e.key === 'ArrowRight' && index < attachments.length - 1) { setIndex(i => i + 1); setRotation(0); }
    }, [index, attachments.length, onClose, setIndex, setRotation]);

    useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = '';
        };
    }, [handleKeyDown]);

    return (
        <div
            className="fixed inset-0 z-[9999] flex flex-col"
            style={{ background: 'rgba(0,0,0,0.92)' }}
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            {/* Top bar */}
            <div className="flex items-center gap-3 px-4 py-3 shrink-0">
                <span className="text-white/70 text-sm font-medium">{index + 1} / {attachments.length}</span>
                <div className="flex items-center gap-1 ml-auto">
                    <button onClick={() => setRotation(r => r - 90)} className="p-2 rounded-lg hover:bg-white/10 transition-colors" title="Rotate">
                        <RotateCcw className="size-4 text-white/70" />
                    </button>
                    <a href={currentAtt.url} target="_blank" rel="noopener noreferrer" className="p-2 rounded-lg hover:bg-white/10 transition-colors" title="Open original">
                        <ExternalLink className="size-4 text-white/70" />
                    </a>
                    <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10 transition-colors" title="Close">
                        <X className="size-4 text-white/70" />
                    </button>
                </div>
            </div>

            {/* Image area */}
            <div className="flex-1 flex items-center justify-center min-h-0 px-12 pb-4 relative">
                {/* Prev */}
                <button
                    disabled={index === 0}
                    onClick={(e) => { e.stopPropagation(); setIndex(i => i - 1); setRotation(0); }}
                    className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full hover:bg-white/10 transition-colors disabled:opacity-20"
                >
                    <ChevronLeft className="size-6 text-white" />
                </button>

                <RotatableImage
                    src={currentAtt.url}
                    alt={currentAtt.filename}
                    rotation={rotation}
                    fullscreen
                />

                {/* Next */}
                <button
                    disabled={index >= attachments.length - 1}
                    onClick={(e) => { e.stopPropagation(); setIndex(i => i + 1); setRotation(0); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full hover:bg-white/10 transition-colors disabled:opacity-20"
                >
                    <ChevronRightIcon className="size-6 text-white" />
                </button>
            </div>

            {/* Thumbnail strip */}
            {imageAttachments.length > 1 && (
                <div className="flex justify-center gap-2 px-4 pb-4 shrink-0">
                    {attachments.map((att, i) => att.kind === 'image' ? (
                        <button
                            key={i}
                            onClick={() => { setIndex(i); setRotation(0); }}
                            className="shrink-0 overflow-hidden rounded-lg transition-all"
                            style={{
                                width: 48, height: 48,
                                border: i === index ? '2px solid var(--blanc-info)' : '1px solid rgba(255,255,255,0.15)',
                                opacity: i === index ? 1 : 0.5,
                            }}
                        >
                            <img src={att.url} alt={att.filename} className="w-full h-full object-cover" />
                        </button>
                    ) : null)}
                </div>
            )}
        </div>
    );
}

// ─── RotatableImage — fits container width even when rotated 90/270 ──────────

function RotatableImage({ src, alt, rotation, fullscreen }: { src: string; alt: string; rotation: number; fullscreen?: boolean }) {
    const imgRef = useRef<HTMLImageElement>(null);
    const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });

    const norm = ((rotation % 360) + 360) % 360;
    const isRotatedSideways = norm === 90 || norm === 270;

    const handleLoad = () => {
        if (imgRef.current) {
            setNaturalSize({ w: imgRef.current.naturalWidth, h: imgRef.current.naturalHeight });
        }
    };

    // When rotated 90°/270°, CSS transform swaps visual axes:
    //   visual width = CSS height, visual height = CSS width
    // Image has width:100% → CSS width = containerW, CSS height = containerW * nH/nW (auto)
    // After rotate, visual width = containerW * nH/nW — too narrow or too wide.
    // scale(nW/nH) compensates: visual width = containerW * nH/nW * nW/nH = containerW ✓
    // Wrapper aspect-ratio = nH/nW to match the visual height after rotation.

    let imgStyle: React.CSSProperties;
    let wrapperStyle: React.CSSProperties;

    if (isRotatedSideways && naturalSize.w && naturalSize.h) {
        const scale = naturalSize.w / naturalSize.h;
        wrapperStyle = {
            width: '100%',
            aspectRatio: `${naturalSize.h} / ${naturalSize.w}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
        };
        imgStyle = {
            width: '100%',
            transform: `rotate(${rotation}deg) scale(${scale})`,
            transformOrigin: 'center center',
            transition: 'transform 0.2s ease',
        };
    } else {
        wrapperStyle = {
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
        };
        imgStyle = {
            maxWidth: '100%',
            maxHeight: fullscreen ? '85vh' : '70vh',
            objectFit: 'contain',
            transform: rotation ? `rotate(${rotation}deg)` : undefined,
            transformOrigin: 'center center',
            transition: 'transform 0.2s ease',
        };
    }

    return (
        <div style={wrapperStyle}>
            <img
                ref={imgRef}
                src={src}
                alt={alt}
                onLoad={handleLoad}
                className="rounded"
                style={imgStyle}
            />
        </div>
    );
}

// ─── Metadata Section ────────────────────────────────────────────────────────

function MetadataSection({ metadata, showMetadata, setShowMetadata }: {
    metadata: Record<string, string | null> | null | undefined;
    showMetadata: boolean;
    setShowMetadata: (v: boolean) => void;
}) {
    if (!metadata || Object.keys(metadata).length === 0) return null;

    return (
        <div>
            <button
                onClick={() => setShowMetadata(!showMetadata)}
                className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest transition-opacity hover:opacity-70"
                style={{ color: 'var(--blanc-ink-3)', letterSpacing: '0.14em', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
                <ChevronDown className="size-3" style={{ transform: showMetadata ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} />
                Transaction Metadata
            </button>
            {showMetadata && (
                <div className="mt-2 space-y-1">
                    {Object.entries(metadata).map(([key, val]) => val ? (
                        <div key={key} className="flex gap-2 text-[12px]">
                            <span style={{ color: 'var(--blanc-ink-3)', minWidth: 100, textTransform: 'capitalize' as const }}>{key.replace(/_/g, ' ')}</span>
                            <span className="font-mono text-[11px]" style={{ color: 'var(--blanc-ink-1)', wordBreak: 'break-all' as const }}>{val}</span>
                        </div>
                    ) : null)}
                </div>
            )}
        </div>
    );
}
