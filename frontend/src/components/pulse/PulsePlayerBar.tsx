/**
 * PulsePlayerBar — the shared recording player UI (PULSE-PLAYER-001 / OB-13).
 *
 * Desktop (≥768): floating bottom-center hover bar — play/pause · ±10s · label ·
 * seekable progress · time · speed · close. Non-modal z-70 layer, one notch BELOW
 * OVERLAY_Z.panel (80), so every panel/dialog covers it.
 *
 * Mobile (<768): the canonical BottomSheet (owner's call) with a roomy 3-row
 * layout — label header · full-width seek + times · big centered transport.
 * Dismissing the sheet (swipe / backdrop / ✕) stops playback, same as ✕ on
 * desktop. The <audio> element lives in the PROVIDER, so switching between the
 * two presentations (e.g. rotating a tablet) never interrupts the sound.
 */
import { Play, Pause, RotateCcw, RotateCw, X } from 'lucide-react';
import { BottomSheet } from '../ui/BottomSheet';
import { useIsMobile } from '../../hooks/useIsMobile';
import { usePulsePlayer, fmtPlayerTime, type PulsePlayerApi } from './pulsePlayer';

/**
 * Connected player UI — bar on desktop, bottom sheet on mobile.
 *
 * The BottomSheet stays MOUNTED and only its `open` flag follows the viewport:
 * yanking it out of the tree mid-open (rotate to landscape while playing) skips
 * its close choreography and leaks the body scroll-lock — caught live in the
 * harness. A viewport flip closes the sheet through the normal path WITHOUT
 * touching playback; the audio element lives in the provider and keeps playing.
 */
export function PulsePlayerBar() {
    const p = usePulsePlayer();
    const isMobile = useIsMobile();
    return (
        <>
            <BottomSheet
                open={isMobile && !!p.track}
                onClose={p.close}
                size="auto"
                title={p.track?.label}
                ariaLabel="Recording player"
            >
                <PulsePlayerSheetControls p={p} />
            </BottomSheet>
            {!isMobile && <PulsePlayerBarView p={p} />}
        </>
    );
}

/** ±10s button: icon sized close to the Play control so the "10" reads clearly. */
function SkipBtn({ dir, onClick, size = 'md' }: { dir: -1 | 1; onClick: () => void; size?: 'md' | 'lg' }) {
    const Icon = dir === -1 ? RotateCcw : RotateCw;
    const title = dir === -1 ? 'Rewind 10 seconds' : 'Forward 10 seconds';
    const btn = size === 'lg' ? 'h-14 w-14' : 'h-11 w-11';
    const icon = size === 'lg' ? 'size-9' : 'size-7';
    const num = size === 'lg' ? 'text-[11px]' : 'text-[10px]';
    return (
        <button
            onClick={onClick}
            title={title}
            aria-label={title}
            className={`${btn} shrink-0 flex items-center justify-center rounded-full transition-colors hover:bg-[rgba(25,25,25,0.05)]`}
            style={{ color: 'var(--blanc-ink-2)' }}
        >
            <span className="relative flex items-center justify-center">
                <Icon className={icon} strokeWidth={1.75} />
                <span className={`absolute ${num} font-semibold mt-[1px]`}>10</span>
            </span>
        </button>
    );
}

function SeekRange({ p, tall = false }: { p: PulsePlayerApi; tall?: boolean }) {
    const duration = p.duration > 0 ? p.duration : (p.track?.durationHint || 0);
    return (
        <input
            type="range"
            min={0}
            max={Math.max(duration, 1)}
            step={0.1}
            value={Math.min(p.currentTime, duration || p.currentTime)}
            onChange={e => p.seekTo(Number(e.target.value))}
            aria-label="Seek"
            className={`w-full min-w-0 cursor-pointer ${tall ? 'h-2' : 'h-1.5'}`}
            style={{ accentColor: 'var(--blanc-accent)' }}
        />
    );
}

function RateChip({ p, size = 'md' }: { p: PulsePlayerApi; size?: 'md' | 'lg' }) {
    return (
        <button
            onClick={p.cycleRate}
            title="Playback speed"
            aria-label="Playback speed"
            className={`${size === 'lg' ? 'h-10 px-3 text-[13px]' : 'h-8 px-2 text-[11px]'} shrink-0 rounded-lg font-semibold tabular-nums transition-colors hover:bg-[rgba(25,25,25,0.05)]`}
            style={{ color: p.rate !== 1 ? 'var(--blanc-accent)' : 'var(--blanc-ink-2)', border: '1px solid var(--blanc-line)' }}
        >
            {p.rate}×
        </button>
    );
}

