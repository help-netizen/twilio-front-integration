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
import { Mail, MessageSquare } from 'lucide-react';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { PulsePinnedBar, PulsePinnedBarAction, PulsePinnedBarExpand } from '../pulse/PulsePinnedBar';
import type { BarAddress } from './contactBarHelpers';

export interface PulseContactBarProps {
    name: string;
    address: BarAddress | null;
    phone: string | null;
    /** Contact has at least one email address (button presence). */
    hasEmail: boolean;
    /** Mailbox connected (button intent: compose vs connect guidance). */
    emailConnected: boolean;
    showNotes: boolean;
    openCount: number;
    onText: () => void;
    onEmail: () => void;
    onOpenNotes: () => void;
    onOpenLeadsJobs: () => void;
    onExpand: () => void;
}

export function PulseContactBar({
    name, address, phone, hasEmail, emailConnected, showNotes, openCount,
    onText, onEmail, onOpenNotes, onOpenLeadsJobs, onExpand,
}: PulseContactBarProps) {
    // Exactly one primary (violet) action: Call when a phone exists, otherwise the
    // first reachable channel — an email-only contact promotes Email.
    const emailIsPrimary = !phone && hasEmail;

    return (
        <PulsePinnedBar entityLabel="Contact" accent="var(--blanc-success)" className="pulse-contact-bar">
            <div className="pulse-contact-bar-identity">
                <h2 className="pulse-contact-bar-name" style={{ fontFamily: 'var(--blanc-font-heading)' }}>{name}</h2>
                {address && (
                    <p className="pulse-contact-bar-address">
                        {address.street && <span className="pulse-contact-bar-street">{address.street}</span>}
                        <span>{address.cityLine}</span>
                    </p>
                )}
            </div>

            <div className="pulse-contact-bar-actions">
                {phone && (
                    <>
                        <span className="pulse-pinned-bar-call pulse-contact-bar-call"><ClickToCallButton phone={phone} contactName={name} /></span>
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

            <div className="pulse-contact-bar-summary">
                {showNotes && (
                    <button type="button" className="pulse-contact-bar-link" onClick={onOpenNotes}>Notes</button>
                )}
                <button type="button" className="pulse-contact-bar-link" onClick={onOpenLeadsJobs}>
                    Leads &amp; Jobs <strong>{openCount}</strong>
                </button>
            </div>

            <PulsePinnedBarExpand label="Open full contact card" onClick={onExpand} />
        </PulsePinnedBar>
    );
}
