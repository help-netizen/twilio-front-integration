import { describe, expect, it, vi } from 'vitest';
import type { ImageCompressionResult } from '../../lib/imageCompression';
import {
    NOTE_ATTACHMENT_MAX_FILE_SIZE,
    prepareImageAttachmentForUpload,
} from './noteAttachmentPreparation';

describe('prepareImageAttachmentForUpload', () => {
    it('rejects an image that remains over 10 MiB after compression', async () => {
        const input = new File([new Uint8Array([1])], 'oversized.png', { type: 'image/png' });
        const output = new File(
            [new Uint8Array(NOTE_ATTACHMENT_MAX_FILE_SIZE + 1)],
            'oversized.jpg',
            { type: 'image/jpeg' },
        );
        const result: ImageCompressionResult = {
            file: output,
            compressed: true,
            reason: 'compressed',
            original: { width: 6000, height: 4000, bytes: NOTE_ATTACHMENT_MAX_FILE_SIZE + 2 },
            output: { width: 2560, height: 1707, bytes: output.size },
        };
        const compress = vi.fn(async () => result);

        await expect(prepareImageAttachmentForUpload(input, compress))
            .rejects.toThrow('"oversized.png" is still larger than 10 MB after compression');
        expect(compress).toHaveBeenCalledWith(input);
    });
});
