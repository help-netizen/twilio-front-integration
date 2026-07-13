/**
 * YELP-REPLY-FORMAT-001 — build a Yelp reply the relay's parser ACCEPTS.
 *
 * Proven on prod (thread "Ryan P.", 2026-07-13): the SAME mailbox replying to the
 * SAME inbound message got cant_parse for our bare single-part body, but was
 * ACCEPTED for the owner's Gmail-composed reply. The raw-MIME diff isolates what
 * Yelp's parser needs:
 *   1. multipart/alternative with a text/plain part (not a lone text/html), and
 *   2. the QUOTED ORIGINAL under a Gmail-style attribution line
 *      ("On <date> <sender> wrote:" + "> "-prefixed lines / a gmail_quote
 *      blockquote) — the delimiter the parser uses to cut the reply out.
 * Threading headers alone (In-Reply-To/References/threadId) are NOT enough.
 *
 * This module mirrors Gmail's reply composition closely (attribution wording,
 * "> " quoting, gmail_quote/gmail_attr classes) so the reply is indistinguishable
 * from a human mail client's.
 */

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** "Sun, Jul 12, 2026 at 10:27 PM" — Gmail's attribution date, in the company TZ. */
function formatAttributionDate(date, timeZone = 'America/New_York') {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
    }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    return `${parts.weekday}, ${parts.month} ${parts.day}, ${parts.year} at ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}

/**
 * Compose the {html, text} reply bodies: the reply text on top, then the Gmail-style
 * attribution + quoted original. `quote` = the inbound row we're answering
 * ({ body_text, body_html, from_email, from_name, gmail_internal_at }); with no
 * usable quote the reply degrades to unquoted (better a maybe-bounced reply than
 * none) — callers still send BOTH parts so the message stays multipart/alternative.
 *
 * @param {string} replyText  the agent's plain-text reply
 * @param {object|null} quote the inbound email row (or null)
 * @returns {{html: string, text: string}}
 */
function buildReplyBodies(replyText, quote) {
    const reply = String(replyText || '').trim();
    const replyHtml = `<div dir="ltr">${escapeHtml(reply).replace(/\r?\n/g, '<br>')}</div>`;

    const quotedText = quote && (quote.body_text || quote.body_html) ? String(quote.body_text || '') : null;
    if (!quote || (!quotedText && !quote.body_html)) {
        return { html: replyHtml, text: reply };
    }

    const who = quote.from_name
        ? `${quote.from_name} <${quote.from_email || ''}>`
        : `<${quote.from_email || ''}>`;
    const when = formatAttributionDate(quote.gmail_internal_at);
    const attribution = when ? `On ${when} ${who} wrote:` : `On an earlier date ${who} wrote:`;

    // text/plain: "> "-prefix every line of the original (Gmail quoting).
    const plainOriginal = quotedText || String(quote.body_html || '').replace(/<[^>]+>/g, ' ');
    const quotedPlain = plainOriginal
        .split(/\r?\n/)
        .map(line => (line.startsWith('>') ? `>${line}` : `> ${line}`))
        .join('\n');
    const text = `${reply}\n\n${attribution}\n\n${quotedPlain}\n`;

    // text/html: gmail_quote wrapper + blockquote around the original (html if we
    // have it, else the escaped plain text with <br>s).
    const originalHtml = quote.body_html
        ? String(quote.body_html)
        : escapeHtml(plainOriginal).replace(/\r?\n/g, '<br>');
    const html =
        `${replyHtml}<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(attribution)}<br></div>`
        + `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${originalHtml}</blockquote></div>`;

    return { html, text };
}

module.exports = { buildReplyBodies, formatAttributionDate, escapeHtml };
