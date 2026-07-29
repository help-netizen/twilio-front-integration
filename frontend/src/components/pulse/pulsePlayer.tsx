/**
 * pulsePlayer — shared recording-player state for Pulse (PULSE-PLAYER-001 / OB-13).
 *
 * ONE <audio> element lives in the provider; the floating PulsePlayerBar and the
 * per-call cards all talk to it through this context. The provider is mounted
 * inside PulsePage only, so leaving Pulse unmounts the element and playback
 * stops — the owner's "только в Pulse" rule falls out of the component tree.
 *
 * The default context value is an inert stub (track:null, no-op methods) so a
 * card rendered outside the provider (tests, storybook) never throws.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';

export interface PlayerTrack {
    callSid: string;
    audioUrl: string;
    /** One-line identification shown in the bar: "(857) 389-5812 · 1:18 PM" */
    label: string;
    /** Seconds; used until the element reports real metadata. */
    durationHint?: number;
}

export interface PulsePlayerApi {
    track: PlayerTrack | null;
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    rate: number;
    /** Play a track; same callSid → toggle play/pause. */
    playTrack: (t: PlayerTrack) => void;
    toggle: () => void;
    seekTo: (sec: number) => void;
    /** Seek within a track, switching to it first if it isn't the active one. */
    seekTrack: (t: PlayerTrack, sec: number) => void;
    skip: (deltaSec: number) => void;
    cycleRate: () => void;
    close: () => void;
}

export const RATES = [1, 1.25, 1.5, 2];

// ── Pure decision core (house test style: logic exported, vitest env=node) ────

/** Next playback rate in the 1 → 1.25 → 1.5 → 2 → 1 cycle; unknown → 1. */
export const nextRate = (rate: number): number =>
    RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1;

/** What pressing Play on a card means for the shared player. */
export const resolvePlayIntent = (activeSid: string | null, t: PlayerTrack): 'toggle' | 'switch' =>
    activeSid === t.callSid ? 'toggle' : 'switch';

/** What a transcript/entity seek means: seek in place or switch track first. */
export const resolveSeekIntent = (
    activeSid: string | null, t: PlayerTrack, sec: number,
): { kind: 'seek-current' | 'switch-and-seek'; sec: number } =>
    ({ kind: activeSid === t.callSid ? 'seek-current' : 'switch-and-seek', sec });

/** Clamp a seek target into [0, duration]; unknown duration → only floor at 0. */
export const clampSeek = (sec: number, duration: number): number => {
    const max = isFinite(duration) && duration > 0 ? duration : Infinity;
    return Math.max(0, Math.min(sec, max));
};

/** Recording URL with the auth token appended the same way the old player did. */
export const buildAudioSrc = (audioUrl: string, token: string | null | undefined): string =>
    token ? `${audioUrl}?token=${encodeURIComponent(token)}` : audioUrl;

