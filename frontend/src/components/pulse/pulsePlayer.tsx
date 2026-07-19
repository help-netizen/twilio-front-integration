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
    // Pending seek for a track whose <audio> src is applied on the NEXT render
    // (seekTrack on a non-active track): applied in the effect below.
    const pendingSeekRef = useRef<number | null>(null);

    useEffect(() => {
        const a = audioRef.current; if (!a) return;
        const onTime = () => setCurrentTime(a.currentTime);
        const onDur = () => { if (isFinite(a.duration) && a.duration > 0) setDuration(a.duration); };
        const onPlay = () => setIsPlaying(true);
        const onPause = () => setIsPlaying(false);
        const onEnded = () => setIsPlaying(false);
        a.addEventListener('timeupdate', onTime);
        a.addEventListener('loadedmetadata', onDur);
        a.addEventListener('durationchange', onDur);
        a.addEventListener('play', onPlay);
        a.addEventListener('pause', onPause);
        a.addEventListener('ended', onEnded);
        return () => {
            a.removeEventListener('timeupdate', onTime);
            a.removeEventListener('loadedmetadata', onDur);
            a.removeEventListener('durationchange', onDur);
            a.removeEventListener('play', onPlay);
            a.removeEventListener('pause', onPause);
            a.removeEventListener('ended', onEnded);
        };
    }, [track?.callSid]);

    // New track mounted: apply rate, optional pending seek, start playback.
    useEffect(() => {
        const a = audioRef.current; if (!a || !track) return;
        a.playbackRate = rate;
        const seek = pendingSeekRef.current;
        pendingSeekRef.current = null;
        if (seek != null) { a.currentTime = seek; setCurrentTime(seek); }
        a.play()?.catch?.(() => setIsPlaying(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [track?.callSid]);

    // Leaving Pulse unmounts the provider — make the stop explicit as well
    // (TC-PP-08), not merely a consequence of DOM teardown.
    useEffect(() => () => { audioRef.current?.pause(); }, []);

    const switchTo = useCallback((t: PlayerTrack, seek: number | null) => {
        setTrack(prev => {
            if (prev?.callSid === t.callSid) return prev;
            setCurrentTime(seek ?? 0);
            setDuration(t.durationHint && isFinite(t.durationHint) ? t.durationHint : 0);
            return t;
        });
    }, []);

    const playTrack = useCallback((t: PlayerTrack) => {
        const a = audioRef.current;
        if (resolvePlayIntent(track?.callSid ?? null, t) === 'toggle' && a) {
            if (a.paused) a.play()?.catch?.(() => setIsPlaying(false)); else a.pause();
            return;
        }
        pendingSeekRef.current = null;
        switchTo(t, null);
    }, [track?.callSid, switchTo]);

    const toggle = useCallback(() => {
        const a = audioRef.current; if (!a || !track) return;
        if (a.paused) a.play()?.catch?.(() => setIsPlaying(false)); else a.pause();
    }, [track]);

    const seekTo = useCallback((sec: number) => {
        const a = audioRef.current; if (!a) return;
        a.currentTime = clampSeek(sec, a.duration);
        setCurrentTime(a.currentTime);
    }, []);

    const seekTrack = useCallback((t: PlayerTrack, sec: number) => {
        const a = audioRef.current;
        if (resolveSeekIntent(track?.callSid ?? null, t, sec).kind === 'seek-current' && a) {
            seekTo(sec);
            if (a.paused) a.play()?.catch?.(() => setIsPlaying(false));
            return;
        }
        pendingSeekRef.current = sec;
        switchTo(t, sec);
    }, [track?.callSid, seekTo, switchTo]);

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
        audioRef.current?.pause();
        setTrack(null); setIsPlaying(false); setCurrentTime(0); setDuration(0);
    }, []);

    const api = useMemo<PulsePlayerApi>(() => ({
        track, isPlaying, currentTime, duration, rate,
        playTrack, toggle, seekTo, seekTrack, skip, cycleRate, close,
    }), [track, isPlaying, currentTime, duration, rate, playTrack, toggle, seekTo, seekTrack, skip, cycleRate, close]);

    const src = track ? buildAudioSrc(track.audioUrl, token) : undefined;

    return (
        <PulsePlayerContext.Provider value={api}>
            {children}
            {track && (
                <audio
                    key={track.callSid}
                    ref={audioRef}
                    src={src}
                    preload="metadata"
                    data-testid="pulse-player-audio"
                />
            )}
        </PulsePlayerContext.Provider>
    );
}

export const fmtPlayerTime = (s: number) => {
    if (!isFinite(s) || isNaN(s) || s < 0) return '0:00';
    return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
};
