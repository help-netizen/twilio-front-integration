'use strict';

const INVISIBLE_CHARS_RE = /[\u00AD\u034F\u200B-\u200D\u2060\uFEFF]/g;
const FOOTER_MARKERS = [
    /respond now/i,
    /or simply respond by replying/i,
    /this email was sent to/i,
    /manage\s+(?:\[\s*)?email preferences/i,
    /unsubscribe/i,
    /business\.yelp\.com/i,
    /yelp inc/i,
    /©\s*20/i,
];

function isBoilerplateLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return false;

    if (/^hi\b.*\bhas replied to your message\b/i.test(trimmed)) return true;
    if (/\brequested a quote from\b/i.test(trimmed)) return true;

    const unwrapped = trimmed
        .replace(/^[|\s]+/, '')
        .replace(/[|\s]+$/, '')
        .replace(/^\*{1,2}\s*/, '')
        .replace(/\s*\*{1,2}$/, '')
        .trim();
    if (/^reply to stay eligible\b/i.test(unwrapped)) return true;
    if (/^for business$/i.test(unwrapped)) return true;
    if (/^new message from\b/i.test(unwrapped)) return true;

    if (/^[\s|-]+$/.test(trimmed)) return true;
    if (/^[\s|\d]+$/.test(trimmed)) return true;
    if (/^\s*(?:\|\s*)*(?:\*{1,2}\s*)?\[[^\]]*\]\(\s*https?:\/\/[^)]*\)(?:\s*\*{1,2})?(?:\s*\|)*\s*$/i.test(trimmed)) return true;
    if (/^\s*(?:\|\s*)*https?:\/\/\S+(?:\s*\|)*\s*$/i.test(trimmed)) return true;
    if (/^[A-Za-z][A-Za-z .'-]*,\s*[A-Z]{2}$/.test(unwrapped)) return true;

    return false;
}

/**
 * Extract customer-authored text from a Yelp respondable-email notification.
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

        for (const line of contentLines) {
            if (isBoilerplateLine(line)) continue;
            const value = line.trim();
            if (!value) {
                if (kept.length && !previousBlank) kept.push('');
                previousBlank = true;
                continue;
            }
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
