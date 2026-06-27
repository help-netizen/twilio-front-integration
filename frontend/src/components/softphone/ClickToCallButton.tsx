/**
 * ClickToCallButton — hover-reveal call button for phone numbers.
 *
 * Desktop: opens the in-app SoftPhone dialer with the number pre-filled.
 * Mobile (MOBILE-NO-SOFTPHONE-001): the browser softphone is disabled, so a tap
 * opens the device's NATIVE dialer via a `tel:` link — which actually works.
 */

import React from 'react';
import { Phone } from 'lucide-react';
import { useSoftPhone } from '../../contexts/SoftPhoneContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import './ClickToCallButton.css';

interface ClickToCallButtonProps {
    phone: string;
    contactName?: string;
    /** If true, renders inline (for use inside text flow) */
    inline?: boolean;
}

export const ClickToCallButton: React.FC<ClickToCallButtonProps> = ({
    phone,
    contactName,
    inline = false,
}) => {
    const { openDialer } = useSoftPhone();
    const isMobile = useIsMobile();

    if (!phone) return null;

    const className = `click-to-call-btn ${inline ? 'inline' : ''}`;
    const label = `Call ${contactName || phone}`;

    // Mobile: no in-browser softphone — hand off to the native dialer.
    if (isMobile) {
        return (
            <a
                className={className}
                href={`tel:${phone.replace(/[^\d+]/g, '')}`}
                onClick={(e) => e.stopPropagation()}
                title={label}
            >
                <Phone size={12} />
                <span>Call</span>
            </a>
        );
    }

    return (
        <button
            className={className}
            onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                openDialer(phone, contactName);
            }}
            title={label}
        >
            <Phone size={12} />
            <span>Call</span>
        </button>
    );
};
