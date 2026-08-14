/**
 * OpenTimelineButton — hover-reveal message button for phone numbers.
 *
 * Renders a small message icon that appears on hover next to a phone number.
 * Clicking navigates to the Pulse timeline for this phone number.
 * If no timeline exists, one is created and linked to the contact.
 *
 * RBAC: texting happens IN Pulse, and every Pulse route is `pulse.view`-gated —
 * without it the click would just bounce the user back to /jobs. So the button
 * is only offered to viewers who can actually land there. All four seeded roles
 * (including provider) hold `pulse.view` by default, so this hides the button
 * only where an admin has deliberately taken Pulse away from a role.
 *
 * The customer's number is deliberately absent from the label: a masked viewer
 * must not read it off a tooltip on a row where masking hides it.
 */

import React, { useState } from 'react';
import { MessageCircle, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { pulseApi } from '../../services/pulseApi';
import { useAuthz } from '../../hooks/useAuthz';
import './OpenTimelineButton.css';

interface OpenTimelineButtonProps {
    phone: string;
    contactId?: number | null;
    /** Used for the label, so the raw number never has to appear in a tooltip. */
    contactName?: string;
}

export const OpenTimelineButton: React.FC<OpenTimelineButtonProps> = ({
    phone,
    contactId,
    contactName,
}) => {
    const navigate = useNavigate();
    const { hasPermission } = useAuthz();
    const [loading, setLoading] = useState(false);

    if (!phone || !hasPermission('pulse.view')) return null;

    const handleClick = async (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        if (loading) return;

        setLoading(true);
        try {
            const result = await pulseApi.ensureTimeline(phone, contactId ?? undefined);
            if (result.timelineId) {
                navigate(`/pulse/timeline/${result.timelineId}`);
                return;
            }
            toast.error('No conversation for this number yet');
        } catch (err) {
            // A provider only reaches a contact's timeline through an ACTIVE job, so
            // this legitimately fails on a finished or canceled one. Say so instead of
            // leaving a button that visibly does nothing.
            console.error('Failed to open timeline:', err);
            toast.error("Can't open this conversation", {
                description: 'You may no longer have an active job with this customer.',
            });
        } finally {
            setLoading(false);
        }
    };

    return (
        <button
            className="open-timeline-btn"
            onClick={handleClick}
            title={contactName ? `Message ${contactName}` : 'Message customer'}
            disabled={loading}
        >
            {loading ? (
                <Loader2 size={14} className="animate-spin" />
            ) : (
                <MessageCircle size={14} />
            )}
        </button>
    );
};
