/**
 * OpenTimelineButton — hover-reveal message button for phone numbers.
 *
 * Renders a small message icon that appears on hover next to a phone number.
 * Clicking navigates to the Pulse timeline for this phone number.
 * If no timeline exists, one is created and linked to the contact.
 */

import React, { useState } from 'react';
import { MessageCircle, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { pulseApi } from '../../services/pulseApi';
import './OpenTimelineButton.css';

interface OpenTimelineButtonProps {
    phone: string;
    contactId?: number | null;
}

export const OpenTimelineButton: React.FC<OpenTimelineButtonProps> = ({
    phone,
    contactId,
}) => {
    const navigate = useNavigate();
    const [loading, setLoading] = useState(false);

    if (!phone) return null;

    const handleClick = async (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        if (loading) return;

        setLoading(true);
        try {
            const result = await pulseApi.ensureTimeline(phone, contactId ?? undefined);
            if (result.timelineId) {
                navigate(`/pulse/timeline/${result.timelineId}`);
            }
        } catch (err) {
            console.error('Failed to open timeline:', err);
        } finally {
            setLoading(false);
        }
    };

    return (
        <button
            className="open-timeline-btn"
            onClick={handleClick}
            title={`Message ${phone}`}
            disabled={loading}
        >
            {loading ? (
                <Loader2 size={12} className="animate-spin" />
            ) : (
                <MessageCircle size={12} />
            )}
        </button>
    );
};