/** One-line bar label: "(857) 389-5812 · 1:18 PM". */
export const buildTrackLabel = (phoneDisplay: string, startTime: Date): string =>
    `${phoneDisplay} · ${startTime.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;

const INERT: PulsePlayerApi = {
    track: null, isPlaying: false, currentTime: 0, duration: 0, rate: 1,
    playTrack: () => {}, toggle: () => {}, seekTo: () => {}, seekTrack: () => {},
    skip: () => {}, cycleRate: () => {}, close: () => {},
};

const PulsePlayerContext = createContext<PulsePlayerApi>(INERT);

export const usePulsePlayer = () => useContext(PulsePlayerContext);

export function PulsePlayerProvider({ children }: { children: ReactNode }) {
    const { token } = useAuth();
    const audioRef = useRef<HTMLAudioElement>(null);
    const [track, setTrack] = useState<PlayerTrack | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [rate, setRate] = useState(1);
    // OB-44: the freshest auth token, readable inside gesture handlers without
    // re-creating them. The src is applied IMPERATIVELY (never via the src prop),
    // so a background token refresh cannot reset a playing element.
    const tokenRef = useRef<string | null>(null);
    tokenRef.current = token ?? null;
    const rateRef = useRef(rate);
    rateRef.current = rate;
    // Guard so a broken source toasts once, not per retry/event.
    const erroredSrcRef = useRef<string | null>(null);
    // Seek requested before the element has metadata — applied on loadedmetadata.
    const pendingSeekRef = useRef<number | null>(null);

    // OB-44: playback failures must be VISIBLE — a rejected play() or a media
    // error used to be swallowed silently, leaving a dead Play button.
    const surfacePlaybackFailure = useCallback((src: string | null) => {
        setIsPlaying(false);
        if (src && erroredSrcRef.current === src) return; // once per source
        erroredSrcRef.current = src;
        toast.error("Couldn't play the recording. Try again.");
    }, []);

    const safePlay = useCallback((a: HTMLAudioElement) => {
        a.play()?.catch?.(() => surfacePlaybackFailure(a.currentSrc || a.getAttribute('src')));
    }, [surfacePlaybackFailure]);

    useEffect(() => {
        const a = audioRef.current; if (!a) return;
        const onTime = () => setCurrentTime(a.currentTime);
        const onDur = () => {
            if (isFinite(a.duration) && a.duration > 0) setDuration(a.duration);
            // A seek requested before metadata arrived is applied here.
            const seek = pendingSeekRef.current;
            if (seek != null) {
                pendingSeekRef.current = null;
                try { a.currentTime = seek; setCurrentTime(seek); } catch { /* ignore */ }
            }
        };
        const onPlay = () => setIsPlaying(true);
        const onPause = () => setIsPlaying(false);
        const onEnded = () => setIsPlaying(false);
        // Media/network errors (401 on a stale token, unsupported source, …).
        // close() empties the src — an error with no src attribute is not real.
        const onError = () => {
            if (!a.getAttribute('src')) return;
            surfacePlaybackFailure(a.currentSrc || a.getAttribute('src'));
        };
        a.addEventListener('timeupdate', onTime);
        a.addEventListener('loadedmetadata', onDur);
        a.addEventListener('durationchange', onDur);
        a.addEventListener('play', onPlay);
        a.addEventListener('pause', onPause);
        a.addEventListener('ended', onEnded);
        a.addEventListener('error', onError);
        return () => {
            a.removeEventListener('timeupdate', onTime);
            a.removeEventListener('loadedmetadata', onDur);
            a.removeEventListener('durationchange', onDur);
            a.removeEventListener('play', onPlay);
            a.removeEventListener('pause', onPause);
            a.removeEventListener('ended', onEnded);
            a.removeEventListener('error', onError);
        };
    }, [surfacePlaybackFailure]);

    // Leaving Pulse unmounts the provider — make the stop explicit as well
    // (TC-PP-08), not merely a consequence of DOM teardown.
    useEffect(() => () => { audioRef.current?.pause(); }, []);

    // OB-44 (iOS): load + play must run SYNCHRONOUSLY inside the user's tap.
    // The old flow set state and played in an effect AFTER the re-render — outside
    // the gesture — which iOS blocks (NotAllowedError) → dead Play button. The
    // <audio> element is now persistent and its src is applied imperatively here,
    // with the FRESHEST auth token (tokenRef), so a background token refresh can
    // never reset a playing element either.
    const startTrack = useCallback((t: PlayerTrack, seek: number | null) => {
        const a = audioRef.current; if (!a) return;
        erroredSrcRef.current = null;
        pendingSeekRef.current = seek;
        a.src = buildAudioSrc(t.audioUrl, tokenRef.current);
        a.playbackRate = rateRef.current;
        a.load();
        setCurrentTime(seek ?? 0);
        setDuration(t.durationHint && isFinite(t.durationHint) ? t.durationHint : 0);
        setTrack(t);
        safePlay(a);
    }, [safePlay]);

    const playTrack = useCallback((t: PlayerTrack) => {
        const a = audioRef.current;
        if (resolvePlayIntent(track?.callSid ?? null, t) === 'toggle' && a) {
            if (a.paused) safePlay(a); else a.pause();
            return;
        }
        startTrack(t, null);
    }, [track?.callSid, startTrack, safePlay]);

    const toggle = useCallback(() => {
        const a = audioRef.current; if (!a || !track) return;
        if (a.paused) safePlay(a); else a.pause();
    }, [track, safePlay]);

    const seekTo = useCallback((sec: number) => {
        const a = audioRef.current; if (!a) return;
        a.currentTime = clampSeek(sec, a.duration);
        setCurrentTime(a.currentTime);
    }, []);

    const seekTrack = useCallback((t: PlayerTrack, sec: number) => {
        const a = audioRef.current;
        if (resolveSeekIntent(track?.callSid ?? null, t, sec).kind === 'seek-current' && a) {
            seekTo(sec);
            if (a.paused) safePlay(a);
            return;
        }
        startTrack(t, sec);
    }, [track?.callSid, seekTo, startTrack, safePlay]);

    const skip = useCallback((deltaSec: number) => {
        const a = audioRef.current; if (!a) return;
        seekTo(a.currentTime + deltaSec);
    }, [seekTo]);

    const cycleRate = useCallback(() => {
        setRate(prev => {
            const next = nextRate(prev);
            const a = audioRef.current; if (a) a.playbackRate = next;
            return next;
        });
    }, []);

    const close = useCallback(() => {
        const a = audioRef.current;
        if (a) {
            a.pause();
            // Release the media source; the src-less error the load() below can fire
            // is ignored by the onError guard (no src attribute).
            a.removeAttribute('src');
            a.load();
        }
        erroredSrcRef.current = null;
        pendingSeekRef.current = null;
        setTrack(null); setIsPlaying(false); setCurrentTime(0); setDuration(0);
    }, []);

    const api = useMemo<PulsePlayerApi>(() => ({
        track, isPlaying, currentTime, duration, rate,
        playTrack, toggle, seekTo, seekTrack, skip, cycleRate, close,
    }), [track, isPlaying, currentTime, duration, rate, playTrack, toggle, seekTo, seekTrack, skip, cycleRate, close]);

    return (
        <PulsePlayerContext.Provider value={api}>
            {children}
            {/* PERSISTENT element (OB-44): it must exist BEFORE the first tap so
                load+play can run synchronously inside that gesture (iOS policy).
                Its src is applied imperatively in startTrack — never as a prop. */}
            <audio
                ref={audioRef}
                preload="metadata"
                data-testid="pulse-player-audio"
            />
        </PulsePlayerContext.Provider>
    );
}

export const fmtPlayerTime = (s: number) => {
    if (!isFinite(s) || isNaN(s) || s < 0) return '0:00';
    return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
};
