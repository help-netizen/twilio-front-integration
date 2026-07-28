'use strict';

/**
 * Shared document-email wrapper. Existing invoice callers pass operator copy;
 * server-rendered document emails may opt into preformatted, already-escaped
 * HTML while retaining the same outer email seam.
 */
function buildEmailBody(message, link, { preformatted = false } = {}) {
    const content = preformatted
        ? String(message || '')
        : String(message || '').replace(/\r\n|\r|\n/g, '<br>');
    const anchor = link ? `<p><a href="${link}">View &amp; pay your invoice online</a></p>` : '';
    return `<div>${content}</div>${anchor}`;
}

module.exports = {
    buildEmailBody,
};
