import React from 'react';
import './CallIcon.css';

interface CallIconProps {
    direction: 'inbound' | 'outbound' | 'internal' | 'external';
    status: string;
    metadata?: {
        twilio_direction?: string;
        [key: string]: any;
    };
}

const CallIcon: React.FC<CallIconProps> = ({ direction, status, metadata }) => {
    // Determine color based on status
    const getStatusColor = () => {
        // Normalize status to lowercase for comparison
        const normalizedStatus = status?.toLowerCase() || '';

        // DEBUG: Log to console
        console.log('CallIcon status:', status, '→ normalized:', normalizedStatus);

        // Red: missed/no-answer
        if (['no-answer', 'busy', 'canceled', 'failed'].includes(normalizedStatus)) {
            console.log('  → RED (missed)');
            return 'status-missed';
        }
        // Blue: in-progress
        if (['ringing', 'in-progress', 'queued'].includes(normalizedStatus)) {
            console.log('  → BLUE (active)');
            return 'status-active';
        }
        // Green: completed
        console.log('  → GREEN (completed), status was:', status);
        return 'status-completed';
    };

    // Determine icon and tooltip based on direction
    const getDirectionInfo = () => {
        // For 'external' calls, check Twilio direction to determine actual direction
        let actualDirection = direction;
        if (direction === 'external' && metadata?.twilio_direction) {
            // outbound-dial, outbound-api → outbound
            if (metadata.twilio_direction.startsWith('outbound')) {
                actualDirection = 'outbound';
            }
            // inbound → inbound
            else if (metadata.twilio_direction === 'inbound') {
                actualDirection = 'inbound';
            }
        }

        switch (actualDirection) {
            case 'inbound':
                return {
                    icon: '↓', // Down arrow for incoming
                    label: 'Incoming Call'
                };
            case 'outbound':
                return {
                    icon: '↑', // Up arrow for outgoing
                    label: 'Outgoing Call'
                };
            case 'internal':
                return {
                    icon: '↔', // Bidirectional arrow for internal
                    label: 'Internal Call'
                };
            case 'external':
                return {
                    icon: '⟲', // Circular arrow for external
                    label: 'External Call'
                };
            default:
                return {
                    icon: '○',
                    label: 'Unknown'
                };
        }
    };

    const directionInfo = getDirectionInfo();
    const statusColor = getStatusColor();

    return (
        <div
            className={`call-icon ${statusColor}`}
            title={directionInfo.label}
        >
            <span className="call-icon-arrow">{directionInfo.icon}</span>
        </div>
    );
};

export default CallIcon;
