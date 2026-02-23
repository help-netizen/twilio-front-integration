/**
 * Incoming Call Ringtone — Web Audio API phone ring generator.
 *
 * Generates a classic "double ring" phone tone pattern:
 *   Ring (400ms) → pause (200ms) → ring (400ms) → silence (2s) → repeat
 *
 * No external audio files needed — fully synthesized in the browser.
 */

let audioContext: AudioContext | null = null;
let ringtoneInterval: ReturnType<typeof setInterval> | null = null;
let isPlaying = false;

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
        audioContext = new AudioContext();
    } catch {
        console.warn('[Ringtone] Web Audio API not available');
        return;
    }

    function playPattern() {
        if (!audioContext || !isPlaying) return;
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

    if (audioContext) {
        audioContext.close().catch(() => { });
        audioContext = null;
    }
}
