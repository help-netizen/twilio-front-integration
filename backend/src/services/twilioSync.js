const twilio = require('twilio');
const queries = require('../db/queries');

/**
 * Helper: Format phone number for display
 * Extracts phone numbers from SIP URIs and formats them
 * Examples:
 *   sip:+15085140320@... → +1 (508) 514-0320
 *   +15085140320 → +1 (508) 514-0320
 *   5085140320 → (508) 514-0320
 */
function formatPhone(number) {
    if (!number) return 'Unknown';

    // Extract phone number from SIP URI if present
    if (number.toLowerCase().startsWith('sip:')) {
        const match = number.match(/sip:(\+?\d+)@/i);
        if (match) {
            number = match[1];
        } else {
            return number;
        }
    }

    // Remove + prefix for formatting
    const cleaned = number.replace(/^\+/, '').replace(/\D/g, '');

    // Format as +1 (XXX) XXX-XXXX for all US numbers (unified format)
    if (cleaned.length === 10) {
        // 10-digit: add +1 prefix
        return `+1 (${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
    }

    if (cleaned.length === 11 && cleaned[0] === '1') {
        // 11-digit starting with 1: already has country code
        return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
    }

    return number;
}

// Initialize Twilio client
const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

/**
 * Sync historical calls from Twilio
 * @param {number} days - Number of days back to sync (default: 7)
 */
async function syncHistoricalCalls(days = 7) {
    try {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        console.log(`📞 Syncing calls from last ${days} days...`);
        console.log(`Starting from: ${startDate.toISOString()}`);

        const calls = await client.calls.list({
            startTimeAfter: startDate,
            limit: 100,
        });

        console.log(`Found ${calls.length} calls to sync`);

        let synced = 0;
        let skipped = 0;

        for (const call of calls) {
            const result = await syncCall(call);
            if (result) {
                synced++;
            } else {
                skipped++;
            }
        }

        console.log(`✅ Sync complete: ${synced} synced, ${skipped} skipped`);
        return { synced, skipped, total: calls.length };
    } catch (error) {
        console.error('Error syncing historical calls:', error);
        throw error;
    }
}

const CallProcessor = require('./callProcessor');

/**
 * Sync a single Twilio call to database
 * @param {Object} twilioCall - Twilio call object
 */
async function syncCall(twilioCall) {
    try {
        // Transform call data first
        const callData = transformTwilioCall(twilioCall);

        // ✅ USE MICROSERVICE for processing
        const processed = CallProcessor.processCall(callData);

        // Check if already exists
        const existing = await queries.findMessageByTwilioSid(twilioCall.sid);

        if (existing) {
            // ✅ UPDATE LOGIC: If existing call is in-progress but now completed, update it
            const shouldUpdate =
                // Call was in-progress status (ringing, in-progress, queued)
                ['ringing', 'in-progress', 'queued'].includes(existing.status) &&
                // And now it's completed/ended (completed, no-answer, busy, canceled, failed)
                ['completed', 'no-answer', 'busy', 'canceled', 'failed'].includes(processed.status);

            if (shouldUpdate) {
                console.log(`  🔄 Updating call: ${twilioCall.sid} (${existing.status} → ${processed.status})`);

                await queries.updateMessage(existing.id, {
                    status: processed.status,
                    duration: callData.duration,
                    endTime: callData.endTime,
                    metadata: JSON.stringify({
                        ...existing.metadata,
                        answered_by: callData.answeredBy,
                        queue_time: callData.queueTime,
                        twilio_status: callData.status,
                        display_status: processed.status,
                        updated_from: existing.status
                    })
                });

                return true;
            }

            console.log(`  ⏭️  Skipping existing call: ${twilioCall.sid} (status: ${existing.status})`);
            return false;
        }

        // NEW CALL: Proceed with creation
        // Determine conversation (grouped by phone number)
        const { contact, conversation } = await groupCallIntoConversation(
            callData,
            processed.externalParty,
            processed.isChild
        );

        // Create message with processed data
        const message = await queries.createMessage({
            conversationId: conversation.id,
            twilioSid: callData.sid,
            direction: processed.direction,  // ✅ From microservice
            status: processed.status,         // ✅ Normalized status
            fromNumber: callData.from,
            toNumber: callData.to,
            duration: callData.duration,
            price: callData.price,
            priceUnit: callData.priceUnit,
            startTime: callData.startTime,
            endTime: callData.endTime,
            recordingUrl: null,
            parentCallSid: callData.parentCallSid,
            metadata: {
                answered_by: callData.answeredBy,
                queue_time: callData.queueTime,
                twilio_direction: callData.direction,
                twilio_status: callData.status,
                actual_direction: processed.direction,
                display_status: processed.status,
                ...processed.metadata
            },
        });

        // Update conversation last message time
        await queries.updateConversationLastMessage(
            conversation.id,
            callData.startTime
        );

        console.log(`  ✅ Synced call: ${twilioCall.sid} (${processed.direction} - Status: ${processed.status})`);
        return true;
    } catch (error) {
        console.error(`Error syncing call ${twilioCall.sid}:`, error);
        return false;
    }
}

/**
 * Transform Twilio call object to our format
 */
function transformTwilioCall(twilioCall) {
    return {
        sid: twilioCall.sid,
        from: twilioCall.from,
        fromFormatted: twilioCall.fromFormatted || twilioCall.from,
        to: twilioCall.to,
        toFormatted: twilioCall.toFormatted || twilioCall.to,
        direction: twilioCall.direction,
        status: twilioCall.status,
        startTime: twilioCall.startTime ? new Date(twilioCall.startTime) : null,
        endTime: twilioCall.endTime ? new Date(twilioCall.endTime) : null,
        duration: parseInt(twilioCall.duration) || 0,
        price: twilioCall.price ? parseFloat(twilioCall.price) : null,
        priceUnit: twilioCall.priceUnit || 'USD',
        parentCallSid: twilioCall.parentCallSid || null,
        answeredBy: twilioCall.answeredBy,
        queueTime: twilioCall.queueTime,
    };
}

/**
 * Helper: Check if a number is a SIP address (internal routing)
 */
function isSIPAddress(number) {
    return number && number.toLowerCase().startsWith('sip:');
}

/**
 * Group call into conversation by phone number
 * Determines conversation based on external party (now provided by CallProcessor)
 * 
 * IMPORTANT: If call is a child call, group it with parent's conversation
 * 
 * @param {Object} callData - Transformed Twilio call
 * @param {Object} externalParty - { number, formatted } from CallProcessor
 * @param {boolean} isChild - Whether this is a child call
 */
async function groupCallIntoConversation(callData, externalParty, isChild) {
    // FIRST: Check if this is a child call (has parent_call_sid)
    // If yes, find parent's conversation and use that
    if (isChild) {
        const parentMessage = await queries.findMessageByTwilioSid(callData.parentCallSid);
        if (parentMessage) {
            // Use parent's conversation
            const parentConversation = await queries.getConversationById(parentMessage.conversation_id);

            console.log(`📎 Child call ${callData.sid} grouped with parent ${callData.parentCallSid} in conversation ${parentConversation.id}`);

            // Return parent's conversation details
            return {
                contact: { id: parentConversation.contact_id },
                conversation: parentConversation
            };
        }
        // If parent not found, fall through to normal grouping
        console.warn(`⚠️  Parent call ${callData.parentCallSid} not found for child ${callData.sid}`);
    }

    // NORMAL GROUPING (no parent or parent not found)
    // Use formatted phone number from CallProcessor as unique identifier
    // This ensures all SIP URI variations map to the same contact:
    //   +15085140320 → +1 (508) 514-0320
    //   sip:+15085140320@... → +1 (508) 514-0320
    const contact = await queries.findOrCreateContact(
        externalParty.formatted,
        externalParty.formatted
    );

    // Find or create conversation
    const subject = `Calls with ${externalParty.formatted}`;
    const conversation = await queries.findOrCreateConversation(
        contact.id,
        externalParty.formatted,
        subject
    );

    return { contact, conversation };
}

/**
 * Sync recent calls (last hour)
 * Used for periodic sync
 */
async function syncRecentCalls() {
    const oneHourAgo = new Date();
    oneHourAgo.setHours(oneHourAgo.getHours() - 1);

    try {
        const calls = await client.calls.list({
            startTimeAfter: oneHourAgo,
            limit: 50,
        });

        console.log(`🔄 Found ${calls.length} recent calls`);

        let synced = 0;
        for (const call of calls) {
            const result = await syncCall(call);
            if (result) synced++;
        }

        console.log(`✅ Recent sync: ${synced} new calls`);
        return synced;
    } catch (error) {
        console.error('Error syncing recent calls:', error);
        return 0;
    }
}

/**
 * Sync today's calls (from 00:00 EST to now)
 * Fetches all calls from the start of the current day in EST timezone
 */
async function syncTodayCalls() {
    try {
        // Get today's date at midnight in local time (EST)
        // JavaScript Date automatically uses the system's timezone
        const todayMidnight = new Date();
        todayMidnight.setHours(0, 0, 0, 0);

        console.log(`📞 Syncing calls from today (${todayMidnight.toLocaleString('en-US', { timeZone: 'America/New_York' })} EST)...`);
        console.log(`   UTC equivalent: ${todayMidnight.toISOString()}`);

        // Twilio SDK handles timezone conversion automatically
        // We pass the Date object and it converts to UTC for the API
        const calls = await client.calls.list({
            startTimeAfter: todayMidnight,
            limit: 200  // Sufficient for one day's worth of calls
        });

        console.log(`📋 Found ${calls.length} calls from today`);

        // ✅ SORT: Process parent calls BEFORE child calls
        // This ensures parent exists in DB when child tries to find it
        // Without this, child calls create duplicate conversations
        calls.sort((a, b) => {
            // Calls without parentCallSid go first
            if (!a.parentCallSid && b.parentCallSid) return -1;
            if (a.parentCallSid && !b.parentCallSid) return 1;
            // Otherwise maintain chronological order
            return new Date(a.startTime) - new Date(b.startTime);
        });

        let synced = 0;
        let skipped = 0;

        for (const call of calls) {
            const result = await syncCall(call);
            if (result) {
                synced++;
            } else {
                skipped++;
            }
        }

        console.log(`✅ Today's sync complete: ${synced} synced, ${skipped} skipped (${calls.length} total)`);
        return { synced, skipped, total: calls.length };
    } catch (error) {
        console.error('Error syncing today\'s calls:', error);
        throw error;
    }
}

module.exports = {
    syncHistoricalCalls,
    syncRecentCalls,
    syncTodayCalls,
    syncCall,
};
