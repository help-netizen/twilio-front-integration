import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    compressImageForUpload,
    compressImagesForUpload,
    DEFAULT_IMAGE_COMPRESSION_OPTIONS,
} from './imageCompression';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('compressImageForUpload', () => {
    it('downscales the long edge to 2560px and encodes at JPEG quality 0.8', async () => {
        const close = vi.fn();
        const bitmap = { width: 4000, height: 3000, close } as unknown as ImageBitmap;
        const createImageBitmapMock = vi.fn(async () => bitmap);
        const drawImage = vi.fn();
        const fillRect = vi.fn();
        const context = {
            imageSmoothingEnabled: false,
            imageSmoothingQuality: 'low',
            fillStyle: '',
            fillRect,
            drawImage,
        } as unknown as CanvasRenderingContext2D;
        const toBlob = vi.fn((callback: BlobCallback, type?: string) => {
            callback(new Blob([new Uint8Array(1024)], { type }));
        });
        const canvas = {
            width: 0,
            height: 0,
            getContext: vi.fn(() => context),
            toBlob,
        } as unknown as HTMLCanvasElement;

        vi.stubGlobal('window', { createImageBitmap: createImageBitmapMock });
        vi.stubGlobal('createImageBitmap', createImageBitmapMock);
        vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });

        const input = new File([new Uint8Array(800 * 1024)], 'photo.png', { type: 'image/png' });
        const result = await compressImageForUpload(input);

        expect(result.compressed).toBe(true);
        expect(result.output).toEqual({ width: 2560, height: 1920, bytes: 1024 });
        expect(result.file.name).toBe('photo.jpg');
        expect(result.file.type).toBe('image/jpeg');
        expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2560, 1920);
        expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.8);
        expect(createImageBitmapMock).toHaveBeenCalledWith(input, expect.objectContaining({ imageOrientation: 'from-image' }));
        expect(close).toHaveBeenCalledOnce();
    });

    it('passes files at or below 750 KiB through without decoding', async () => {
        const createImageBitmapMock = vi.fn();
        vi.stubGlobal('window', { createImageBitmap: createImageBitmapMock });
        vi.stubGlobal('createImageBitmap', createImageBitmapMock);
        const input = new File(
            [new Uint8Array(DEFAULT_IMAGE_COMPRESSION_OPTIONS.skipBelowBytes)],
            'small.jpg',
            { type: 'image/jpeg' },
        );

        const result = await compressImageForUpload(input);

        expect(result.file).toBe(input);
        expect(result.reason).toBe('already-small');
        expect(createImageBitmapMock).not.toHaveBeenCalled();
    });

    it('passes a non-image through byte-identically', async () => {
        const bytes = new Uint8Array([0, 255, 17, 42]);
        const input = new File([bytes], 'document.pdf', { type: 'application/pdf' });

        const result = await compressImageForUpload(input);

        expect(result.file).toBe(input);
        expect(result.reason).toBe('not-image');
        expect(new Uint8Array(await result.file.arrayBuffer())).toEqual(bytes);
    });

    it('passes an undecodable HEIC through unchanged', async () => {
        const createImageBitmapMock = vi.fn(async () => {
            throw new Error('unsupported');
        });
        const createObjectURL = vi.fn(() => 'blob:heic');
        const revokeObjectURL = vi.fn();
        class FailingImage {
            decoding = '';
            naturalWidth = 0;
            naturalHeight = 0;
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;

            set src(_value: string) {
                queueMicrotask(() => this.onerror?.());
            }
        }

        vi.stubGlobal('window', { createImageBitmap: createImageBitmapMock });
        vi.stubGlobal('createImageBitmap', createImageBitmapMock);
        vi.stubGlobal('Image', FailingImage);
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
        const input = new File([new Uint8Array(800 * 1024)], 'photo.heic', { type: 'image/heic' });

        const result = await compressImageForUpload(input);

        expect(result.file).toBe(input);
        expect(result.reason).toBe('decode-unsupported');
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:heic');
    });

    it('yields once between serial files', async () => {
        const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
            callback({ didTimeout: false, timeRemaining: () => 10 });
            return 1;
        });
        vi.stubGlobal('window', { requestIdleCallback });
        const first = new File([new Uint8Array([1])], 'one.pdf', { type: 'application/pdf' });
        const second = new File([new Uint8Array([2])], 'two.pdf', { type: 'application/pdf' });

        const results = await compressImagesForUpload([first, second]);

        expect(results.map(result => result.file)).toEqual([first, second]);
        expect(requestIdleCallback).toHaveBeenCalledOnce();
    });
});
