/**
 * FullscreenImageViewer — shared lightbox overlay for image attachments.
 *
 * Features: fullscreen overlay, arrow-key navigation, 90° rotation,
 * thumbnail strip, Escape/backdrop close. Reusable across any panel
 * that displays image attachments.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
    ChevronLeft, ChevronRight as ChevronRightIcon,
    ExternalLink, RotateCcw, X,
} from 'lucide-react';

// ─── Public interfaces ───────────────────────────────────────────────────────

export interface ViewerImage {
    url: string;
    filename: string;
}

export interface FullscreenImageViewerProps {
    images: ViewerImage[];
    initialIndex?: number;
    initialRotation?: number;
    onClose: () => void;
    onIndexChange?: (index: number) => void;
    onRotationChange?: (rotation: number) => void;
}

// ─── FullscreenImageViewer ───────────────────────────────────────────────────

export function FullscreenImageViewer({
    images,
    initialIndex = 0,
    initialRotation = 0,
    onClose,
    onIndexChange,
    onRotationChange,
}: FullscreenImageViewerProps) {
    const [index, setIndex] = useState(initialIndex);
    const [rotation, setRotation] = useState(initialRotation);
    const [zoom, setZoom] = useState(1);

    const ZOOM_STEP = 0.25;
    const ZOOM_MIN = 0.25;
    const ZOOM_MAX = 5;

    const current = images[index];

    const navigate = useCallback((dir: -1 | 1) => {
        const next = index + dir;
        if (next < 0 || next >= images.length) return;
        setIndex(next);
        setRotation(0);
        setZoom(1);
        onIndexChange?.(next);
        onRotationChange?.(0);
    }, [index, images.length, onIndexChange, onRotationChange]);

    const rotate = useCallback(() => {
        const next = rotation - 90;
        setRotation(next);
        onRotationChange?.(next);
    }, [rotation, onRotationChange]);

    const zoomIn = useCallback(() => {
        setZoom(z => Math.min(z + ZOOM_STEP, ZOOM_MAX));
    }, []);

    const zoomOut = useCallback(() => {
        setZoom(z => Math.max(z - ZOOM_STEP, ZOOM_MIN));
    }, []);

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose();
        if (e.key === 'ArrowLeft') navigate(-1);
        if (e.key === 'ArrowRight') navigate(1);
        if (e.key === 'ArrowUp') { e.preventDefault(); zoomIn(); }
        if (e.key === 'ArrowDown') { e.preventDefault(); zoomOut(); }
    }, [onClose, navigate, zoomIn, zoomOut]);

    useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = '';
        };
    }, [handleKeyDown]);

    if (!current) return null;

    return createPortal(
        <div
            className="fixed inset-0 z-[9999] flex flex-col"
            style={{ background: 'rgba(0,0,0,0.92)' }}
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            {/* Top bar */}
            <div className="flex items-center gap-3 px-4 py-3 shrink-0">
                <span className="text-white/70 text-sm font-medium">
                    {index + 1} / {images.length}
                </span>
                {zoom !== 1 && (
                    <span className="text-white/50 text-xs font-mono">{Math.round(zoom * 100)}%</span>
                )}
                <div className="flex items-center gap-1 ml-auto">
                    <button onClick={rotate} className="p-2 rounded-lg hover:bg-white/10 transition-colors" title="Rotate">
                        <RotateCcw className="size-4 text-white/70" />
                    </button>
                    <a href={current.url} target="_blank" rel="noopener noreferrer" className="p-2 rounded-lg hover:bg-white/10 transition-colors" title="Open original">
                        <ExternalLink className="size-4 text-white/70" />
                    </a>
                    <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10 transition-colors" title="Close">
                        <X className="size-4 text-white/70" />
                    </button>
                </div>
            </div>

            {/* Image area */}
            <div className="flex-1 flex items-center justify-center min-h-0 px-12 pb-4 relative"
                onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
            >
                {/* Prev */}
                <button
                    disabled={index === 0}
                    onClick={(e) => { e.stopPropagation(); navigate(-1); }}
                    className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full hover:bg-white/10 transition-colors disabled:opacity-20"
                >
                    <ChevronLeft className="size-6 text-white" />
                </button>

                <RotatableImage
                    src={current.url}
                    alt={current.filename}
                    rotation={rotation}
                    fullscreen
                    zoom={zoom}
                />

                {/* Next */}
                <button
                    disabled={index >= images.length - 1}
                    onClick={(e) => { e.stopPropagation(); navigate(1); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full hover:bg-white/10 transition-colors disabled:opacity-20"
                >
                    <ChevronRightIcon className="size-6 text-white" />
                </button>
            </div>

            {/* Thumbnail strip */}
            {images.length > 1 && (
                <div className="flex justify-center gap-2 px-4 pb-4 shrink-0">
                    {images.map((img, i) => (
                        <button
                            key={i}
                            onClick={() => { setIndex(i); setRotation(0); onIndexChange?.(i); onRotationChange?.(0); }}
                            className="shrink-0 overflow-hidden rounded-lg transition-all"
                            style={{
                                width: 48, height: 48,
                                border: i === index ? '2px solid var(--blanc-info)' : '1px solid rgba(255,255,255,0.15)',
                                opacity: i === index ? 1 : 0.5,
                            }}
                        >
                            <img src={img.url} alt={img.filename} className="w-full h-full object-cover" />
                        </button>
                    ))}
                </div>
            )}
        </div>,
        document.body,
    );
}

// ─── RotatableImage — fits container width even when rotated 90/270 ──────────

export function RotatableImage({ src, alt, rotation, fullscreen, zoom = 1 }: {
    src: string; alt: string; rotation: number; fullscreen?: boolean; zoom?: number;
}) {
    const imgRef = useRef<HTMLImageElement>(null);
    const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });

    const norm = ((rotation % 360) + 360) % 360;
    const isRotatedSideways = norm === 90 || norm === 270;

    const handleLoad = () => {
        if (imgRef.current) {
            setNaturalSize({ w: imgRef.current.naturalWidth, h: imgRef.current.naturalHeight });
        }
    };

    let imgStyle: React.CSSProperties;
    let wrapperStyle: React.CSSProperties;

    if (isRotatedSideways && naturalSize.w && naturalSize.h) {
        const scale = naturalSize.w / naturalSize.h;
        wrapperStyle = {
            width: '100%',
            aspectRatio: `${naturalSize.h} / ${naturalSize.w}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
        };
        const totalScale = scale * zoom;
        imgStyle = {
            width: '100%',
            transform: `rotate(${rotation}deg) scale(${totalScale})`,
            transformOrigin: 'center center',
            transition: 'transform 0.2s ease',
        };
    } else {
        wrapperStyle = {
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
        };
        const transforms = [
            rotation ? `rotate(${rotation}deg)` : '',
            zoom !== 1 ? `scale(${zoom})` : '',
        ].filter(Boolean).join(' ');
        imgStyle = {
            maxWidth: '100%',
            maxHeight: fullscreen ? '85vh' : '70vh',
            objectFit: 'contain',
            transform: transforms || undefined,
            transformOrigin: 'center center',
            transition: 'transform 0.2s ease',
        };
    }

    return (
        <div style={wrapperStyle}>
            <img
                ref={imgRef}
                src={src}
                alt={alt}
                onLoad={handleLoad}
                className="rounded"
                style={imgStyle}
            />
        </div>
    );
}
