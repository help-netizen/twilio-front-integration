const express = require('express');
const router = express.Router();
const queries = require('../db/queries');

/**
 * GET /api/conversations
 * Get all conversations with pagination
 */
router.get('/', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const offset = parseInt(req.query.offset) || 0;

        const [conversations, total] = await Promise.all([
            queries.getConversations(limit, offset),
            queries.getConversationsCount(),
        ]);

        // Transform to frontend format
        const formattedConversations = await Promise.all(
            conversations.map((conv) => formatConversation(conv))
        );

        res.json({
            conversations: formattedConversations,
            total,
            limit,
            offset,
        });
    } catch (error) {
        console.error('Error fetching conversations:', error);
        res.status(500).json({ error: 'Failed to fetch conversations' });
    }
});

/**
 * GET /api/conversations/active
 * Get all active calls (queued, initiated, ringing, in-progress)
 */
router.get('/active', async (req, res) => {
    try {
        const activeCalls = await queries.getActiveCalls();
        const formattedCalls = activeCalls.map((call) => formatMessage(call));

        res.json({
            active_calls: formattedCalls,
            count: formattedCalls.length
        });
    } catch (error) {
        console.error('Error fetching active calls:', error);
        res.status(500).json({ error: 'Failed to fetch active calls' });
    }
});

/**
 * GET /api/conversations/:id
 * Get single conversation by ID
 */
router.get('/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);

        if (isNaN(id)) {
            return res.status(400).json({ error: 'Invalid conversation ID' });
        }

        const conversation = await queries.getConversationById(id);

        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        const formatted = await formatConversation(conversation);
        res.json(formatted);
    } catch (error) {
        console.error('Error fetching conversation:', error);
        res.status(500).json({ error: 'Failed to fetch conversation' });
    }
});

/**
 * GET /api/conversations/:id/messages
 * Get all messages for a conversation
 */
