/**
 * Incoming Call Ringtone — Web Audio API phone ring generator.
 *
 * Generates a classic "double ring" phone tone pattern:
 *   Ring (400ms) → pause (200ms) → ring (400ms) → silence (2s) → repeat
 *
 * No external audio files needed — fully synthesized in the browser.
 *
 * IMPORTANT: Modern browsers block AudioContext playback until a user gesture
 * has occurred. We pre-warm the AudioContext on the first user click so that
 * when an incoming call arrives (via WebSocket, NOT a user gesture) the
 * AudioContext is already in 'running' state and can play immediately.
 */

let audioContext: AudioContext | null = null;
let ringtoneInterval: ReturnType<typeof setInterval> | null = null;
let isPlaying = false;
let warmedUp = false;

/**
 * Pre-warm the AudioContext on user gesture.
 * Call this once on any user interaction (click, keydown) so that
 * subsequent programmatic playback (from incoming call events) works.
 */
export function warmUpAudio(): void {
    if (warmedUp) return;
    try {
        if (!audioContext) {
            audioContext = new AudioContext();
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume().catch(() => { });
        }
        warmedUp = true;
        console.log('[Ringtone] AudioContext warmed up, state:', audioContext.state);
    } catch {
        console.warn('[Ringtone] Web Audio API not available');
    }
}

// Auto-warm on first user interaction (safety net)
if (typeof window !== 'undefined') {
    const autoWarm = () => {
        warmUpAudio();
        window.removeEventListener('click', autoWarm);
        window.removeEventListener('keydown', autoWarm);
    };
    window.addEventListener('click', autoWarm, { once: true });
    window.addEventListener('keydown', autoWarm, { once: true });
}

function playRingBurst(ctx: AudioContext, startTime: number, duration: number) {
    // Two-tone ring (480 Hz + 440 Hz superimposed — North American ring)
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc1.frequency.value = 440;
    osc2.type = 'sine';
    osc2.frequency.value = 480;

    gain.gain.value = 0.15; // Keep volume reasonable

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(startTime);
    osc2.start(startTime);
    osc1.stop(startTime + duration);
    osc2.stop(startTime + duration);
}

/**
 * Start playing the ringtone (loops until stopped).
 */
export function startRingtone(): void {
    if (isPlaying) return;
    isPlaying = true;

    try {
        // Re-use existing warmed-up context, or create new one
        if (!audioContext || audioContext.state === 'closed') {
            audioContext = new AudioContext();
        }
        // Resume if suspended (best-effort — may still be blocked without prior gesture)
        if (audioContext.state === 'suspended') {
            audioContext.resume().catch(() => {
                console.warn('[Ringtone] Could not resume AudioContext — no prior user gesture');
            });
        }
    } catch {
        console.warn('[Ringtone] Web Audio API not available');
        isPlaying = false;
        return;
    }

    console.log('[Ringtone] Starting ringtone, AudioContext state:', audioContext.state);

    function playPattern() {
        if (!audioContext || !isPlaying) return;
        // Double-check context is running
        if (audioContext.state === 'suspended') {
            audioContext.resume().catch(() => { });
            return; // skip this cycle, try next
        }
        const now = audioContext.currentTime;
        // Double ring: ring 0.4s → pause 0.2s → ring 0.4s
        playRingBurst(audioContext, now, 0.4);
        playRingBurst(audioContext, now + 0.6, 0.4);
    }

    // Play immediately, then repeat every 3 seconds
    playPattern();
    ringtoneInterval = setInterval(playPattern, 3000);
}

/**
 * Stop the ringtone.
 */
export function stopRingtone(): void {
    isPlaying = false;

    if (ringtoneInterval) {
        clearInterval(ringtoneInterval);
        ringtoneInterval = null;
    }

    // Don't close the AudioContext — keep it warm for next incoming call
    // Just let the oscillators stop naturally
}
