/**
 * Call Processing Microservice
 * 
 * Responsibilities:
 * 1. Detect call direction (inbound/outbound) based on SIP routing
 * 2. Identify external party for conversation grouping
 * 3. Normalize call status for UI display
 * 4. Handle child call detection (SIP leg merging)
 */

/**
 * Check if a number is a SIP address
 * @param {string} number - Phone number or SIP URI
 * @returns {boolean}
 */
function isSIPAddress(number) {
    if (!number) return false;
    return number.toLowerCase().startsWith('sip:');
}

/**
 * Format phone number for display
 * Extracts number from SIP URI if needed and formats as E.164
 * 
 * @param {string} number - Phone number or SIP URI
 * @returns {string} Formatted phone number
 */
function formatPhone(number) {
    if (!number) return '';

    // Extract phone number from SIP URI
    // sip:+15085140320@... → +15085140320
    // sip:5085140320@... → +15085140320
    if (number.toLowerCase().startsWith('sip:')) {
        const match = number.match(/sip:(\+?\d+)@/);
        if (match) {
            number = match[1];
        }
    }

    // Remove non-digits except leading +
    let cleaned = number.replace(/[^\d+]/g, '');

    // Ensure E.164 format (+1...)
    if (!cleaned.startsWith('+')) {
        // Assume US number if no country code
        if (cleaned.length === 10) {
            cleaned = '+1' + cleaned;
        } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
            cleaned = '+' + cleaned;
        }
    }

    // Format as (XXX) XXX-XXXX for display
    if (cleaned.startsWith('+1') && cleaned.length === 12) {
        const area = cleaned.substring(2, 5);
        const prefix = cleaned.substring(5, 8);
        const line = cleaned.substring(8);
        return `+1 (${area}) ${prefix}-${line}`;
    }

    return cleaned;
}

class CallProcessor {
    /**
     * Determine actual call direction from Twilio call data
     * 
     * Logic:
     * - FROM = external number, TO = SIP → Inbound (customer calling in)
     * - FROM = SIP, TO = external number → Outbound (calling out to customer)
     * - Both SIP → Internal (call forwarding between dispatchers)
     * - Neither SIP → External (fallback, shouldn't happen)
     * 
     * @param {Object} callData - Transformed Twilio call
     * @returns {string} 'inbound' | 'outbound' | 'internal' | 'external'
     */
    static detectDirection(callData) {
        const fromIsSIP = isSIPAddress(callData.from);
        const toIsSIP = isSIPAddress(callData.to);

        if (!fromIsSIP && toIsSIP) {
            // External number calling TO SIP dispatcher → INBOUND
            // Example: +1 (508) 514-0320 → sip:dispatcher@...
            return 'inbound';
        } else if (fromIsSIP && !toIsSIP) {
            // SIP dispatcher calling TO external number → OUTBOUND
            // Example: sip:dispatcher@... → +1 (508) 514-0320
            return 'outbound';
        } else if (fromIsSIP && toIsSIP) {
            // Internal call between SIP endpoints (forwarding/transfer)
            return 'internal';
        } else {
            // Both external (shouldn't happen, fallback)
            return 'external';
        }
    }

    /**
     * Determine external party contact from call
     * 
     * @param {Object} callData
     * @param {string} direction - Detected direction
     * @returns {Object} { number, formatted }
     */
    static getExternalParty(callData, direction) {
        let externalNumber, externalFormatted;

        if (direction === 'inbound') {
            // Inbound: external party is FROM (customer calling in)
            externalNumber = callData.from;
            externalFormatted = callData.fromFormatted;
        } else if (direction === 'outbound') {
            // Outbound: external party is TO (calling out to customer)
            externalNumber = callData.to;
            externalFormatted = callData.toFormatted;
        } else if (direction === 'internal') {
            // Internal: use TO as contact
            externalNumber = callData.to;
            externalFormatted = callData.toFormatted;
        } else {
            // Fallback: use FROM
            externalNumber = callData.from;
            externalFormatted = callData.fromFormatted;
        }

        return {
            number: externalNumber,
            formatted: formatPhone(externalNumber)
        };
    }

    /**
     * Normalize call status for UI display
     * 
     * Maps Twilio's status + metadata to user-friendly status
     * 
     * Twilio statuses: queued, ringing, in-progress, completed, busy, no-answer, canceled, failed
     * Our statuses: completed, ringing, no-answer, failed, busy, canceled, in-progress
     * 
     * @param {Object} callData
     * @returns {string} Normalized status
     */
    static normalizeStatus(callData) {
        const twilioStatus = callData.status;
        const duration = callData.duration;
        const endTime = callData.endTime;

        // ✅ FIX: If call has duration > 0, it was answered (completed)
        if (duration > 0) {
            return 'completed';
        }

        // ✅ FIX: If call ended (has endTime) but no duration → not answered
        if (endTime) {
            // Check original status for specific reason
            if (twilioStatus === 'busy') return 'busy';
            if (twilioStatus === 'no-answer') return 'no-answer';
            if (twilioStatus === 'canceled') return 'canceled';
            if (twilioStatus === 'failed') return 'failed';

            // Default for ended calls with no duration
            return 'no-answer';
        }

        // Call still in progress (no endTime yet)
        if (twilioStatus === 'ringing') return 'ringing';
        if (twilioStatus === 'in-progress') return 'in-progress';
        if (twilioStatus === 'queued') return 'queued';

        // Fallback to Twilio's status
        return twilioStatus;
    }

    /**
     * Check if call is a child call (has parent_call_sid)
     * Used for SIP call leg merging
     * 
     * @param {Object} callData
     * @returns {boolean}
     */
    static isChildCall(callData) {
        return !!callData.parentCallSid;
    }

    /**
     * Process call and return full context
     * Main entry point for call processing
     * 
     * @param {Object} callData - Transformed Twilio call
     * @returns {Object} { direction, externalParty, status, isChild, metadata }
     */
    static processCall(callData) {
        const direction = this.detectDirection(callData);
        const externalParty = this.getExternalParty(callData, direction);
        const status = this.normalizeStatus(callData);
        const isChild = this.isChildCall(callData);

        return {
            direction,
            externalParty,
            status,
            isChild,
            metadata: {
                twilioDirection: callData.direction,
                twilioStatus: callData.status,
                duration: callData.duration,
                hasParent: isChild,
                from: callData.from,
                to: callData.to
            }
        };
    }
}

module.exports = CallProcessor;
