import { ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Lead } from '../../types/lead';
import { formatPhoneDisplay as formatPhone } from '../../utils/phoneUtils';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { OpenTimelineButton } from '../softphone/OpenTimelineButton';

// ─── Shared tile styles (mirrors JobInfoSections / ScheduleSidebar) ──────────

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

// ─── Component ───────────────────────────────────────────────────────────────

interface LeadInfoSectionsProps {
    lead: Lead;
}

export function LeadInfoSections({ lead }: LeadInfoSectionsProps) {
    const navigate = useNavigate();

    const name = [lead.FirstName, lead.LastName].filter(Boolean).join(' ') || null;
    const phone = lead.Phone || null;
    const email = lead.Email || null;

    const hasContact = name || phone || email;
    const hasAddress = lead.Address || lead.City;

    const addressParts = [lead.Address, lead.Unit].filter(Boolean).join(', ');
    const cityLine = [lead.City, lead.State ? `${lead.State} ${lead.PostalCode || ''}`.trim() : lead.PostalCode].filter(Boolean).join(', ');

    return (
        <div className="px-4 py-4 space-y-3">

            {/* ── CONTACT ── */}
            {hasContact && (
                <div style={sectionCard}>
                    <p style={eyebrow}>Contact</p>
                    {name && (
                        <div style={infoRow}>
                            <span style={infoLabel}>Customer</span>
                            {lead.ContactId ? (
                                <button
                                    type="button"
                                    onClick={() => navigate(`/contacts/${lead.ContactId}`)}
                                    className="flex items-center gap-1 text-[13px] font-semibold hover:underline"
                                    style={{ color: 'var(--blanc-info)', background: 'none', border: 'none', cursor: 'pointer' }}
                                >
                                    {name}
                                    <ChevronRight className="size-3 flex-shrink-0" />
                                </button>
                            ) : (
                                <span className="text-[13px] font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>{name}</span>
                            )}
                        </div>
                    )}
                    {phone && (
                        <div style={infoRow}>
                            <span style={infoLabel}>Phone</span>
                            <div className="flex items-center gap-2">
                                <a href={`tel:${phone}`} className="text-[13px] font-semibold hover:underline" style={{ color: 'var(--blanc-ink-1)' }}>
                                    {formatPhone(phone)}
                                </a>
                                <ClickToCallButton phone={phone} contactName={name || undefined} />
                                <OpenTimelineButton phone={phone} contactId={lead.ContactId ?? undefined} />
                            </div>
                        </div>
                    )}
                    {email && (
                        <div style={{ ...infoRow, borderBottom: 'none', paddingBottom: 0 }}>
                            <span style={infoLabel}>Email</span>
                            <a
                                href={`mailto:${email}`}
                                className="text-[13px] font-semibold hover:underline"
                                style={{ color: 'var(--blanc-ink-1)', wordBreak: 'break-all' }}
                            >
                                {email}
                            </a>
                        </div>
                    )}
                </div>
            )}

            {/* ── ADDRESS ── */}
            {hasAddress && (
                <div style={sectionCard}>
                    <p style={eyebrow}>Address</p>
                    {addressParts && (
                        <div
                            className="text-[15px] leading-snug font-semibold"
                            style={{ fontFamily: 'var(--blanc-font-heading)', letterSpacing: '-0.02em', color: 'var(--blanc-ink-1)' }}
                        >
                            {addressParts}
                        </div>
                    )}
                    {cityLine && (
                        <div className="text-[13px] mt-1" style={{ color: 'var(--blanc-ink-2)' }}>
                            {cityLine}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
