/**
 * PULSE-CONTACT-PIN-001 (OB-12) — the pinned condensed contact bar.
 *
 * Lives in the timeline column's sticky stack (under the Action Required plaque)
 * and REPLACES the in-flow contact card: on a long thread the identity and the
 * three reach actions stay on screen while history scrolls. Expansion opens the
 * full card as a canonical right-side panel (bottom sheet on mobile) — an overlay,
 * so expanding never changes the scroll container's height and cannot disturb the
 * reverse-pagination scroll compensation.
 *
 * Collapsed content (owner spec): name; address line (freshest job → contact
 * default → company); Call / Text / Email actions — no literal phone or email;
 * Notes only when notes exist; open Leads & Jobs count. Tasks are NOT here — the
 * AR plaque above already lists them.
 */
import { ChevronRight, Mail, MessageSquare } from 'lucide-react';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { MaskedCallLine } from '../shared/MaskedCallLine';
import { PulsePinnedBar, PulsePinnedBarAction, PulsePinnedBarExpand } from '../pulse/PulsePinnedBar';
import type { BarAddress } from './contactBarHelpers';

export interface PulseContactBarProps {
    name: string;
    address: BarAddress | null;
    phone: string | null;
    contactId: number;
    canCall: boolean;
    /** Contact has at least one email address (button presence). */
    hasEmail: boolean;
    /** Mailbox connected (button intent: compose vs connect guidance). */
    emailConnected: boolean;
    showNotes: boolean;
    openCount: number;
    /**
     * ROLE-TIMELINE-TECH-STICKY-001: whether the user may open the full contact card.
     * A technician without contacts.view still sees the identity + reach actions, but
     * the card-opening affordances (Notes, Leads & Jobs, Expand) are withheld. Its
     * identity may instead link to that customer's scoped Jobs list. Defaults to true.
     */
    canOpenCard?: boolean;
    onText: () => void;
    onEmail: () => void;
    onOpenNotes: () => void;
    onOpenLeadsJobs: () => void;
    onExpand: () => void;
    onOpenJobs?: () => void;
}

export function PulseContactBar({
    name, address, phone, contactId, canCall, hasEmail, emailConnected, showNotes, openCount, canOpenCard = true,
    onText, onEmail, onOpenNotes, onOpenLeadsJobs, onExpand, onOpenJobs,
}: PulseContactBarProps) {
    // Exactly one primary (violet) action: Call when a phone exists, otherwise the
    // first reachable channel — an email-only contact promotes Email.
    const emailIsPrimary = !canCall && hasEmail;
    const jobsLinkEnabled = !canOpenCard && !!onOpenJobs;
    const handleIdentityKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!jobsLinkEnabled || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onOpenJobs?.();
    };

    return (
        <PulsePinnedBar entityLabel="Contact" accent="var(--blanc-success)" className="pulse-contact-bar">
            <div
                className={`pulse-contact-bar-identity${jobsLinkEnabled ? ' is-jobs-link' : ''}`}
                role={jobsLinkEnabled ? 'button' : undefined}
                tabIndex={jobsLinkEnabled ? 0 : undefined}
                onClick={jobsLinkEnabled ? onOpenJobs : undefined}
                onKeyDown={jobsLinkEnabled ? handleIdentityKeyDown : undefined}
            >
                <div className="pulse-contact-bar-identity-copy">
                    <h2 className="pulse-contact-bar-name" style={{ fontFamily: 'var(--blanc-font-heading)' }}>{name}</h2>
                    {address && (
                        <p className="pulse-contact-bar-address">
                            {address.street && <span className="pulse-contact-bar-street">{address.street}</span>}
                            <span>{address.cityLine}</span>
                        </p>
                    )}
                </div>
                {jobsLinkEnabled && <ChevronRight className="pulse-contact-bar-jobs-chevron" aria-hidden />}
            </div>

            <div className="pulse-contact-bar-actions">
                {canCall && (
                    <>
                        <span className="pulse-pinned-bar-call pulse-contact-bar-call">
                            <MaskedCallLine entityType="contact" entityId={contactId} maskedLabel="Call">
                                {phone ? <ClickToCallButton phone={phone} contactName={name} /> : null}
                            </MaskedCallLine>
                        </span>
                        <PulsePinnedBarAction label="Text" icon={<MessageSquare aria-hidden />} onClick={onText} />
                    </>
                )}
                {hasEmail && (
                    <PulsePinnedBarAction
                        className={`${emailIsPrimary ? 'is-accent-primary' : ''} ${!emailConnected ? 'is-unavailable' : ''}`}
                        label="Email"
                        icon={<Mail aria-hidden />}
                        title={emailConnected ? 'Email' : 'Connect a mailbox to send email'}
                        onClick={onEmail}
                    />
                )}
            </div>

            {canOpenCard && (
                <div className="pulse-contact-bar-summary">
                    {showNotes && (
                        <button type="button" className="pulse-contact-bar-link" onClick={onOpenNotes}>Notes</button>
                    )}
                    <button type="button" className="pulse-contact-bar-link" onClick={onOpenLeadsJobs}>
                        Leads &amp; Jobs <strong>{openCount}</strong>
                    </button>
                </div>
            )}

            {canOpenCard && <PulsePinnedBarExpand label="Open full contact card" onClick={onExpand} />}
        </PulsePinnedBar>
    );
}
