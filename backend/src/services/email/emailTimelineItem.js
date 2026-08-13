'use strict';

const { toTimelineBody, htmlToText } = require('./emailTimelineBody');
const { stripTimelineHtml } = require('./emailTimelineHtml');

/**
 * Shared Pulse REST/SSE/send projection for an email_messages row.
 * Stored body_text/body_html stay raw; only this display DTO is stripped.
 */
function projectEmailTimelineItem(row) {
    if (!row) return null;

    const isOutbound = typeof row.is_outbound === 'boolean'
        ? row.is_outbound
        : row.direction === 'outbound';
    const timelineText = typeof row.body_text === 'string' && row.body_text.trim() !== ''
        ? row.body_text
        : htmlToText(row.body_html);
    const item = {
        id: row.id,
        type: 'email',
        direction: row.direction,
        is_outbound: isOutbound,
        from_email: row.from_email || null,
        from_name: row.from_name || null,
        to_email: row.to_recipients_json || [],
        subject: row.subject || null,
        body_text: toTimelineBody(timelineText, { snippet: row.snippet }),
        display_html: stripTimelineHtml(row.body_html),
        // EMAIL-TS-ORDER-001: for outbound rows our own insert time is the send
        // moment and is trustworthy; provider dates on agent-path outbound have
        // shown hour-scale timezone skew. Inbound keeps the provider date.
        sent_at: isOutbound
            ? (row.created_at || row.gmail_internal_at)
            : (row.gmail_internal_at || row.created_at),
        thread_id: row.thread_id,
        sent_by_user_email: row.sent_by_user_email || null,
    };

    // Linked/imported rows carry company_id for tenant-scoped SSE broadcasting;
    // read-query rows intentionally omit it from the REST DTO as before.
    if (Object.prototype.hasOwnProperty.call(row, 'company_id')) {
        item.company_id = row.company_id || null;
    }
    return item;
}

module.exports = { projectEmailTimelineItem };
