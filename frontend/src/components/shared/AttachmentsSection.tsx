/**
 * Universal AttachmentsSection — thumbnail grid + inline preview + fullscreen viewer.
 * Reusable across payments, email, notes, and any panel with attachments.
 */
import { useState } from 'react';
import {
    FileText, ChevronLeft, ChevronRight as ChevronRightIcon,
    ExternalLink, RotateCcw,
} from 'lucide-react';
import { FullscreenImageViewer, RotatableImage } from './FullscreenImageViewer';

// ─── Public interface ────────────────────────────────────────────────────────

export interface AttachmentItem {
    url: string;
    filename: string;
    kind: 'image' | 'file';
}

interface AttachmentsSectionProps {
    attachments: AttachmentItem[];
    label?: string;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const eyebrow: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.14em',
    textTransform: 'uppercase' as const,
    color: 'var(--blanc-ink-3)',
    marginBottom: '8px',
};

// ─── Component ───────────────────────────────────────────────────────────────

export function AttachmentsSection({ attachments, label = 'Attachments' }: AttachmentsSectionProps) {
    const [galleryIndex, setGalleryIndex] = useState(0);
    const [rotation, setRotation] = useState(0);
    const [showLargePreview, setShowLargePreview] = useState(false);
    const [fullscreen, setFullscreen] = useState(false);

    if (attachments.length === 0) return null;

    // Pre-compute image-only list and index mapping for fullscreen viewer
    const imageOnly = attachments.filter(a => a.kind === 'image').map(a => ({ url: a.url, filename: a.filename }));
    const galleryToImageIndex = (() => {
        let count = 0;
        for (let j = 0; j < galleryIndex; j++) {
            if (attachments[j]?.kind === 'image') count++;
        }
        return attachments[galleryIndex]?.kind === 'image' ? count : 0;
    })();

    return (
        <div>
            <p style={eyebrow}>{label} ({attachments.length})</p>

            {/* Thumbnail grid */}
            <div className="flex gap-2 overflow-x-auto pb-1">
                {attachments.map((att, i) => (
                    <button
                        key={i}
                        onClick={() => { setGalleryIndex(i); setShowLargePreview(true); setRotation(0); }}
                        className="shrink-0 overflow-hidden transition-all"
                        style={{
                            width: 56, height: 56, borderRadius: 10,
                            border: galleryIndex === i && showLargePreview ? '2px solid var(--blanc-info)' : '1px solid var(--blanc-line)',
                            background: 'rgba(117,106,89,0.04)',
                        }}
                    >
                        {att.kind === 'image' ? (
                            <img src={att.url} alt={att.filename} className="w-full h-full object-cover" />
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full text-[9px] font-semibold" style={{ color: 'var(--blanc-ink-3)' }}>
                                <FileText className="size-4 mb-0.5" />
                                {att.filename.split('.').pop()?.toUpperCase()}
                            </div>
                        )}
                    </button>
                ))}
            </div>

            {/* Inline preview panel */}
            {showLargePreview && attachments[galleryIndex] && (
                <div className="mt-2 rounded-xl overflow-hidden" style={{ border: '1px solid var(--blanc-line)' }}>
                    {/* Toolbar */}
                    <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--blanc-line)', background: 'var(--blanc-surface-strong)' }}>
                        <button disabled={galleryIndex === 0} onClick={() => { setGalleryIndex(i => i - 1); setRotation(0); }} className="p-1 disabled:opacity-30"><ChevronLeft className="size-4" /></button>
                        <span className="text-[12px] font-medium" style={{ color: 'var(--blanc-ink-2)' }}>{galleryIndex + 1} / {attachments.length}</span>
                        <button disabled={galleryIndex >= attachments.length - 1} onClick={() => { setGalleryIndex(i => i + 1); setRotation(0); }} className="p-1 disabled:opacity-30"><ChevronRightIcon className="size-4" /></button>
                        <button onClick={() => setRotation(r => r - 90)} className="p-1 ml-auto" style={{ color: 'var(--blanc-ink-3)' }}><RotateCcw className="size-3.5" /></button>
                        <a href={attachments[galleryIndex].url} target="_blank" rel="noopener noreferrer" className="p-1" style={{ color: 'var(--blanc-info)' }}><ExternalLink className="size-3.5" /></a>
                    </div>

                    {/* Preview area */}
                    <div
                        className="flex items-center justify-center p-3"
                        style={{ background: 'rgba(30,30,30,0.95)', minHeight: 200, overflow: 'hidden', cursor: attachments[galleryIndex].kind === 'image' ? 'zoom-in' : undefined }}
                        onClick={() => { if (attachments[galleryIndex].kind === 'image') setFullscreen(true); }}
                    >
                        {attachments[galleryIndex].kind === 'image' ? (
                            <RotatableImage
                                src={attachments[galleryIndex].url}
                                alt={attachments[galleryIndex].filename}
                                rotation={rotation}
                            />
                        ) : (
                            <div className="flex flex-col items-center gap-2 text-white/60">
                                <FileText className="size-10" />
                                <span className="text-sm">{attachments[galleryIndex].filename}</span>
                                <a href={attachments[galleryIndex].url} target="_blank" rel="noopener noreferrer" className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'var(--blanc-info)', color: '#fff' }}>Open File</a>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Fullscreen image viewer */}
            {fullscreen && imageOnly.length > 0 && (
                <FullscreenImageViewer
                    images={imageOnly}
                    initialIndex={galleryToImageIndex}
                    initialRotation={rotation}
                    onClose={() => setFullscreen(false)}
                    onIndexChange={(imgIdx) => {
                        let count = 0;
                        for (let j = 0; j < attachments.length; j++) {
                            if (attachments[j].kind === 'image') {
                                if (count === imgIdx) { setGalleryIndex(j); break; }
                                count++;
                            }
                        }
                    }}
                    onRotationChange={setRotation}
                />
            )}
        </div>
    );
}
