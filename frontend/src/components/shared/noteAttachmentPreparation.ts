import { compressImageForUpload, type ImageCompressionResult } from '../../lib/imageCompression';

export const NOTE_ATTACHMENT_MAX_FILE_SIZE = 10 * 1024 * 1024;

type ImageCompressor = (file: File) => Promise<ImageCompressionResult>;

/**
 * Prepare an image for staging, then enforce the upload limit on the actual file
 * that will be sent. Unsupported image formats pass through the compressor
 * unchanged and are checked here like any other output.
 */
export async function prepareImageAttachmentForUpload(
    file: File,
    compress: ImageCompressor = compressImageForUpload,
): Promise<ImageCompressionResult> {
    const result = await compress(file);
    if (result.file.size > NOTE_ATTACHMENT_MAX_FILE_SIZE) {
        throw new Error(`"${file.name}" is still larger than 10 MB after compression`);
    }
    return result;
}
