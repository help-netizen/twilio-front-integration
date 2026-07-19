/**
 * PULSE-PLAYER-001 (OB-13) — shared Pulse recording player.
 *
 * House test style (vitest env=node, no DOM): the player's decision core is
 * exported as pure functions and asserted directly; the floating bar is a
 * presentational View rendered with renderToStaticMarkup. Real <audio>
 * behavior (TC-PP-08 unmount-stop) is covered by manual browser verification —
 * jsdom is deliberately not a dependency here.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    RATES,
    nextRate,
    resolvePlayIntent,
    resolveSeekIntent,
    clampSeek,
    buildAudioSrc,
    buildTrackLabel,
    fmtPlayerTime,
    type PlayerTrack,
    type PulsePlayerApi,
} from './pulsePlayer';
import { PulsePlayerBarView } from './PulsePlayerBar';

const trackA: PlayerTrack = { callSid: 'CA_a', audioUrl: '/api/calls/CA_a/recording', label: '(857) 389-5812 · 1:18 PM', durationHint: 95 };
const trackB: PlayerTrack = { callSid: 'CA_b', audioUrl: '/api/calls/CA_b/recording', label: '(617) 555-0100 · 2:03 PM' };

const api = (over: Partial<PulsePlayerApi>): PulsePlayerApi => ({
    track: null, isPlaying: false, currentTime: 0, duration: 0, rate: 1,
    playTrack: () => {}, toggle: () => {}, seekTo: () => {}, seekTrack: () => {},
    skip: () => {}, cycleRate: () => {}, close: () => {},
    ...over,
});

describe('pulsePlayer pure core', () => {
    it('TC-PP-03/04: play intent — same callSid toggles, another switches', () => {
        expect(resolvePlayIntent('CA_a', trackA)).toBe('toggle');
        expect(resolvePlayIntent('CA_a', trackB)).toBe('switch');
        expect(resolvePlayIntent(null, trackA)).toBe('switch');
    });

    it('TC-PP-05: seek intent — active track seeks in place, another switches and seeks', () => {
        expect(resolveSeekIntent('CA_a', trackA, 42)).toEqual({ kind: 'seek-current', sec: 42 });
        expect(resolveSeekIntent('CA_b', trackA, 42)).toEqual({ kind: 'switch-and-seek', sec: 42 });
        expect(resolveSeekIntent(null, trackA, 7)).toEqual({ kind: 'switch-and-seek', sec: 7 });
    });

    it('TC-PP-07: rate cycles 1 → 1.25 → 1.5 → 2 → 1; unknown resets to 1', () => {
        expect(RATES).toEqual([1, 1.25, 1.5, 2]);
        expect(nextRate(1)).toBe(1.25);
        expect(nextRate(1.25)).toBe(1.5);
        expect(nextRate(1.5)).toBe(2);
        expect(nextRate(2)).toBe(1);
        expect(nextRate(3)).toBe(1); // never leaves the cycle
    });

    it('seek clamps into [0, duration]; unknown duration only floors at 0', () => {
        expect(clampSeek(-5, 100)).toBe(0);
        expect(clampSeek(50, 100)).toBe(50);
        expect(clampSeek(500, 100)).toBe(100);
        expect(clampSeek(500, 0)).toBe(500);      // metadata not loaded yet
        expect(clampSeek(500, NaN)).toBe(500);
        expect(clampSeek(-1, NaN)).toBe(0);
    });

    it('audio src carries the auth token exactly like the old in-card player', () => {
        expect(buildAudioSrc('/api/x', 'a b+c')).toBe('/api/x?token=a%20b%2Bc');
        expect(buildAudioSrc('/api/x', null)).toBe('/api/x');
        expect(buildAudioSrc('/api/x', undefined)).toBe('/api/x');
    });

    it('bar label is "phone · h:mm AM/PM"', () => {
        const label = buildTrackLabel('(857) 389-5812', new Date(2026, 6, 18, 13, 18));
        expect(label).toBe('(857) 389-5812 · 1:18 PM');
    });

    it('player time formats mm:ss and survives garbage', () => {
        expect(fmtPlayerTime(0)).toBe('0:00');
        expect(fmtPlayerTime(65)).toBe('1:05');
        expect(fmtPlayerTime(NaN)).toBe('0:00');
        expect(fmtPlayerTime(-3)).toBe('0:00');
        expect(fmtPlayerTime(Infinity)).toBe('0:00');
    });
});

describe('PulsePlayerBarView', () => {
    it('TC-PP-01: renders nothing while no track is loaded', () => {
        expect(renderToStaticMarkup(<PulsePlayerBarView p={api({})} />)).toBe('');
    });

    it('TC-PP-02: with a track it shows label, both times, rate and all controls', () => {
        const html = renderToStaticMarkup(
            <PulsePlayerBarView p={api({ track: trackA, isPlaying: true, currentTime: 65, duration: 95, rate: 1.5 })} />,
        );
        expect(html).toContain('(857) 389-5812 · 1:18 PM');
        expect(html).toContain('1:05 / 1:35');
        expect(html).toContain('1.5×');
        expect(html).toContain('aria-label="Pause"');       // playing → pause affordance
        expect(html).toContain('aria-label="Seek"');
        expect(html).toContain('aria-label="Close player"');
        expect(html).toContain('aria-label="Rewind 10 seconds"');
        expect(html).toContain('aria-label="Forward 10 seconds"');
    });

    it('falls back to durationHint until the element reports metadata', () => {
        const html = renderToStaticMarkup(
            <PulsePlayerBarView p={api({ track: trackA, duration: 0, currentTime: 0 })} />,
        );
        expect(html).toContain('0:00 / 1:35'); // 95s hint
    });

    it('TC-PP-06 precondition: close control is present and wired to the api', () => {
        // Static markup cannot click; assert the affordance exists. The close()
        // behavior itself (pause + clear) lives in the provider and is exercised
        // in the browser check.
        const html = renderToStaticMarkup(<PulsePlayerBarView p={api({ track: trackB })} />);
        expect(html).toContain('aria-label="Close player"');
        expect(html).toContain('aria-label="Play"');        // paused → play affordance
    });

    it('sits BELOW panels/dialogs: z-70 under OVERLAY_Z.panel(80)', () => {
        const html = renderToStaticMarkup(<PulsePlayerBarView p={api({ track: trackA })} />);
        expect(html).toContain('z-[70]');
    });
});
