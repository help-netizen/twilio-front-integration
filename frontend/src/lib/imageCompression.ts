const JPEG_MIME_TYPE = 'image/jpeg';
const DEFAULT_SKIP_BELOW_BYTES = 750 * 1024;

export const DEFAULT_IMAGE_COMPRESSION_OPTIONS = {
    maxLongEdge: 2560,
    quality: 0.8,
    skipBelowBytes: DEFAULT_SKIP_BELOW_BYTES,
} as const;

export interface ImageCompressionOptions {
    maxLongEdge?: number;
    quality?: number;
    skipBelowBytes?: number;
}

export interface ImageMetrics {
    width: number | null;
    height: number | null;
    bytes: number;
}

export type ImageCompressionReason =
    | 'compressed'
    | 'not-image'
    | 'animation-preserved'
    | 'already-small'
    | 'decode-unsupported'
    | 'not-smaller';

export interface ImageCompressionResult {
    /** The file to append to FormData. This is the original when compression is skipped. */
    file: File;
    compressed: boolean;
    reason: ImageCompressionReason;
    original: ImageMetrics;
    output: ImageMetrics;
}

export interface ImageCompressionProgress {
    completed: number;
    total: number;
    file: File;
}

interface DecodedImage {
    source: CanvasImageSource;
    width: number;
    height: number;
    release: () => void;
}

function unchanged(file: File, reason: Exclude<ImageCompressionReason, 'compressed'>, width: number | null = null, height: number | null = null): ImageCompressionResult {
    const metrics = { width, height, bytes: file.size };
    return { file, compressed: false, reason, original: metrics, output: metrics };
}

function isImage(file: File): boolean {
    return file.type.toLowerCase().startsWith('image/');
}

function shouldPreserveAnimation(file: File): boolean {
    const mime = file.type.toLowerCase();
    return mime === 'image/gif' || mime === 'image/webp';
}

function outputFilename(inputName: string): string {
    const withoutExtension = inputName.replace(/\.[^./\\]+$/, '');
    return `${withoutExtension || 'image'}.jpg`;
}

function validateOptions(options: Required<ImageCompressionOptions>): void {
    if (!Number.isFinite(options.maxLongEdge) || options.maxLongEdge <= 0) {
        throw new Error('maxLongEdge must be greater than zero');
    }
    if (!Number.isFinite(options.quality) || options.quality <= 0 || options.quality > 1) {
        throw new Error('quality must be greater than zero and at most one');
    }
    if (!Number.isFinite(options.skipBelowBytes) || options.skipBelowBytes < 0) {
        throw new Error('skipBelowBytes must be zero or greater');
    }
}

async function decodeWithImageElement(file: File): Promise<DecodedImage> {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = 'async';

    try {
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error(`The browser could not decode ${file.name}`));
            image.src = objectUrl;
        });

        return {
            source: image,
            width: image.naturalWidth,
            height: image.naturalHeight,
            release: () => URL.revokeObjectURL(objectUrl),
        };
    } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
    }
}

async function decodeImage(file: File): Promise<DecodedImage> {
    if ('createImageBitmap' in window) {
        try {
            const bitmap = await createImageBitmap(file, {
                imageOrientation: 'from-image',
                premultiplyAlpha: 'default',
                colorSpaceConversion: 'default',
            });
            return {
                source: bitmap,
                width: bitmap.width,
                height: bitmap.height,
                release: () => bitmap.close(),
            };
        } catch {
            // Safari's image element decoder supports some formats (notably HEIC)
            // that createImageBitmap may reject, so try that path before failing.
        }
    }

    return decodeWithImageElement(file);
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (!blob) {
                reject(new Error('The browser could not encode the compressed image'));
                return;
            }
            if (blob.type !== JPEG_MIME_TYPE) {
                reject(new Error('This browser does not support JPEG canvas encoding'));
                return;
            }
            resolve(blob);
        }, JPEG_MIME_TYPE, quality);
    });
}

/**
 * Downscale and re-encode one browser-decodable photo for upload.
 *
 * EXIF orientation is applied by the decoder and baked into the JPEG pixels. The
 * output intentionally carries no EXIF metadata, so it remains upright everywhere.
 */
export async function compressImageForUpload(file: File, overrides: ImageCompressionOptions = {}): Promise<ImageCompressionResult> {
    const options: Required<ImageCompressionOptions> = {
        ...DEFAULT_IMAGE_COMPRESSION_OPTIONS,
        ...overrides,
    };
    validateOptions(options);

    if (!isImage(file)) return unchanged(file, 'not-image');
    if (shouldPreserveAnimation(file)) return unchanged(file, 'animation-preserved');
    if (file.size <= options.skipBelowBytes) return unchanged(file, 'already-small');

    let decoded: DecodedImage;
    try {
        decoded = await decodeImage(file);
    } catch {
        // Keep the existing upload path for browser-unsupported formats (notably
        // HEIC). The server already accepts them; compression is best-effort.
        return unchanged(file, 'decode-unsupported');
    }

    const canvas = document.createElement('canvas');
    try {
        const scale = Math.min(1, options.maxLongEdge / Math.max(decoded.width, decoded.height));
        const width = Math.max(1, Math.round(decoded.width * scale));
        const height = Math.max(1, Math.round(decoded.height * scale));
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('The browser could not create an image canvas');

        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(decoded.source, 0, 0, width, height);

        const blob = await canvasToJpeg(canvas, options.quality);
        const originalMetrics = { width: decoded.width, height: decoded.height, bytes: file.size };
        if (blob.size >= file.size) {
            return {
                ...unchanged(file, 'not-smaller', decoded.width, decoded.height),
                original: originalMetrics,
            };
        }

        const output = new File([blob], outputFilename(file.name), {
            type: JPEG_MIME_TYPE,
            lastModified: file.lastModified,
        });
        return {
            file: output,
            compressed: true,
            reason: 'compressed',
            original: originalMetrics,
            output: { width, height, bytes: output.size },
        };
    } finally {
        decoded.release();
        // Release the large backing store promptly on memory-constrained phones.
        canvas.width = 0;
        canvas.height = 0;
    }
}

/** Give the browser an opportunity to paint between expensive image decodes. */
export function yieldToMainThread(): Promise<void> {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        return new Promise(resolve => window.requestIdleCallback(() => resolve(), { timeout: 100 }));
    }
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        return new Promise(resolve => window.requestAnimationFrame(() => resolve()));
    }
    return new Promise(resolve => setTimeout(resolve, 0));
}

/** Process selections serially so only one full-resolution decode is resident. */
export async function compressImagesForUpload(
    files: readonly File[],
    options: ImageCompressionOptions = {},
    onProgress?: (progress: ImageCompressionProgress) => void,
): Promise<ImageCompressionResult[]> {
    const results: ImageCompressionResult[] = [];
    for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (!file) continue;
        if (index > 0) await yieldToMainThread();
        results.push(await compressImageForUpload(file, options));
        onProgress?.({ completed: index + 1, total: files.length, file });
    }
    return results;
}
