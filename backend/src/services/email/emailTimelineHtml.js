'use strict';

/**
 * Pure HTML quote/thread stripper for Pulse email projections.
 *
 * Raw email HTML remains stored unchanged. This module parses a display copy,
 * removes recognized quoted-history boundaries, and returns only the new-message
 * HTML. The caller must still treat the result as untrusted HTML and sanitize it
 * client-side before rendering.
 */
const { DOMParser } = require('linkedom');

const MAX_HTML_BYTES = 1024 * 1024;
const RE_ON_WROTE = /^\s*On\s.+\swrote:\s*$/;
const RE_ON_START = /^\s*On\s.+$/;
const RE_WROTE_END = /wrote:\s*$/;
const RE_BORDER_TOP_SOLID = /border-top\s*:[^;]*solid/i;
const ZERO_WIDTH_RE = /[\u200b\u200c\u200d\ufeff]/g;
const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'DIV', 'FOOTER', 'H1', 'H2', 'H3',
    'H4', 'H5', 'H6', 'HEADER', 'LI', 'P', 'SECTION', 'TABLE', 'TR',
]);

function isWhitespaceOnly(node) {
    if (node.nodeType === 8) return true;
    return node.nodeType === 3 && String(node.textContent || '').trim() === '';
}

function precedingMeaningfulSibling(node) {
    let previous = node.previousSibling;
    while (previous && isWhitespaceOnly(previous)) previous = previous.previousSibling;
    return previous;
}

function isAttributionText(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    return RE_ON_WROTE.test(normalized)
        || (RE_ON_START.test(normalized) && RE_WROTE_END.test(normalized));
}

function textWithBreaks(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1) return '';

    const tagName = String(node.tagName || '').toUpperCase();
    if (tagName === 'BR') return '\n';
    if (tagName === 'SCRIPT' || tagName === 'STYLE') return '';

    let text = '';
    for (let child = node.firstChild; child; child = child.nextSibling) {
        text += textWithBreaks(child);
    }
    return BLOCK_TAGS.has(tagName) ? `${text}\n` : text;
}

function isOutlookHeaderRun(node) {
    const text = textWithBreaks(node)
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim();
    if (!/^From\s*:/i.test(text)) return false;

    const sent = text.search(/(?:^|\n|\s)(?:Sent|Date)\s*:/i);
    const to = text.search(/(?:^|\n|\s)To\s*:/i);
    if (sent < 0 || to <= sent) return false;

    // Subject is strongly reinforcing when present, but some Outlook variants
    // omit it. From + Sent/Date + To in order is the conservative minimum.
    const subject = text.search(/(?:^|\n|\s)Subject\s*:/i);
    return subject < 0 || subject > to;
}

function outermostMatch(element, selector, body) {
    let outermost = element;
    let current = element.parentElement;
    while (current && current !== body) {
        if (current.matches(selector)) outermost = current;
        current = current.parentElement;
    }
    return outermost;
}

function findOutlookBoundary(body) {
    const divs = body.querySelectorAll('div[style]');
    for (let index = 0; index < divs.length; index++) {
        const div = divs[index];
        if (!RE_BORDER_TOP_SOLID.test(div.getAttribute('style') || '')) continue;

        // Outlook desktop: the complete From/Sent/To/Subject run is INSIDE the
        // border-top div, itself wrapped by a styleless div.
        if (isOutlookHeaderRun(div)) return div;

        // Older Outlook variant: the header run is the preceding sibling. Cut
        // from the header itself so it cannot remain in the display payload.
        const previous = precedingMeaningfulSibling(div);
        if (previous && isOutlookHeaderRun(previous)) return previous;
    }
    return null;
}

function elementHasLiveImage(root) {
    const images = root.querySelectorAll('img');
    for (let index = 0; index < images.length; index++) {
        const src = images[index].getAttribute('src');
        const deferred = images[index].getAttribute('data-blanc-src');
        if ((src && src.trim()) || (deferred && deferred.trim())) return true;
    }
    return false;
}

function hasMeaningfulMedia(root) {
    return elementHasLiveImage(root)
        || root.querySelector('table') !== null
        || root.querySelector('picture') !== null;
}

function isTrailingToBodyEnd(node, body) {
    let current = node;
    while (current && current !== body) {
        for (let sibling = current.nextSibling; sibling; sibling = sibling.nextSibling) {
            if (sibling.nodeType === 3) {
                if (String(sibling.textContent || '').trim()) return false;
                continue;
            }
            if (sibling.nodeType !== 1) continue;
            if (String(sibling.textContent || '').trim()) return false;
            if (elementHasLiveImage(sibling)) return false;
            if (sibling.querySelector('table, picture') !== null) return false;
        }
        current = current.parentNode;
    }
    return true;
}

function firstTopLevelBlockquote(body) {
    for (let child = body.firstElementChild; child; child = child.nextElementSibling) {
        if (String(child.tagName).toUpperCase() === 'BLOCKQUOTE') return child;
    }
    return null;
}

function meaningfulChildren(parent) {
    const children = [];
    for (let node = parent.firstChild; node; node = node.nextSibling) {
        if (!isWhitespaceOnly(node)) children.push(node);
    }
    return children;
}

/**
 * Search every sibling container, not only BODY-level children. This reaches
 * nested Gmail attribution lines even when an Outlook wrapper surrounds the
 * complete historical chain.
 */
function findDeepAttributionBoundary(parent) {
    const children = meaningfulChildren(parent);
    for (let index = 0; index < children.length; index++) {
        const node = children[index];
        const text = String(node.textContent || '');
        if (isAttributionText(text)) return node;

        const trimmed = text.trim();
        if (RE_ON_START.test(trimmed) && !RE_WROTE_END.test(trimmed)) {
            for (let next = index + 1; next <= index + 2 && next < children.length; next++) {
                const nextText = String(children[next].textContent || '').trim();
                if (!nextText) break;
                if (RE_WROTE_END.test(nextText)) return node;
            }
        }

        if (node.nodeType === 1) {
            const nested = findDeepAttributionBoundary(node);
            if (nested) return nested;
        }
    }
    return null;
}

