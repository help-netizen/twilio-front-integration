'use strict';

/**
 * Convert a manually-authored plain-text email body to an HTML alternative.
 * The text/plain MIME part keeps the original input; this helper only builds
 * the corresponding HTML part.
 */

function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function preserveLeadingIndent(line) {
    const leadingWhitespace = line.match(/^[ \t]+/);
    if (!leadingWhitespace) return escapeHtml(line);

    const indent = leadingWhitespace[0]
        .replace(/ /g, '&nbsp;')
        .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
    return indent + escapeHtml(line.slice(leadingWhitespace[0].length));
}

function plainTextToHtml(text) {
    if (typeof text !== 'string' || text === '') return '';

    return text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(preserveLeadingIndent)
        .join('<br>\r\n');
}

module.exports = { plainTextToHtml };
