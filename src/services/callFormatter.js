/**
 * Call Formatter Service
 * 
 * Converts Twilio call records into Front message format with:
 * - Markdown formatting
 * - Emoji indicators
 * - Duration formatting
 * - Phone number formatting
 * - Threading by caller
 */
class CallFormatter {
    /**
     * Format duration from seconds to human-readable format
     * @param {number} seconds - Duration in seconds
     * @returns {string} Formatted duration (e.g., "3m 45s")
     */
    static formatDuration(seconds) {
        if (!seconds || seconds < 0) return '0s';

        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;

        if (mins === 0) return `${secs}s`;
        return `${mins}m ${secs}s`;
    }

    /**
     * Format phone number for display (simple US formatting)
     * @param {string} number - Phone number
     * @returns {string} Formatted phone number
     */
    static formatPhoneNumber(number) {
        if (!number) return 'Unknown';

        // Remove all non-digit characters
        const cleaned = number.replace(/\D/g, '');

        // US format: +1 (XXX) XXX-XXXX
        if (cleaned.length === 11 && cleaned.startsWith('1')) {
            return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
        }

        // International or other formats - just return as is
        return number;
    }

    /**
     * Get conversation ID for threading
     * All calls with the same phone number will be grouped together
     * @param {string} phoneNumber - Phone number
     * @returns {string} Conversation ID
     */
    static getConversationId(phoneNumber) {
        const cleaned = phoneNumber.replace(/\D/g, '');
        return `caller_${cleaned}`;
    }

    /**
     * Format call status with emoji
     * @param {string} status - Twilio call status
     * @returns {string} Formatted status
     */
    static formatStatus(status) {
        const statusMap = {
            'completed': '✅ Completed',
            'busy': '📵 Busy',
            'no-answer': '❌ No Answer',
            'canceled': '🚫 Canceled',
            'failed': '⚠️ Failed'
        };

        return statusMap[status] || status.charAt(0).toUpperCase() + status.slice(1);
    }

    /**
     * Convert Twilio call to Front inbound message
     * @param {object} twilioCall - Twilio call object
     * @returns {object} Front inbound message payload
     */
    static toFrontInboundMessage(twilioCall) {
        const duration = parseInt(twilioCall.duration || 0);
        const direction = twilioCall.direction || 'inbound';
        const emoji = direction.includes('inbound') ? '📞' : '📱';
        const directionLabel = direction.includes('inbound') ? 'Incoming' : 'Outgoing';

        return {
            sender: {
                handle: twilioCall.from,
                name: this.formatPhoneNumber(twilioCall.from)
            },
            subject: `${emoji} ${directionLabel} Call - ${this.formatDuration(duration)}`,
            body: this.formatCallBody(twilioCall),
            body_format: 'markdown',
            metadata: {
                thread_ref: twilioCall.from,
                headers: {
                    call_sid: twilioCall.sid,
                    direction: twilioCall.direction,
                    duration: twilioCall.duration,
                    status: twilioCall.status,
                    price: twilioCall.price
                }
            },
            external_id: `twilio_call_${twilioCall.sid}`,
            external_conversation_id: this.getConversationId(twilioCall.from),
            created_at: twilioCall.startTime ? Math.floor(new Date(twilioCall.startTime).getTime() / 1000) : Math.floor(Date.now() / 1000)
        };
    }

    /**
     * Convert Twilio call to Front outbound message
     * @param {object} twilioCall - Twilio call object
     * @returns {object} Front outbound message payload
     */
    static toFrontOutboundMessage(twilioCall) {
        const duration = parseInt(twilioCall.duration || 0);
        const emoji = '📱';

        return {
            sender: {
                handle: twilioCall.from,
                name: this.formatPhoneNumber(twilioCall.from)
            },
            to: [twilioCall.to],
            subject: `${emoji} Outgoing Call - ${this.formatDuration(duration)}`,
            body: this.formatCallBody(twilioCall),
            body_format: 'markdown',
            metadata: {
                thread_ref: twilioCall.to,
                headers: {
                    call_sid: twilioCall.sid,
                    direction: twilioCall.direction,
                    duration: twilioCall.duration,
                    status: twilioCall.status,
                    price: twilioCall.price
                }
            },
            external_id: `twilio_call_${twilioCall.sid}`,
            external_conversation_id: this.getConversationId(twilioCall.to),
            created_at: twilioCall.startTime ? Math.floor(new Date(twilioCall.startTime).getTime() / 1000) : Math.floor(Date.now() / 1000)
        };
    }

    /**
     * Format call details as Markdown body
     * @param {object} call - Twilio call object
     * @returns {string} Markdown formatted body
     */
    static formatCallBody(call) {
        const direction = call.direction || 'inbound';
        const directionLabel = direction.includes('inbound') ? 'Incoming' : 'Outgoing';
        const duration = parseInt(call.duration || 0);

        const lines = [
            `**${directionLabel} Call**`,
            '',
            `**From:** ${this.formatPhoneNumber(call.from)}`,
            `**To:** ${this.formatPhoneNumber(call.to)}`,
            `**Duration:** ${this.formatDuration(duration)}`,
            `**Time:** ${this.formatDateTime(call.startTime)}`,
            `**Status:** ${this.formatStatus(call.status)}`,
        ];

        // Add price if available
        if (call.price) {
            const price = Math.abs(parseFloat(call.price));
            lines.push(`**Cost:** $${price.toFixed(3)}`);
        }

        // Add call SID for reference
        lines.push(`**Call ID:** \`${call.sid}\``);

        // Add recording link if available
        if (call.recordingUrl) {
            lines.push('', `[🎧 Listen to Recording](${call.recordingUrl})`);
        }

        // Add any additional notes
        if (call.answeredBy) {
            lines.push('', `*Answered by: ${call.answeredBy}*`);
        }

        return lines.join('\n');
    }

    /**
     * Format date/time
     * @param {string|Date} dateTime - Date/time to format
     * @returns {string} Formatted date/time
     */
    static formatDateTime(dateTime) {
        if (!dateTime) return 'Unknown';

        const date = new Date(dateTime);

        return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        });
    }
}

module.exports = CallFormatter;