router.get('/:id/messages', async (req, res) => {
    try {
        const conversationId = req.params.id;
        let messages = await queries.getMessagesByConversation(conversationId);

        // CRITICAL: Merge parent-child calls BEFORE returning
        // This ensures the message count reflects actual distinct calls,
        // not raw DB records (which include hidden parent calls)
        messages = mergeParentChildCalls(messages);

        const formattedMessages = messages.map(msg => formatMessage(msg));

        res.json({ messages: formattedMessages });
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

/**
 * Merge parent-child call pairs
 * Merge parent-child call pairs into single entries
 * Filters out parent calls and enriches child calls with duration breakdown
 * When a call has a parent_call_sid, merge it with the parent:
 * - Use child's direction (more accurate for user perspective)
 * - Use parent's duration as total_duration
 * - Use child's duration as talk_time  
 * - Calculate wait_time = total_duration - talk_time
 */
function mergeParentChildCalls(messages) {
    // Create a map of call SID to message
    const messageMap = new Map();
    messages.forEach(msg => {
        messageMap.set(msg.twilio_sid, msg);
    });

    // Find child calls and merge them with parents
    const childSids = new Set();
    messages.forEach(msg => {
        if (msg.parent_call_sid && messageMap.has(msg.parent_call_sid)) {
            const parent = messageMap.get(msg.parent_call_sid);
            const child = msg;

            // Mark child for removal
            childSids.add(child.twilio_sid);

            // Merge: update child with parent's data
            // Duration breakdown
            child.total_duration = parent.duration;
            child.talk_time = child.duration;
            child.wait_time = parent.duration - child.duration;

            // CRITICAL: Smart from/to selection based on SIP URI detection
            // Different call flows have phone numbers in different places.
            // We need to detect which call (parent or child) has SIP URIs
            // and use the other one's from/to.
            //
            // Helper: Check if a number is a SIP URI
            const isSIP = (num) => num && num.toLowerCase().startsWith('sip:');

            // Check if child has any SIP URIs in from/to
            const childHasSIP = isSIP(child.from_number) || isSIP(child.to_number);
            const parentHasSIP = isSIP(parent.from_number) || isSIP(parent.to_number);

            // Decision logic:
            // - If child has SIP but parent doesn't → use parent's from/to
            // - If parent has SIP but child doesn't → use child's from/to (keep as is)
            // - If both have SIP or neither has SIP → fallback to direction-based logic

            if (childHasSIP && !parentHasSIP) {
                // Child has SIP, parent has phone numbers → use parent
                // Example: child.to = sip:dispatcher@..., parent.to = +16175006181
                child.from_number = parent.from_number;
                child.to_number = parent.to_number;
            } else if (!childHasSIP && parentHasSIP) {
                // Parent has SIP, child has phone numbers → keep child (already correct)
                // Example: parent.from = sip:dispatcher@..., child.from = +16175006181
                // No action needed
            } else if (child.direction === 'inbound') {
                // Fallback: both have SIP or neither has SIP, use direction-based logic
                // Inbound calls typically need parent's from/to
                child.from_number = parent.from_number;
                child.to_number = parent.to_number;
            }
            // else: keep child's from/to (outbound/external with no SIP difference)

            // Keep child's direction (more accurate)
            // child.direction is already correct

            // Add parent metadata for reference
            child.merged_from_parent = parent.twilio_sid;
        }
    });

    // Filter out parent calls that have children
    const parentWithChildSids = new Set();
    messages.forEach(msg => {
        if (msg.parent_call_sid) {
            parentWithChildSids.add(msg.parent_call_sid);
        }
    });

    return messages.filter(msg => !parentWithChildSids.has(msg.twilio_sid));
}

/**
 * Helper: Format conversation for frontend
 */
async function formatConversation(conv) {
    // Parse contact JSON
    const contact = typeof conv.contact === 'string' ? JSON.parse(conv.contact) : conv.contact;

    // CRITICAL: Get correct call count by merging parent-child calls
    // Raw DB count includes parent calls that are hidden in UI
    // Example: 28 raw messages → 22 merged calls (after filtering 6 parent calls)
    let messages = await queries.getMessagesByConversation(conv.id);
    console.log(`[formatConversation] Conv ${conv.id}: Raw messages = ${messages.length}`);

    const mergedMessages = mergeParentChildCalls(messages);
    const messageCount = mergedMessages.length;
    console.log(`[formatConversation] Conv ${conv.id}: Merged messages = ${messageCount}`);

    // ✅ FIX: Get last message from MERGED messages, not raw DB
    // This ensures we show the actual last visible call, not a hidden parent call
    const lastMessage = mergedMessages.length > 0
        ? mergedMessages[mergedMessages.length - 1]  // Last merged message
        : null;

    // Format contact phone numbers from SIP URIs
    const formattedPhone = formatPhone(contact.formatted_number || contact.phone_number);

    // Format last message for icon display
    let formattedLastMessage = null;
    if (lastMessage) {
        formattedLastMessage = {
            id: lastMessage.id.toString(),
            direction: lastMessage.direction,
            status: lastMessage.status,
            call: {
                status: lastMessage.status
            },
            metadata: lastMessage.metadata || {}
        };
    }

    return {
        id: conv.id.toString(),
        external_id: formatPhone(conv.external_id), // Format SIP URIs
        subject: conv.subject || `Calls with ${formattedPhone}`,
        status: conv.status,
        contact: {
            id: contact.id.toString(),
            handle: contact.phone_number,
            name: contact.display_name || formattedPhone,
            metadata: {
                formatted_number: formattedPhone, // Use formatted phone
            },
        },
        last_message: formattedLastMessage,
        last_message_at: conv.last_message_at
            ? new Date(conv.last_message_at).getTime()
            : null,
        metadata: {
            ...conv.metadata,            // Spread DB metadata first
            total_calls: messageCount,    // Then override with correct merged count
        },
        created_at: new Date(conv.created_at).getTime(),
        updated_at: new Date(conv.updated_at).getTime(),
    };
}

/**
 * Helper: Format message for frontend
 */
function formatMessage(msg) {
    return {
        id: msg.id.toString(),
        conversation_id: msg.conversation_id.toString(),
        external_id: msg.twilio_sid,
        direction: msg.direction,
        subject: formatMessageSubject(msg),
        body: formatMessageBody(msg),
        call: {
            status: msg.status,  // ✅ ADD: status for CallIcon color
            duration: msg.duration,
        },
        metadata: {
            call_sid: msg.twilio_sid,
            duration: msg.duration,
            status: msg.status,
            recording_url: msg.recording_url,
            from_number: msg.from_number,
            to_number: msg.to_number,
            parent_call_sid: msg.parent_call_sid,
            // Include merge-related fields for parent-child calls
            total_duration: msg.total_duration,
            talk_time: msg.talk_time,
            wait_time: msg.wait_time,
            merged_from_parent: msg.merged_from_parent,
            ...msg.metadata,
        },
        created_at: new Date(msg.start_time).getTime(),
    };
}

/**
 * Helper: Format message subject
 */
function formatMessageSubject(msg) {
    const emoji = msg.direction === 'inbound' ? '📞' : '📱';
    const directionText = msg.direction === 'inbound' ? 'Incoming' : 'Outgoing';

    // Use total_duration for merged calls, otherwise use duration
    const displayDuration = msg.total_duration !== undefined ? msg.total_duration : msg.duration;
    const duration = displayDuration ? formatDuration(displayDuration) : 'No answer';

    return `${emoji} ${directionText} Call - ${duration}`;
}

/**
 * Helper: Format message body (markdown)
 */
function formatMessageBody(msg) {
    const lines = [];

    // Basic call info
    lines.push(`**From:** ${formatPhone(msg.from_number)}`);
    lines.push(`**To:** ${formatPhone(msg.to_number)}`);

    // Duration - show breakdown for merged calls
    if (msg.total_duration !== undefined && msg.total_duration !== msg.duration) {
        // This is a merged parent-child call
        lines.push(`**Total Duration:** ${formatDuration(msg.total_duration)}`);
        lines.push(`**Talk Time:** ${formatDuration(msg.talk_time)}`);
        if (msg.wait_time > 0) {
            lines.push(`**Wait Time:** ${formatDuration(msg.wait_time)}`);
        }
    } else {
        // Regular call (no parent-child relationship)
        lines.push(`**Duration:** ${msg.duration ? formatDuration(msg.duration) : 'N/A'}`);
    }

    lines.push(`**Status:** ${capitalizeFirst(msg.status)}`);

    // Timestamps
    if (msg.start_time) {
        const startDate = new Date(msg.start_time);
        lines.push(`**Started:** ${startDate.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        })}`);
    }

    if (msg.end_time) {
        const endDate = new Date(msg.end_time);
        lines.push(`**Ended:** ${endDate.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        })}`);
    }

    // Pricing
    if (msg.price !== null && msg.price !== undefined) {
        const priceUnit = msg.price_unit || 'USD';
        const priceFormatted = Math.abs(msg.price).toFixed(4);
        lines.push(`**Cost:** $${priceFormatted} ${priceUnit}`);
    }

    // Call SID
    lines.push(`**Call SID:** \`${msg.twilio_sid}\``);

    // Additional metadata
    if (msg.metadata) {
        // Answered By (machine detection)
        if (msg.metadata.answered_by) {
            lines.push(`**Answered By:** ${capitalizeFirst(msg.metadata.answered_by)}`);
        }

        // Queue Time
        if (msg.metadata.queue_time) {
            lines.push(`**Queue Time:** ${msg.metadata.queue_time}s`);
        }

        // Parent Call SID (for forwarded/transferred calls)
        if (msg.parent_call_sid) {
            lines.push(`**Parent Call:** \`${msg.parent_call_sid}\``);
        }

        // Forwarded From (if available)
        if (msg.metadata.forwarded_from) {
            lines.push(`**Forwarded From:** ${formatPhone(msg.metadata.forwarded_from)}`);
        }

        // Show original Twilio direction for debugging
        if (msg.metadata.twilio_direction && msg.metadata.twilio_direction !== msg.direction) {
            lines.push(`**Twilio Direction:** ${msg.metadata.twilio_direction} *(corrected to: ${msg.direction})*`);
        }
    }

    // Recording
    if (msg.recording_url) {
        lines.push(`\n🎙️ [Listen to recording](${msg.recording_url})`);
    }

    return lines.join('\n');
}

/**
 * Helper: Format duration in seconds to human readable
 */
function formatDuration(seconds) {
    if (!seconds || seconds === 0) return '0s';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

/**
/**
 * Helper: Format phone number for display as clickable link
 * Handles both regular phone numbers and SIP URIs
 * Examples:
 *   +15085140320 → <a href="tel:+15085140320">+1 (508) 514-0320</a>
 *   sip:+15085140320@abchomes.sip.us1.twilio.com:5061;user=phone → <a href="tel:+15085140320">+1 (508) 514-0320</a>
 */
function formatPhone(number) {
    if (!number) return 'Unknown';

    let phoneNumber = number;

    // Extract phone number from SIP URI if present
    if (number.toLowerCase().startsWith('sip:')) {
        // Match patterns like:
        // sip:+15085140320@... or sip:5085140320@...
        const match = number.match(/sip:(\+?\d+)@/i);
        if (match) {
            phoneNumber = match[1]; // Extract the phone number part
        } else {
            // If no match, return the SIP address as-is
            return number;
        }
    }

    // Remove + prefix for formatting
    const cleaned = phoneNumber.replace(/^\+/, '').replace(/\D/g, '');

    let formatted;
    let telLink;

    // Format as +1 (XXX) XXX-XXXX for all US numbers (unified format)
    if (cleaned.length === 10) {
        // 10-digit: add +1 prefix
        formatted = `+1 (${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
        telLink = `+1${cleaned}`;
    } else if (cleaned.length === 11 && cleaned[0] === '1') {
        // 11-digit starting with 1: already has country code
        formatted = `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
        telLink = `+${cleaned}`;
    } else {
        // Return original if doesn't match expected formats
        formatted = number;
        telLink = cleaned;
    }

    // Wrap in tel: link for clickability
    return `<a href="tel:${telLink}">${formatted}</a>`;
}

/**
 * Helper: Capitalize first letter
 */
function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = router;
