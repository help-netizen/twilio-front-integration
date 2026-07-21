import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    compressImageForUpload,
    compressImagesForUpload,
    DEFAULT_IMAGE_COMPRESSION_OPTIONS,
} from './imageCompression';

const heicMocks = vi.hoisted(() => ({
    heicTo: vi.fn(),
    isHeic: vi.fn(),
}));

vi.mock('heic-to', () => heicMocks);

function stubCanvasOutput(outputBytes = 1024) {
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
        callback(new Blob([new Uint8Array(outputBytes)], { type }));
    });
    const canvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => context),
        toBlob,
    } as unknown as HTMLCanvasElement;
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    return { drawImage, toBlob };
}

function stubNativeDecode(width: number, height: number) {
    const close = vi.fn();
    const bitmap = { width, height, close } as unknown as ImageBitmap;
    const createImageBitmapMock = vi.fn(async () => bitmap);
    vi.stubGlobal('window', { createImageBitmap: createImageBitmapMock });
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);
    return { bitmap, close, createImageBitmapMock };
}

function stubNativeDecodeFailure() {
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
    return { createImageBitmapMock, revokeObjectURL };
}

afterEach(() => {
    vi.unstubAllGlobals();
    heicMocks.heicTo.mockReset();
    heicMocks.isHeic.mockReset();
});

describe('compressImageForUpload', () => {
    it('downscales the long edge to 1600px and encodes at JPEG quality 0.7', async () => {
        const { bitmap, close, createImageBitmapMock } = stubNativeDecode(4000, 3000);
        const { drawImage, toBlob } = stubCanvasOutput();

        const input = new File([new Uint8Array(800 * 1024)], 'photo.png', { type: 'image/png' });
        const result = await compressImageForUpload(input);

        expect(result.compressed).toBe(true);
        expect(result.output).toEqual({ width: 1600, height: 1200, bytes: 1024 });
        expect(result.file.name).toBe('photo.jpg');
        expect(result.file.type).toBe('image/jpeg');
        expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1600, 1200);
        expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.7);
        expect(createImageBitmapMock).toHaveBeenCalledWith(input, expect.objectContaining({ imageOrientation: 'from-image' }));
        expect(close).toHaveBeenCalledOnce();
    });

    it('passes non-HEIC files at or below 750 KiB through without decoding', async () => {
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

    it('converts a small natively-decodable HEIC to JPEG even when the output is larger', async () => {
        const { bitmap } = stubNativeDecode(1200, 900);
        const { drawImage } = stubCanvasOutput(200);
        const input = new File([new Uint8Array(100)], 'small.HEIC');

        const result = await compressImageForUpload(input);

        expect(result.compressed).toBe(true);
        expect(result.file).not.toBe(input);
        expect(result.file.name).toBe('small.jpg');
        expect(result.file.type).toBe('image/jpeg');
        expect(result.file.size).toBe(200);
        expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1200, 900);
        expect(heicMocks.heicTo).not.toHaveBeenCalled();
    });

    it('lazy-loads the HEIC decoder when native decoding fails, then downscales through canvas', async () => {
        const { revokeObjectURL } = stubNativeDecodeFailure();
        const close = vi.fn();
        const wasmBitmap = { width: 4000, height: 3000, close } as unknown as ImageBitmap;
        heicMocks.isHeic.mockResolvedValue(true);
        heicMocks.heicTo.mockResolvedValue(wasmBitmap);
        const { drawImage } = stubCanvasOutput();
        const input = new File([new Uint8Array(800 * 1024)], 'photo.heif', { type: 'image/heif' });

        const result = await compressImageForUpload(input);

        expect(heicMocks.isHeic).toHaveBeenCalledWith(input);
        expect(heicMocks.heicTo).toHaveBeenCalledWith({ blob: input, type: 'bitmap' });
        expect(drawImage).toHaveBeenCalledWith(wasmBitmap, 0, 0, 1600, 1200);
        expect(result.output).toEqual({ width: 1600, height: 1200, bytes: 1024 });
        expect(result.file.name).toBe('photo.jpg');
        expect(result.file.type).toBe('image/jpeg');
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:heic');
        expect(close).toHaveBeenCalledOnce();
    });

    it('errors when both native and HEIC fallback decoders fail', async () => {
        stubNativeDecodeFailure();
        heicMocks.isHeic.mockResolvedValue(true);
        heicMocks.heicTo.mockRejectedValue(new Error('corrupt HEIC'));
        const input = new File([new Uint8Array(800 * 1024)], 'corrupt.heic', { type: 'image/heic' });

        await expect(compressImageForUpload(input))
            .rejects.toThrow('"corrupt.heic" could not be decoded as HEIC/HEIF. The file may be corrupt.');
        expect(heicMocks.heicTo).toHaveBeenCalledWith({ blob: input, type: 'bitmap' });
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
