/**
 * EMAIL-UNREAD-002 — an outbound reply marks the thread read.
 *
 * Owner rule: answering a customer (email OR SMS) means the dispatcher has
 * read the conversation — the Pulse row must stop showing "unread". The list's
 * unread is a fan of four flags (timelines.has_unread, contacts.has_unread,
 * sms_conversations.has_unread, email_threads.unread_count); an outbound event
 * previously cleared at most the email-thread counter, so rows replied to from
 * the email workspace / Gmail / SMS composer stayed lit until manually opened.
 *
 * Guard: if an INBOUND event NEWER than the reply exists on the timeline
 * (possible via the 5-min reconciler draining an old outbound, or a race),
 * the reply does not cover it — skip clearing entirely.
 *
 * Fire-and-forget safe: never throws.
 */

const db = require('../db/connection');
const timelinesQueries = require('../db/timelinesQueries');
const contactsQueries = require('../db/contactsQueries');
const realtimeService = require('./realtimeService');

function digitsOf(...phones) {
    return [...new Set(
        phones.filter(Boolean)
            .map(p => String(p).replace(/\D/g, ''))
            .filter(d => d.length > 0)
    )];
}

/**
 * @param {string} companyId
 * @param {{timelineId:number, contactId?:number|null, replyAt?:string|Date|null}} opts
 */
async function markReadAfterReply(companyId, { timelineId, contactId = null, replyAt = null } = {}) {
    try {
        if (!companyId || !timelineId) return { skipped: 'no_timeline' };
        const replyTs = replyAt ? new Date(replyAt) : new Date();
        if (Number.isNaN(replyTs.getTime())) return { skipped: 'bad_reply_ts' };

        const { rows: tlr } = await db.query(
            `SELECT t.id, t.contact_id, t.phone_e164 AS tl_phone,
                    c.phone_e164 AS c_phone, c.secondary_phone
             FROM timelines t
             LEFT JOIN contacts c ON c.id = t.contact_id
             WHERE t.id = $1 AND t.company_id = $2`,
            [timelineId, companyId]
        );
        const tl = tlr[0];
        if (!tl) return { skipped: 'not_found' };
        const cid = contactId || tl.contact_id || null;
        const digits = digitsOf(tl.tl_phone, tl.c_phone, tl.secondary_phone);

        // Newer-inbound guard across all three channels.
        const { rows: guard } = await db.query(
            `SELECT GREATEST(
                (SELECT max(em.gmail_internal_at) FROM email_messages em
                  WHERE em.timeline_id = $1 AND em.company_id = $2 AND em.direction = 'inbound'),
                (SELECT max(c2.started_at) FROM calls c2
                  WHERE c2.timeline_id = $1 AND c2.direction ILIKE 'inbound%'),
                CASE WHEN cardinality($3::text[]) > 0 THEN
                    (SELECT max(sc.last_message_at) FROM sms_conversations sc
                      WHERE sc.company_id = $2 AND sc.last_message_direction = 'inbound'
                        AND sc.customer_digits = ANY($3::text[]))
                END
             ) AS latest_inbound`,
            [timelineId, companyId, digits]
        );
        const latestInbound = guard[0] && guard[0].latest_inbound;
        if (latestInbound && new Date(latestInbound) > replyTs) {
            return { skipped: 'newer_inbound' };
        }

        // Clear the same unread fan the manual mark-read route clears.
        await timelinesQueries.markTimelineRead(timelineId);
        if (cid) {
            await contactsQueries.markContactRead(cid).catch(() => { });
        }
        if (digits.length > 0) {
            await db.query(
                `UPDATE sms_conversations SET has_unread = false, last_read_at = now(), updated_at = now()
                 WHERE company_id = $1 AND has_unread = true AND customer_digits = ANY($2::text[])`,
                [companyId, digits]
            );
        }
        if (cid) {
            await db.query(
                `UPDATE email_threads et SET unread_count = 0, updated_at = now()
                 WHERE et.company_id = $2 AND et.unread_count > 0
                   AND et.id IN (
                     SELECT em.thread_id
                     FROM email_messages em
                     JOIN contact_emails ce ON ce.email_normalized = lower(trim(em.from_email))
                     WHERE em.company_id = $2 AND em.direction = 'inbound' AND ce.contact_id = $1
                   )`,
                [cid, companyId]
            );
        }

        try {
            realtimeService.broadcast('timeline.read', {
                company_id: companyId,
                timelineId: Number(timelineId),
            });
        } catch { /* non-blocking */ }

        return { cleared: true };
    } catch (err) {
        console.error('[ReplyRead] markReadAfterReply failed:', err.message);
        return { error: err.message };
    }
}

module.exports = { markReadAfterReply };
