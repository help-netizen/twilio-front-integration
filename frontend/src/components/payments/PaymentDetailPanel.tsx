import { useState, useEffect } from 'react';
import {
    Loader2, X, FileText, User2, MapPin, Receipt,
    ChevronDown, ChevronLeft, ChevronRight,
    ImageIcon, ExternalLink, RotateCcw,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import type { PaymentDetail } from './paymentTypes';
import { formatPaymentDate, formatCurrency, paymentMethodIcon } from './paymentTypes';

// ─── Component ───────────────────────────────────────────────────────────────

export function PaymentDetailPanel({
    detail, loading, onClose, onToggleDeposited,
}: {
    detail: PaymentDetail | null;
    loading: boolean;
    onClose: () => void;
    onToggleDeposited: (deposited: boolean) => void;
}) {
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
            <div className="payment-detail-panel">
                <button className="payment-detail-close" onClick={onClose}><X size={18} /></button>
                <div className="payment-detail-loading">
                    <Loader2 size={24} className="animate-spin" style={{ color: '#9ca3af' }} />
                </div>
            </div>
        );
    }

    if (!detail) {
        return (
            <div className="payment-detail-panel">
                <button className="payment-detail-close" onClick={onClose}><X size={18} /></button>
                <div className="payment-detail-empty">
                    <Receipt size={40} style={{ color: '#d1d5db' }} />
                    <p>Unable to load payment details.</p>
                </div>
            </div>
        );
    }

    const allAttachments = detail.attachments;

    return (
        <div className="payment-detail-panel">
            {/* Header */}
            <div className="payment-detail-header">
                <button className="payment-detail-close" onClick={onClose}><X size={18} /></button>
                <div className="payment-detail-header-content">
                    <div className="payment-detail-method-label">
                        <span className="payment-detail-method-icon">{paymentMethodIcon(detail.payment_methods)}</span>
                        {detail.display_payment_method || detail.payment_methods}
                    </div>
                    <div className="payment-detail-amount">{formatCurrency(detail.amount_paid)}</div>
                    <div className="payment-detail-subtitle">
                        Paid by <strong>{detail.client}</strong> for <strong>#{detail.job_number}</strong>
                    </div>
                    <div className="payment-detail-date">{formatPaymentDate(detail.payment_date)}</div>
                    <div className="payment-detail-badges">
                        <span className={`payment-badge ${detail.transaction_status === 'succeeded' ? 'badge-success' : detail.transaction_status === 'voided' ? 'badge-danger' : 'badge-neutral'}`}>
                            {detail.transaction_status}
                        </span>
                        {detail.invoice && (
                            <span className={`payment-badge ${detail.invoice.paid_in_full ? 'badge-success' : 'badge-warning'}`}>
                                {detail.invoice.paid_in_full ? '✓ Paid in Full' : `Invoice: ${detail.invoice.status}`}
                            </span>
                        )}
                        {(detail.display_payment_method || '').toLowerCase() === 'check' && (
                            <Popover>
                                <PopoverTrigger asChild>
                                    <button className={`payment-badge cursor-pointer border-0 ${detail.check_deposited ? 'badge-success' : 'badge-danger'}`}>
                                        {detail.check_deposited ? 'Deposited' : 'Not Deposited'}
                                    </button>
                                </PopoverTrigger>
                                <PopoverContent className="w-auto p-1" align="start">
                                    <button className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded text-sm hover:bg-muted" onClick={() => onToggleDeposited(true)}>
                                        <span className="size-2 rounded-full bg-green-500" /> Deposited
                                    </button>
                                    <button className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded text-sm hover:bg-muted" onClick={() => onToggleDeposited(false)}>
                                        <span className="size-2 rounded-full bg-red-500" /> Not Deposited
                                    </button>
                                </PopoverContent>
                            </Popover>
                        )}
                    </div>
                </div>
            </div>

            {/* Body */}
            <div className="payment-detail-body">
                {detail._warning && (<div className="payment-detail-warning">⚠️ {detail._warning}</div>)}

                {/* Invoice Summary */}
                {detail.invoice && (
                    <div className="payment-detail-section">
                        <h3><Receipt size={14} /> Invoice Summary</h3>
                        <div className="payment-detail-invoice-grid">
                            <div className="invoice-stat"><span className="invoice-stat-label">Total</span><span className="invoice-stat-value">{formatCurrency(detail.invoice.total)}</span></div>
                            <div className="invoice-stat"><span className="invoice-stat-label">Paid</span><span className="invoice-stat-value paid">{formatCurrency(detail.invoice.amount_paid)}</span></div>
                            <div className="invoice-stat"><span className="invoice-stat-label">Due</span><span className={`invoice-stat-value ${parseFloat(detail.invoice.amount_due) > 0 ? 'due' : ''}`}>{formatCurrency(detail.invoice.amount_due)}</span></div>
                            <div className="invoice-stat"><span className="invoice-stat-label">Status</span><span className="invoice-stat-value">{detail.invoice.status}</span></div>
                        </div>
                    </div>
                )}

                {/* Job */}
                {detail.job && (
                    <div className="payment-detail-section">
                        <h3><FileText size={14} /> Job</h3>
                        <div className="payment-detail-job-info">
                            {detail.job.job_number && (<div className="job-info-row"><span className="job-info-label">Job #</span><span className="job-info-value">{detail.job.job_number}</span></div>)}
                            {detail.job.service_name && (<div className="job-info-row"><span className="job-info-label">Service</span><span className="job-info-value">{detail.job.service_name}</span></div>)}
                            {detail.job.service_address && (<div className="job-info-row"><MapPin size={12} className="job-info-icon" /><span className="job-info-value">{detail.job.service_address}</span></div>)}
                        </div>
                    </div>
                )}

                {/* Providers */}
                {detail.job && detail.job.providers.length > 0 && (
                    <div className="payment-detail-section">
                        <h3><User2 size={14} /> Provider{detail.job.providers.length > 1 ? 's' : ''}</h3>
                        <div className="payment-detail-providers">
                            {detail.job.providers.map((p, i) => (
                                <div key={i} className="provider-card">
                                    <div className="provider-avatar">{(p.name || '?')[0].toUpperCase()}</div>
                                    <div className="provider-info">
                                        <div className="provider-name">{p.name || '—'}</div>
                                        {p.email && <div className="provider-contact">{p.email}</div>}
                                        {p.phone && <div className="provider-contact">{p.phone}</div>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Attachments Gallery */}
                <div className="payment-detail-section">
                    <h3><ImageIcon size={14} /> Attachments ({allAttachments.length})</h3>
                    {allAttachments.length === 0 ? (
                        <div className="attachments-empty">No attachments found</div>
                    ) : (
                        <div className="attachments-gallery">
                            <div className="attachments-thumbs">
                                {allAttachments.map((att, i) => (
                                    <button key={i} className={`attachment-thumb ${galleryIndex === i ? 'active' : ''}`} onClick={() => { setGalleryIndex(i); setShowLargePreview(true); }}>
                                        {att.kind === 'image' ? (<img src={att.url} alt={att.filename} />) : (
                                            <div className="attachment-file-thumb"><FileText size={18} /><span>{att.filename.split('.').pop()?.toUpperCase() || 'FILE'}</span></div>
                                        )}
                                    </button>
                                ))}
                            </div>
                            {showLargePreview && allAttachments[galleryIndex] && (
                                <div className="attachments-preview">
                                    <div className="attachments-preview-controls">
                                        <button disabled={galleryIndex === 0} onClick={() => { setGalleryIndex(i => i - 1); setRotation(0); }}><ChevronLeft size={16} /></button>
                                        <span className="attachments-counter">{galleryIndex + 1} / {allAttachments.length}</span>
                                        <button disabled={galleryIndex >= allAttachments.length - 1} onClick={() => { setGalleryIndex(i => i + 1); setRotation(0); }}><ChevronRight size={16} /></button>
                                        <button onClick={() => setRotation(r => r - 90)} title="Rotate 90° counter-clockwise"><RotateCcw size={14} /></button>
                                        <a href={allAttachments[galleryIndex].url} target="_blank" rel="noopener noreferrer" className="attachments-open-link"><ExternalLink size={14} /></a>
                                    </div>
                                    <div className="attachments-preview-content">
                                        {allAttachments[galleryIndex].kind === 'image' ? (
                                            <img src={allAttachments[galleryIndex].url} alt={allAttachments[galleryIndex].filename} style={rotation ? { transform: `rotate(${rotation}deg)` } : undefined} />
                                        ) : (
                                            <div className="attachment-file-preview">
                                                <FileText size={40} /><span>{allAttachments[galleryIndex].filename}</span>
                                                <a href={allAttachments[galleryIndex].url} target="_blank" rel="noopener noreferrer" className="payments-btn payments-btn-secondary">Open File</a>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Transaction Metadata */}
                <div className="payment-detail-section">
                    <button className="payment-metadata-toggle" onClick={() => setShowMetadata(!showMetadata)}>
                        <ChevronDown size={14} className={`metadata-chevron ${showMetadata ? 'open' : ''}`} />
                        Transaction Metadata
                    </button>
                    {showMetadata && detail.metadata && (
                        <div className="payment-metadata-content">
                            {Object.entries(detail.metadata).map(([key, val]) => (
                                val ? (
                                    <div key={key} className="metadata-row">
                                        <span className="metadata-key">{key.replace(/_/g, ' ')}</span>
                                        <span className="metadata-val">{val}</span>
                                    </div>
                                ) : null
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