/**
 * Mobile sheet body — roomy 2-row transport (owner: "2-3 строки, пусть занимает
 * хоть полэкрана, главное удобно"). Label lives in the sheet header; the sheet's
 * own ✕ / swipe-down closes the player.
 */
export function PulsePlayerSheetControls({ p }: { p: PulsePlayerApi }) {
    if (!p.track) return null;
    const duration = p.duration > 0 ? p.duration : (p.track.durationHint || 0);
    return (
        <div className="px-5 pb-6 pt-1 space-y-5">
            {/* Seek + times */}
            <div className="space-y-1.5">
                <SeekRange p={p} tall />
                <div className="flex items-center justify-between text-[13px] font-mono tabular-nums" style={{ color: 'var(--blanc-ink-3)' }}>
                    <span>{fmtPlayerTime(p.currentTime)}</span>
                    <span>{fmtPlayerTime(duration)}</span>
                </div>
            </div>
            {/* Transport row: −10 · play/pause · +10 · speed */}
            <div className="flex items-center justify-center gap-5">
                <SkipBtn dir={-1} size="lg" onClick={() => p.skip(-10)} />
                <button
                    onClick={p.toggle}
                    title={p.isPlaying ? 'Pause' : 'Play'}
                    aria-label={p.isPlaying ? 'Pause' : 'Play'}
                    className="h-16 w-16 shrink-0 flex items-center justify-center rounded-full transition-opacity hover:opacity-90"
                    style={{ background: 'var(--blanc-accent)', color: '#fff' }}
                >
                    {p.isPlaying ? <Pause className="size-7" /> : <Play className="size-7 ml-1" />}
                </button>
                <SkipBtn dir={1} size="lg" onClick={() => p.skip(10)} />
                <RateChip p={p} size="lg" />
            </div>
        </div>
    );
}

/** Presentational desktop bar; exported for static-markup tests (vitest env=node). */
export function PulsePlayerBarView({ p }: { p: PulsePlayerApi }) {
    if (!p.track) return null;
    const duration = p.duration > 0 ? p.duration : (p.track.durationHint || 0);
    return (
        <div
            data-testid="pulse-player-bar"
            className="fixed left-1/2 -translate-x-1/2 z-[70] w-[min(680px,calc(100vw-2rem))] bottom-4"
        >
            <div
                className="flex items-center gap-2 rounded-2xl px-3 py-2.5 backdrop-blur-md"
                style={{
                    background: 'var(--blanc-surface)',
                    border: '1px solid var(--blanc-line)',
                    boxShadow: '0 8px 28px rgba(25,25,25,0.14)',
                }}
            >
                {/* Play / Pause — primary control */}
                <button
                    onClick={p.toggle}
                    title={p.isPlaying ? 'Pause' : 'Play'}
                    aria-label={p.isPlaying ? 'Pause' : 'Play'}
                    className="h-11 w-11 shrink-0 flex items-center justify-center rounded-full transition-opacity hover:opacity-90"
                    style={{ background: 'var(--blanc-accent)', color: '#fff' }}
                >
                    {p.isPlaying ? <Pause className="size-5" /> : <Play className="size-5 ml-0.5" />}
                </button>

                <SkipBtn dir={-1} onClick={() => p.skip(-10)} />
                <SkipBtn dir={1} onClick={() => p.skip(10)} />

                {/* Label + progress */}
                <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium truncate leading-tight" style={{ color: 'var(--blanc-ink-1)' }}>
                        {p.track.label}
                    </div>
                    <div className="flex items-center gap-2">
                        <SeekRange p={p} />
                        <span className="shrink-0 text-[11px] font-mono tabular-nums" style={{ color: 'var(--blanc-ink-3)' }}>
                            {fmtPlayerTime(p.currentTime)} / {fmtPlayerTime(duration)}
                        </span>
                    </div>
                </div>

                <RateChip p={p} />

                <button
                    onClick={p.close}
                    title="Close player"
                    aria-label="Close player"
                    className="h-11 w-11 shrink-0 flex items-center justify-center rounded-full transition-colors hover:bg-[rgba(25,25,25,0.05)]"
                    style={{ color: 'var(--blanc-ink-2)' }}
                >
                    <X className="size-5" />
                </button>
            </div>
        </div>
    );
}
