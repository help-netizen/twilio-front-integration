/**
 * ClickToCallButton — hover-reveal call button for phone numbers.
 *
 * Renders a small phone icon that appears on hover next to a phone number.
 * Clicking opens the SoftPhone dialer with the number pre-filled.
 */

import React from 'react';
import { Phone } from 'lucide-react';
import { useSoftPhone } from '../../contexts/SoftPhoneContext';
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

    if (!phone) return null;

    return (
        <button
            className={`click-to-call-btn ${inline ? 'inline' : ''}`}
            onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                openDialer(phone, contactName);
            }}
            title={`Call ${contactName || phone}`}
        >
            <Phone size={12} />
            <span>Call</span>
        </button>
    );
};
