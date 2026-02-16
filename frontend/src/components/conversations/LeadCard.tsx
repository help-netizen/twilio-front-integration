import React, { useState } from 'react';
import { User, Phone, Mail, MapPin, Briefcase, Calendar, Tag, FileText } from 'lucide-react';
import { useLeadByPhone } from '../../hooks/useLeadByPhone';
import { Skeleton } from '../ui/skeleton';
import { CreateLeadJobWizard } from './CreateLeadJobWizard';
import type { Lead } from '../../types/lead';
import './LeadCard.css';

interface LeadCardProps {
    phone: string;
    callCount?: number;
    hasActiveCall?: boolean;
}

function formatPhoneDisplay(phone: string): string {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10) {
        return `+1 (${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
    } else if (cleaned.length === 11 && cleaned[0] === '1') {
        return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
    }
    return phone;
}

function statusClass(status: string): string {
    const s = status.toLowerCase();
    if (s === 'new' || s === 'submitted') return 'lead-card__status--new';
    if (s === 'contacted' || s === 'qualified') return 'lead-card__status--contacted';
    if (s.includes('proposal') || s === 'negotiation') return 'lead-card__status--proposal';
    if (s === 'converted') return 'lead-card__status--converted';
    if (s === 'lost') return 'lead-card__status--lost';
    return 'lead-card__status--new';
}

function formatDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function buildAddress(lead: Lead): string | null {
    const parts = [lead.Address, lead.City, lead.State, lead.PostalCode].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
}

/* ────────────────────────────────────── */

export function LeadCard({ phone, callCount, hasActiveCall }: LeadCardProps) {
    const { lead, isLoading } = useLeadByPhone(phone);
    const [confirmCall, setConfirmCall] = useState(false);

    if (isLoading) {
        return (
            <div className="lead-card">
                <div className="lead-card__header">
                    <div className="lead-card__header-content">
                        <div className="lead-card__header-left">
                            <Skeleton className="w-16 h-16 rounded-full" />
                            <div>
                                <Skeleton className="h-7 w-48 mb-2" />
                                <Skeleton className="h-4 w-36" />
                            </div>
                        </div>
                    </div>
                </div>
                <div className="lead-card__details">
                    <div className="lead-card__grid">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                    </div>
                </div>
            </div>
        );
    }

    if (!lead) {
        return <CreateLeadJobWizard phone={phone} callCount={callCount} hasActiveCall={hasActiveCall} />;
    }

    const displayName = [lead.FirstName, lead.LastName].filter(Boolean).join(' ') || 'Unknown';
    const displayPhone = formatPhoneDisplay(lead.Phone || phone);
    const address = buildAddress(lead);

    return (
        <div className="lead-card">
            {/* Header */}
            <div className="lead-card__header">
                <div className="lead-card__header-content">
                    <div className="lead-card__header-left">
                        <div className="lead-card__avatar">
                            <User className="lead-card__avatar-icon" />
                        </div>
                        <div>
                            <div className="lead-card__name">{displayName}</div>
                            <div className="lead-card__phone-row">
                                <Phone className="lead-card__phone-icon" />
                                <span className="lead-card__phone-number">{displayPhone}</span>
                            </div>
                        </div>
                    </div>

                    <div className="lead-card__header-right">
                        {hasActiveCall ? (
                            <span
                                className="lead-card__call-btn lead-card__call-btn--disabled"
                                title="Someone is already on a call with this customer, try again later"
                            >
                                <Phone className="lead-card__call-btn-icon" />
                                <span>Call</span>
                            </span>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setConfirmCall(c => !c)}
                                className="lead-card__call-btn"
                                title={`Call ${displayPhone}`}
                            >
                                <Phone className="lead-card__call-btn-icon" />
                                <span>Call</span>
                            </button>
                        )}
                        {callCount !== undefined && (
                            <div className="lead-card__badge">
                                <div className="lead-card__badge-number">{callCount}</div>
                                <div className="lead-card__badge-label">Calls</div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Call confirmation */}
            {confirmCall && (
                <div className="lead-card__confirm-call">
                    <span className="lead-card__confirm-label">Call {displayPhone}?</span>
                    <div className="lead-card__confirm-actions">
                        <button
                            type="button"
                            className="lead-card__confirm-cancel"
                            onClick={() => setConfirmCall(false)}
                        >
                            Cancel
                        </button>
                        <a
                            href={`tel:${phone}`}
                            className="lead-card__confirm-btn"
                            onClick={() => setConfirmCall(false)}
                        >
                            <Phone className="lead-card__call-btn-icon" />
                            Call Now
                        </a>
                    </div>
                </div>
            )}

            {/* Details */}
            <div className="lead-card__details">
                <div className="lead-card__grid">
                    {/* Status */}
                    <InfoItem icon={<Tag />} label="Status">
                        <span className={`lead-card__status-badge ${statusClass(lead.Status)}`}>
                            {lead.Status}
                        </span>
                    </InfoItem>

                    {/* Email */}
                    {lead.Email && (
                        <InfoItem icon={<Mail />} label="Email">
                            <a href={`mailto:${lead.Email}`} className="lead-card__email-link">
                                {lead.Email}
                            </a>
                        </InfoItem>
                    )}

                    {/* Job Type */}
                    {lead.JobType && (
                        <InfoItem icon={<Briefcase />} label="Job Type">
                            <span className="lead-card__value--semibold">{lead.JobType}</span>
                        </InfoItem>
                    )}

                    {/* Source */}
                    {lead.JobSource && (
                        <InfoItem icon={<FileText />} label="Source">
                            {lead.JobSource}
                        </InfoItem>
                    )}

                    {/* Address */}
                    {address && (
                        <InfoItem icon={<MapPin />} label="Address" span2>
                            {address}
                        </InfoItem>
                    )}

                    {/* Created */}
                    <InfoItem icon={<Calendar />} label="Created">
                        {formatDate(lead.CreatedDate)}
                    </InfoItem>
                </div>
            </div>
        </div>
    );
}

/* ── Reusable info row ─────────────────────────────────────────────────── */

function InfoItem({
    icon,
    label,
    children,
    span2,
}: {
    icon: React.ReactNode;
    label: string;
    children: React.ReactNode;
    span2?: boolean;
}) {
    return (
        <div className={`lead-card__item ${span2 ? 'lead-card__grid-span2' : ''}`}>
            <div className="lead-card__icon-box">
                <span className="lead-card__icon">{icon}</span>
            </div>
            <div className="lead-card__item-content">
                <div className="lead-card__label">{label}</div>
                <div className="lead-card__value">{children}</div>
            </div>
        </div>
    );
}

