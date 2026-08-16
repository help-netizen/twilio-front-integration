/**
 * FullscreenImageViewer — shared lightbox overlay for image attachments.
 *
 * Features: fullscreen overlay, arrow-key navigation, 90° rotation,
 * thumbnail strip, Escape/backdrop close. Reusable across any panel
 * that displays image attachments.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import {
    ChevronLeft, ChevronRight as ChevronRightIcon,
    ExternalLink, RotateCcw,
} from 'lucide-react';
import { Overlay } from '../ui/Overlay';
import { OverlayClose } from '../ui/OverlayClose';

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
        if (e.key === 'ArrowLeft') navigate(-1);
        if (e.key === 'ArrowRight') navigate(1);
        if (e.key === 'ArrowUp') { e.preventDefault(); zoomIn(); }
        if (e.key === 'ArrowDown') { e.preventDefault(); zoomOut(); }
    }, [navigate, zoomIn, zoomOut]);

    useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    if (!current) return null;

    // Portal + Esc + body-scroll-lock come from the shared Overlay core (variant="lightbox":
    // scroll-lock on, focus-trap off, no default backdrop, backdrop-close off). This lightbox
    // is its OWN scrim (the full-screen container), and backdrop close stays bespoke below
    // (the `target === currentTarget` guard), so we render no core backdrop and don't spread
    // panelProps — the container markup is unchanged.
    return (
        <Overlay open={!!current} onClose={onClose} variant="lightbox" backdrop={false}>
            {({ z }) => (
        <div
            className="fixed inset-0 flex flex-col"
            style={{ background: 'rgba(0,0,0,0.92)', zIndex: z }}
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            {/* Top bar — above the image so its controls stay clickable */}
            <div className="relative z-10 flex items-center gap-3 px-4 py-3 shrink-0">
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
                    <OverlayClose
                        variant="corner"
                        onClose={onClose}
                        className="static p-2 rounded-lg text-white/70 hover:bg-white/10 hover:opacity-100"
                        style={{ background: 'transparent' }}
                    />
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
                    className="absolute left-2 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full hover:bg-white/10 transition-colors disabled:opacity-20"
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
                    className="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full hover:bg-white/10 transition-colors disabled:opacity-20"
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
        </div>
            )}
        </Overlay>
    );
}

// ─── RotatableImage — contain-fit inside the available box in EVERY rotation ──

export function RotatableImage({ src, alt, rotation, fullscreen, zoom = 1 }: {
    src: string; alt: string; rotation: number; fullscreen?: boolean; zoom?: number;
}) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const [box, setBox] = useState({ w: 0, h: 0 });

    const norm = ((rotation % 360) + 360) % 360;
    const isRotatedSideways = norm === 90 || norm === 270;

    // Measure the real available area so the fit is exact (not a guessed vh).
    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return;
        const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // When rotated 90/270 the image's width and height swap on screen, so bound the
    // (unrotated) image to the SWAPPED box — after the rotation it lands inside the
    // real box. Result: it fits by whichever side is tighter, and NEITHER side ever
    // leaves the viewport, in any orientation. zoom multiplies on top (may overflow,
    // which the wrapper clips — that is intentional zoom behaviour).
    const maxW = isRotatedSideways ? box.h : box.w;
    const maxH = isRotatedSideways ? box.w : box.h;

    const imgStyle: React.CSSProperties = {
        maxWidth: maxW ? `${maxW}px` : '100%',
        maxHeight: maxH ? `${maxH}px` : (fullscreen ? '85vh' : '70vh'),
        transform: `rotate(${rotation}deg) scale(${zoom})`,
        transformOrigin: 'center center',
        transition: 'transform 0.2s ease',
    };

    return (
        <div
            ref={wrapRef}
            style={{
                flex: '1 1 0%',
                alignSelf: 'stretch',
                minWidth: 0,
                minHeight: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
            }}
        >
            <img src={src} alt={alt} className="rounded" style={imgStyle} />
        </div>
    );
}
