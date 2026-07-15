'use strict';

const INVISIBLE_CHARS_RE = /[\u00AD\u034F\u200B-\u200D\u2060\uFEFF]/g;
const FOOTER_MARKERS = [
    /respond now/i,
    /or simply respond by replying/i,
    /or reply directly to this email/i,
    /this email was sent to/i,
    /manage\s+(?:\[\s*)?email preferences/i,
    /unsubscribe/i,
    /business\.yelp\.com/i,
    /yelp inc/i,
    /©\s*20/i,
];
const MARKDOWN_LINK_RE = /\[[^\]]*\]\(\s*[^)]*\)/g;
const BARE_URL_RE = /https?:\/\/\S+/gi;
const FORM_LABEL_RES = [
    /^are there any other details (?:you(?:'|’)d|you would) like to share\??$/i,
    /^in what location do you need (?:the|this) service\??$/i,
    /^what(?:(?:'|’)s| is) the best\b.*\b(?:reach|contact)\s+you\b.*\??$/i,
];

function unwrapChrome(line) {
    return line.trim()
        .replace(/^[|\s]+/, '')
        .replace(/[|\s]+$/, '')
        .replace(/^#{1,6}\s*/, '')
        .replace(/^\*{1,2}\s*/, '')
        .replace(/\s*\*{1,2}$/, '')
        .trim();
}

function stripLinks(line) {
    return line.replace(MARKDOWN_LINK_RE, '').replace(BARE_URL_RE, '').trim();
}

function isBusinessAddressLine(line) {
    return /^\d+\s+\S.*?,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\s*$/.test(line.trim());
}

function isCityStateLine(line) {
    return /^[A-Za-z][A-Za-z .'-]*,\s*[A-Z]{2}$/.test(unwrapChrome(line));
}

function isBoilerplateLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return false;

    if (/^hi\b.*\bhas replied to your message\b/i.test(trimmed)) return true;
    if (/\brequested a quote from\b/i.test(trimmed)) return true;

    const unwrapped = unwrapChrome(trimmed);
    if (/^(?:you have a )?new\b.*\brequest\b/i.test(unwrapped)) return true;
    if (/^sent to\b/i.test(unwrapped)) return true;
    if (/\breply to stay eligible\b/i.test(unwrapped)) return true;
    if (/\bstay responsive\b/i.test(unwrapped)) return true;
    if (/\bresponse rate\b/i.test(unwrapped)) return true;
    if (/\baffects your ranking\b/i.test(unwrapped)) return true;
    if (/^your response time\b/i.test(unwrapped)) return true;
    if (/^keep track of incoming leads\b/i.test(unwrapped)) return true;
    if (/^\d+\s+minutes?$/i.test(unwrapped)) return true;
    if (/^\d+(?:\.\d+)?%$/.test(unwrapped)) return true;
    if (FORM_LABEL_RES.some(pattern => pattern.test(unwrapped))) return true;
    if (/^for business$/i.test(unwrapped)) return true;
    if (/^new message from\b/i.test(unwrapped)) return true;

    if (/^[\s|-]+$/.test(trimmed)) return true;
    if (/^[\s|\d]+$/.test(trimmed) && (trimmed.includes('|') || /^\d$/.test(trimmed))) return true;

    return false;
}

/**
 * Extract customer-authored text from Yelp first-message and reply notifications.
 * Pure, null-safe, and deliberately fail-closed when the wrapper has no content.
 * @param {*} rawBody
 * @returns {string}
 */
function extractYelpReplyBody(rawBody) {
    try {
        if (rawBody == null) return '';
        const lines = String(rawBody).replace(INVISIBLE_CHARS_RE, '').split(/\r\n?|\n/);
        const footerIndex = lines.findIndex(line => FOOTER_MARKERS.some(marker => marker.test(line)));
        const contentLines = footerIndex >= 0 ? lines.slice(0, footerIndex) : lines;
        const kept = [];
        let previousBlank = false;
        let expectBusinessAddress = false;
        let expectProfileLocation = false;

        for (const line of contentLines) {
            if (/\]\(https?:\/\/[^)]*(?:user_details|\/user\/)/i.test(line)) {
                expectProfileLocation = true;
            }
            const value = stripLinks(line);
            if (!value) {
                if (kept.length && !previousBlank) kept.push('');
                previousBlank = true;
                continue;
            }
            if (/^sent to\b/i.test(unwrapChrome(value))) {
                expectBusinessAddress = true;
                continue;
            }
            if (isBoilerplateLine(value)) continue;
            if (expectBusinessAddress) {
                expectBusinessAddress = false;
                if (isBusinessAddressLine(value)) continue;
            }
            if (expectProfileLocation) {
                expectProfileLocation = false;
                if (isCityStateLine(value)) continue;
            }
            if (/^\*{1,2}[^*]+,\s*[A-Z]{2}\*{1,2}$/.test(value) && isCityStateLine(value)) continue;
            kept.push(value);
            previousBlank = false;
        }

        const result = kept.join('\n').trim();
        const alphanumericCount = (result.match(/[A-Za-z0-9]/g) || []).length;
        return alphanumericCount >= 3 ? result : '';
    } catch (_error) {
        return '';
    }
}

module.exports = { extractYelpReplyBody };
