import React, { useState } from 'react';
import { User, Phone, Mail, Building2, Calendar, FileText, PhoneForwarded } from 'lucide-react';
import type { Contact } from '../../types/contact';
import '../conversations/LeadCard.css';

interface ContactCardProps {
    contact: Contact;
    phone: string;
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

function formatDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ────────────────────────────────────── */

export function ContactCard({ contact, phone, hasActiveCall }: ContactCardProps) {
    const [confirmCall, setConfirmCall] = useState(false);

    const displayName = contact.full_name || [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Unknown';
    const displayPhone = formatPhoneDisplay(contact.phone_e164 || phone);
    const secondaryPhone = contact.secondary_phone
        ? formatPhoneDisplay(contact.secondary_phone)
        : null;

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
                    {/* Email */}
                    {contact.email && (
                        <InfoItem icon={<Mail />} label="Email">
                            <a href={`mailto:${contact.email}`} className="lead-card__email-link">
                                {contact.email}
                            </a>
                        </InfoItem>
                    )}

                    {/* Company */}
                    {contact.company_name && (
                        <InfoItem icon={<Building2 />} label="Company">
                            <span className="lead-card__value--semibold">{contact.company_name}</span>
                        </InfoItem>
                    )}

                    {/* Secondary Phone */}
                    {secondaryPhone && (
                        <InfoItem icon={<PhoneForwarded />} label={contact.secondary_phone_name || 'Secondary Phone'}>
                            <span className="lead-card__phone-number">{secondaryPhone}</span>
                        </InfoItem>
                    )}

                    {/* Notes */}
                    {contact.notes && (
                        <InfoItem icon={<FileText />} label="Notes" span2>
                            {contact.notes}
                        </InfoItem>
                    )}

                    {/* Created */}
                    <InfoItem icon={<Calendar />} label="Contact Since">
                        {formatDate(contact.created_at)}
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
