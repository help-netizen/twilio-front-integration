'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/storageService', () => ({
    generateStorageKey: jest.fn(),
    uploadFile: jest.fn(),
}));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    isImageContentType: jest.fn(),
    createThumbnailBuffer: jest.fn(),
    generateThumbnailStorageKey: jest.fn(),
}));

const {
    parseArgs,
    isExternalImageUrl,
    fileNameFromUrl,
    contentTypeFor,
    mapLimit,
    RESCUE_FIELDS,
} = require('../backend/src/cli/rescueZenbookerNoteImages');

const COMPANY = '00000000-0000-0000-0000-000000000001';

describe('ZB-IMAGE-RESCUE-001 — bringing job photos home', () => {
    describe('what counts as a photo that still lives on the vendor', () => {
        it('claims the Zenbooker CDN and Zenbooker itself', () => {
            expect(isExternalImageUrl('https://c5e3844b1ed506fdf85b718b38c96975.cdn.bubble.io/f177/IMG_1.jpeg')).toBe(true);
            expect(isExternalImageUrl('https://zenbooker.com/uploads/a.png')).toBe(true);
        });

        it('leaves everything else alone', () => {
            // A rescued photo is served from our own storage through a presigned
            // URL; re-ingesting one would duplicate the attachment on every run.
            expect(isExternalImageUrl('https://storage.albusto.com/00000000/notes/job/1/x.jpg')).toBe(false);
            // Notes also carry ordinary links a technician pasted — a parts page
            // is not a photograph and must not be downloaded as one.
            expect(isExternalImageUrl('https://www.amazon.com/dp/B00XYZ')).toBe(false);
            expect(isExternalImageUrl('https://relyhome.com/order/123')).toBe(false);
            // Hostname must match a real label, not merely contain the string.
            expect(isExternalImageUrl('https://bubble.io.evil.example/f/x.jpg')).toBe(false);
            expect(isExternalImageUrl('not a url')).toBe(false);
            expect(isExternalImageUrl(null)).toBe(false);
        });
    });

    describe('which parts of a note hold vendor files', () => {
        it('covers photographs AND documents, each archived separately', () => {
            // The first run only walked `images` and left 20 URLs behind in
            // `files` — signed work orders and part invoices on the same CDN.
            expect(RESCUE_FIELDS.map(field => field.source).sort()).toEqual(['files', 'images']);
            const archives = RESCUE_FIELDS.map(field => field.archive);
            expect(new Set(archives).size).toBe(archives.length);
            // The archive field must never be the source field, or a rescued URL
            // would be handed straight back to the next run.
            RESCUE_FIELDS.forEach(field => expect(field.archive).not.toBe(field.source));
        });
    });

    describe('naming what we store', () => {
        it('keeps the technician’s own filename', () => {
            expect(fileNameFromUrl('https://x.cdn.bubble.io/f1770252673141x42/20260204_165007.jpeg'))
                .toBe('20260204_165007.jpeg');
        });

        it('never lets a URL become a path or a shell surprise', () => {
            const name = fileNameFromUrl('https://x.cdn.bubble.io/f1/..%2F..%2Fetc%2Fpasswd');
            expect(name).not.toContain('/');
            expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
        });

        it('falls back rather than storing something unnamed', () => {
            expect(fileNameFromUrl('https://x.cdn.bubble.io/f1/')).toBe('zenbooker-image.jpg');
            expect(fileNameFromUrl('::::')).toBe('zenbooker-image.jpg');
        });
    });

    describe('deciding the content type', () => {
        it('trusts the CDN when it says something useful', () => {
            expect(contentTypeFor('a.jpeg', 'image/jpeg')).toBe('image/jpeg');
            expect(contentTypeFor('a.jpeg', 'image/png; charset=binary')).toBe('image/png');
        });

        it('falls back to the extension when the CDN shrugs', () => {
            // bubble.io serves plenty of photos as octet-stream; storing that
            // verbatim would leave the browser refusing to render its own image.
            expect(contentTypeFor('a.jpeg', 'application/octet-stream')).toBe('image/jpeg');
            expect(contentTypeFor('b.HEIC', null)).toBe('image/heic');
            expect(contentTypeFor('c.png', '')).toBe('image/png');
        });

        it('admits when it does not know', () => {
            expect(contentTypeFor('mystery', null)).toBe('application/octet-stream');
        });
    });

    describe('arguments', () => {
        it('insists on a tenant and defaults to writing nothing', () => {
            expect(() => parseArgs([])).toThrow(/company-id/);
            expect(() => parseArgs(['--company-id=nope'])).toThrow(/company-id/);
            expect(parseArgs([`--company-id=${COMPANY}`]).apply).toBe(false);
            expect(parseArgs([`--company-id=${COMPANY}`, '--apply']).apply).toBe(true);
        });

        it('rejects an unknown flag rather than silently ignoring it', () => {
            expect(() => parseArgs([`--company-id=${COMPANY}`, '--dry-run'])).toThrow(/Unknown argument/);
        });

        it('keeps concurrency polite — the CDN is a guest, not a target', () => {
            expect(() => parseArgs([`--company-id=${COMPANY}`, '--concurrency=64'])).toThrow(/1\.\.16/);
            expect(() => parseArgs([`--company-id=${COMPANY}`, '--concurrency=0'])).toThrow(/1\.\.16/);
            expect(parseArgs([`--company-id=${COMPANY}`, '--concurrency=4']).concurrency).toBe(4);
        });
    });

    describe('concurrency', () => {
        it('preserves order and never exceeds the limit', async () => {
            let running = 0;
            let peak = 0;
            const items = Array.from({ length: 20 }, (_, i) => i);
            const out = await mapLimit(items, 3, async item => {
                running += 1;
                peak = Math.max(peak, running);
                await new Promise(resolve => setTimeout(resolve, 1));
                running -= 1;
                return item * 2;
            });
            expect(peak).toBeLessThanOrEqual(3);
            expect(out).toEqual(items.map(i => i * 2));
        });

        it('handles an empty list without hanging', async () => {
            await expect(mapLimit([], 4, async () => 1)).resolves.toEqual([]);
        });
    });
});