function earliestBoundary(body, boundaries) {
    const byNode = new Map(boundaries.map(boundary => [boundary.node, boundary]));
    function visit(parent) {
        for (let node = parent.firstChild; node; node = node.nextSibling) {
            if (byNode.has(node)) return byNode.get(node);
            if (node.nodeType === 1) {
                const nested = visit(node);
                if (nested) return nested;
            }
        }
        return null;
    }
    return visit(body);
}

function findBoundary(body) {
    const highConfidence = [];
    const gmail = body.querySelector('.gmail_quote');
    if (gmail) {
        highConfidence.push({
            node: outermostMatch(gmail, '.gmail_quote', body),
            checkAttribution: true,
        });
    }

    const cite = body.querySelector('blockquote[type="cite"]');
    if (cite) {
        highConfidence.push({
            node: outermostMatch(cite, 'blockquote[type="cite"]', body),
            checkAttribution: true,
        });
    }

    const appendOnSend = body.querySelector('#appendonsend');
    if (appendOnSend) highConfidence.push({ node: appendOnSend, checkAttribution: true });

    const yahoo = body.querySelector('.yahoo_quoted');
    if (yahoo) {
        highConfidence.push({
            node: outermostMatch(yahoo, '.yahoo_quoted', body),
            checkAttribution: true,
        });
    }

    const outlook = findOutlookBoundary(body);
    if (outlook) highConfidence.push({ node: outlook, checkAttribution: false });

    if (highConfidence.length > 0) {
        return earliestBoundary(body, highConfidence);
    }

    const topBlockquote = firstTopLevelBlockquote(body);
    if (topBlockquote) {
        const previous = precedingMeaningfulSibling(topBlockquote);
        if ((previous && isAttributionText(previous.textContent))
            || isTrailingToBodyEnd(topBlockquote, body)) {
            return { node: topBlockquote, checkAttribution: true };
        }
    }

    const attribution = findDeepAttributionBoundary(body);
    return attribution ? { node: attribution, checkAttribution: false } : null;
}

function attributionSiblingStart(node) {
    const previous = precedingMeaningfulSibling(node);
    if (!previous) return null;
    const previousText = String(previous.textContent || '');
    if (isAttributionText(previousText)) return previous;

    if (RE_WROTE_END.test(previousText.trim()) && !RE_ON_START.test(previousText.trim())) {
        const beforePrevious = precedingMeaningfulSibling(previous);
        if (beforePrevious && RE_ON_START.test(String(beforePrevious.textContent || '').trim())) {
            return beforePrevious;
        }
    }
    return null;
}

function boundaryWithAttribution(node, body) {
    let current = node;
    while (current && current !== body) {
        const attribution = attributionSiblingStart(current);
        if (attribution) return attribution;
        current = current.parentNode;
    }
    return node;
}

function isEffectivelyEmpty(element) {
    const visible = textWithBreaks(element)
        .replace(ZERO_WIDTH_RE, '')
        .replace(/\s+/g, '');
    return visible.length === 0 && !hasMeaningfulMedia(element);
}

/**
 * Remove the boundary branch without deleting reply content that shares one of
 * its wrapper ancestors. At the boundary level remove the boundary and later
 * siblings; at every ancestor level remove only later siblings. Empty wrapper
 * shells created by the cut are pruned.
 */
function cutAtBoundary(boundary, body) {
    let current = boundary;
    let removeCurrent = true;

    while (current && current !== body) {
        const parent = current.parentNode;
        if (!parent) return;

        let node = removeCurrent ? current : current.nextSibling;
        while (node) {
            const next = node.nextSibling;
            parent.removeChild(node);
            node = next;
        }

        current = parent;
        removeCurrent = current !== body && isEffectivelyEmpty(current);
    }
}

function visibleTextLength(body) {
    return textWithBreaks(body)
        .replace(ZERO_WIDTH_RE, '')
        .replace(/\s+/g, '')
        .length;
}

function parseFragment(html) {
    const document = new DOMParser().parseFromString(
        '<!doctype html><html><head></head><body></body></html>',
        'text/html'
    );
    if (!document || !document.body) return null;
    document.body.innerHTML = html;
    return document.body;
}

/**
 * @param {string|null|undefined} rawHtml untrusted stored email HTML
 * @returns {string|null} stripped untrusted HTML, or null when HTML should not
 *                        be sent to Pulse (empty, oversize, parse failure, or a
 *                        recognized cut whose HTML result is near-empty)
 */
function stripTimelineHtml(rawHtml) {
    if (typeof rawHtml !== 'string' || rawHtml.trim() === '') return null;
    if (Buffer.byteLength(rawHtml, 'utf8') > MAX_HTML_BYTES) return null;

    try {
        const body = parseFragment(rawHtml);
        if (!body) return null;

        const boundary = findBoundary(body);
        if (!boundary) return rawHtml;

        const cutNode = boundary.checkAttribution
            ? boundaryWithAttribution(boundary.node, body)
            : boundary.node;
        cutAtBoundary(cutNode, body);

        // Do not fall back to raw HTML after recognizing a quote: body_text is a
        // safer display fallback and keeps the quoted thread out of the payload.
        if (visibleTextLength(body) < 2 && !hasMeaningfulMedia(body)) return null;
        return body.innerHTML;
    } catch (_error) {
        return null;
    }
}

module.exports = {
    MAX_HTML_BYTES,
    stripTimelineHtml,
};
