/**
 * PulsePlayerBar — floating recording player over the Pulse page (PULSE-PLAYER-001 / OB-13).
 *
 * Fixed bottom-center hover bar: play/pause · ±10s · label · seekable progress ·
 * time · speed · close. Renders nothing while no track is loaded. Sits at z-70 —
 * one notch BELOW OVERLAY_Z.panel (80), so every panel/dialog covers it.
 */
import { Play, Pause, RotateCcw, RotateCw, X } from 'lucide-react';
import { usePulsePlayer, fmtPlayerTime, type PulsePlayerApi } from './pulsePlayer';

/** Connected bar — reads the shared player context. */
export function PulsePlayerBar() {
    const p = usePulsePlayer();
    return <PulsePlayerBarView p={p} />;
}

/** Presentational bar; exported for static-markup tests (vitest env=node). */
export function PulsePlayerBarView({ p }: { p: PulsePlayerApi }) {
    if (!p.track) return null;

    const duration = p.duration > 0 ? p.duration : (p.track.durationHint || 0);
    const IconBtn = ({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) => (
        <button
            onClick={onClick}
            title={title}
            aria-label={title}
            className="h-10 w-10 shrink-0 flex items-center justify-center rounded-full transition-colors hover:bg-[rgba(25,25,25,0.05)]"
            style={{ color: 'var(--blanc-ink-2)' }}
        >
            {children}
        </button>
    );

    return (
        <div
            data-testid="pulse-player-bar"
            // Mobile (<768px): clear the fixed .app-bottom-nav (60px + safe-area,
            // AppLayout.css) with a 12px gap; desktop: 16px above the viewport edge.
            className="fixed left-1/2 -translate-x-1/2 z-[70] w-[min(680px,calc(100vw-2rem))] bottom-[calc(72px+env(safe-area-inset-bottom,0px))] md:bottom-4"
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
                    className="h-10 w-10 shrink-0 flex items-center justify-center rounded-full transition-opacity hover:opacity-90"
                    style={{ background: 'var(--blanc-accent)', color: '#fff' }}
                >
                    {p.isPlaying ? <Pause className="size-5" /> : <Play className="size-5 ml-0.5" />}
                </button>

                <span className="hidden sm:flex items-center">
                    <IconBtn onClick={() => p.skip(-10)} title="Rewind 10 seconds"><span className="relative flex items-center justify-center"><RotateCcw className="size-[19px]" /><span className="absolute text-[8px] font-semibold mt-[1px]">10</span></span></IconBtn>
                    <IconBtn onClick={() => p.skip(10)} title="Forward 10 seconds"><span className="relative flex items-center justify-center"><RotateCw className="size-[19px]" /><span className="absolute text-[8px] font-semibold mt-[1px]">10</span></span></IconBtn>
                </span>

                {/* Label + progress */}
                <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium truncate leading-tight" style={{ color: 'var(--blanc-ink-1)' }}>
                        {p.track.label}
                    </div>
                    <div className="flex items-center gap-2">
                        <input
                            type="range"
                            min={0}
                            max={Math.max(duration, 1)}
                            step={0.1}
                            value={Math.min(p.currentTime, duration || p.currentTime)}
                            onChange={e => p.seekTo(Number(e.target.value))}
                            aria-label="Seek"
                            className="flex-1 min-w-0 h-1.5 cursor-pointer"
                            style={{ accentColor: 'var(--blanc-accent)' }}
                        />
                        <span className="shrink-0 text-[11px] font-mono tabular-nums" style={{ color: 'var(--blanc-ink-3)' }}>
                            {fmtPlayerTime(p.currentTime)} / {fmtPlayerTime(duration)}
                        </span>
                    </div>
                </div>

                {/* Speed */}
                <button
                    onClick={p.cycleRate}
                    title="Playback speed"
                    aria-label="Playback speed"
                    className="h-8 shrink-0 px-2 rounded-lg text-[11px] font-semibold tabular-nums transition-colors hover:bg-[rgba(25,25,25,0.05)]"
                    style={{ color: p.rate !== 1 ? 'var(--blanc-accent)' : 'var(--blanc-ink-2)', border: '1px solid var(--blanc-line)' }}
                >
                    {p.rate}×
                </button>

                <IconBtn onClick={p.close} title="Close player"><X className="size-[18px]" /></IconBtn>
            </div>
        </div>
    );
}
