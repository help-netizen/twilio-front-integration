import { test, expect } from '../fixtures/test';
import { ApiClient, type CleanupEntity } from '../fixtures/api';
import { hasAdmin } from '../fixtures/env';
import { PulsePage } from '../pages/PulsePage';

/**
 * PULSE-PLAYER — shared call-recording player wiring, on the DEPLOYED app.
 *
 * The two bugs this guards were iOS-Safari-specific (iOS resets
 * HTMLMediaElement.playbackRate on load()/play(), and drops a currentTime set
 * made before the media is seekable). Playwright drives desktop Chromium, which
 * does NOT reproduce those resets — so the iOS reset-survival itself is proven
 * in the component harness (simulated reset) and by manual device check, NOT
 * here. What THIS spec locks down is the user-facing WIRING contract that a
 * future refactor could silently break:
 *   - tapping a KEY ENTITIES timecode cold seeks the player to that time
 *     (switch-and-seek), never plays from the start;
 *   - the speed chip actually applies its rate to the <audio> element;
 *   - tapping a transcript timecode while playing seeks in place.
 *
 * A real call recording cannot be seeded (staging blanks Twilio; there is no
 * create-call API), and its audio blob may not exist on staging storage. So the
 * player is fed DETERMINISTIC data by intercepting the three requests it makes:
 * the timeline page (inject one call item), the per-call media endpoint
 * (transcript + KEY ENTITIES), and the recording bytes (a generated WAV). The
 * component under test is the real, deployed one — only its data is mocked.
 */

/** Minimal PCM WAV (mono, silence) so the element reports a real, seekable duration. */
function wavBuffer(seconds: number, sampleRate = 8000): Buffer {
    const dataSize = seconds * sampleRate * 2;
    const buf = Buffer.alloc(44 + dataSize); // zero-filled tail = silence
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16);            // fmt chunk size
    buf.writeUInt16LE(1, 20);             // PCM
    buf.writeUInt16LE(1, 22);             // mono
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
    buf.writeUInt16LE(2, 32);             // block align
    buf.writeUInt16LE(16, 34);            // bits per sample
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(dataSize, 40);
    return buf;
}

const DURATION = 120;               // long enough that the clip never ends mid-test
const RECORDING_URL = '/e2e-player-fixture.wav';
const ENTITY_SEC = 42;              // KEY ENTITIES timecode we seek to (cold)
const TRANSCRIPT_SEC = 15;          // transcript timecode we seek to (in place)

const TRANSCRIPT = [
    '[0ms] Agent: Thanks for calling ABC Homes.',
    `[${TRANSCRIPT_SEC * 1000}ms] Customer: My dryer stopped heating.`,
    `[${ENTITY_SEC * 1000}ms] Agent: We can send a technician tomorrow.`,
].join('\n');

const GEMINI_ENTITIES = [
    { label: 'Appliance', value: 'Dryer', start_ms: TRANSCRIPT_SEC * 1000 },
    { label: 'Next step', value: 'Technician visit tomorrow', start_ms: ENTITY_SEC * 1000 },
];

/** Intercept the three requests the player makes so it renders one playable call. */
async function stubOneCallRecording(page: import('@playwright/test').Page, opts: {
    callSid: string; timelineId: number; contactName: string;
}): Promise<void> {
    const summary = 'Customer reports a dryer not heating; technician visit scheduled.';

    // Recording bytes — the <audio> src is `${playback_url}?token=…`. A media element
    // will only expose a non-empty `seekable` range (and thus honor a currentTime set)
    // when the response supports HTTP Range; a plain 200 leaves it unseekable and every
    // seek silently clamps to 0. Real recordings are range-served, so mirror that.
    const wav = wavBuffer(DURATION);
    await page.route(/\/e2e-player-fixture\.wav/, route => {
        const range = route.request().headers()['range'];
        const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
        if (m) {
            const start = parseInt(m[1], 10);
            const end = m[2] ? parseInt(m[2], 10) : wav.length - 1;
            return route.fulfill({
                status: 206,
                headers: {
                    'Accept-Ranges': 'bytes',
                    'Content-Range': `bytes ${start}-${end}/${wav.length}`,
                    'Content-Length': String(end - start + 1),
                    'Content-Type': 'audio/wav',
                },
                body: wav.subarray(start, end + 1),
            });
        }
        return route.fulfill({
            status: 200,
            headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(wav.length), 'Content-Type': 'audio/wav' },
            body: wav,
        });
    });

    // Per-call media — transcript text + KEY ENTITIES (with timecodes).
    await page.route(/\/api\/calls\/[^/]+\/media/, route =>
        route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({
                transcript: {
                    text: TRANSCRIPT, entities: [], sentimentScore: 0.2,
                    gemini_summary: summary, gemini_entities: GEMINI_ENTITIES,
                },
            }),
        }));

    // Timeline page — one call item in the raw shape callToCallData() consumes.
    await page.route(/\/pulse\/timeline-by-id\//, route =>
        route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({
                page: {
                    items: [{
                        ts: new Date().toISOString(), src: 'call', id: opts.callSid,
                        data: {
                            id: opts.callSid, call_sid: opts.callSid,
                            direction: 'inbound', status: 'completed',
                            started_at: new Date().toISOString(),
                            from_number: '+18573895812', to_number: '+16175006181',
                            duration_sec: DURATION,
                            recording: { playback_url: RECORDING_URL, duration_sec: DURATION },
                            transcript: { text: TRANSCRIPT, status: 'completed', gemini_summary: summary },
                        },
                    }],
                    next_cursor: null, has_more: false,
                },
                meta: {
                    timeline_id: opts.timelineId, display_name: opts.contactName,
                    external_source: null, contact: null, conversations: [],
                    mask_viewer: false, sms_targets: [],
                },
            }),
        }));
}

test.describe('@suite:pulse-player', () => {
    test.skip(!hasAdmin(), 'requires E2E_ADMIN_USER / E2E_ADMIN_PASS');

    test('@p1 PLAYER — timecode seeks land and the speed chip applies to the audio', async ({ page }) => {
        const api = await ApiClient.forPage(page);
        const cleanup: CleanupEntity[] = [];

        try {
            const contact = await api.createContact('E2E Player Contact');
            cleanup.push({ type: 'contact', id: contact.id }, { type: 'lead', id: contact.leadUuid });
            const timelineId = await api.ensureTimeline(contact);
            // A bare timeline (no activity) does not surface in Pulse search; a task gives
            // it a searchable presence so the client-side open (below) has a target. The
            // real feed stays empty — the one call comes from the timeline stub.
            const task = await api.createTask('timeline', timelineId, 'E2E Player Task');
            cleanup.push({ type: 'task', id: task.id });
            const callSid = `CA_e2e_player_${timelineId}`;

            await stubOneCallRecording(page, { callSid, timelineId, contactName: contact.name });

            // Open the timeline the way the app expects — load /pulse, then CLIENT-SIDE
            // navigate via search+click. A full page.goto() to the deep link white-screens
            // the timeline route intermittently; the search+click path is what pulse.spec
            // uses. Our timeline-by-id stub still fires on the client-side fetch and injects
            // the one call, so the card + Summary/KEY ENTITIES render.
            const pulse = new PulsePage(page);
            await pulse.goto();
            const timeline = await pulse.searchFor(contact.name);
            await timeline.click();
            await expect(page).toHaveURL(/\/pulse\/timeline\//);
            await expect(page.getByTestId('pulse-play-recording')).toBeVisible({ timeout: 25_000 });

            const audio = page.getByTestId('pulse-player-audio');
            const currentTime = () => audio.evaluate((el: HTMLMediaElement) => el.currentTime);
            const playbackRate = () => audio.evaluate((el: HTMLMediaElement) => el.playbackRate);

            await test.step('KEY ENTITIES timecode (cold) seeks to the tapped time, not the start', async () => {
                // Summary is open by default (a summary exists) → entities render.
                const entity = page.locator(`[data-testid="pulse-entity-row"][data-seek-sec="${ENTITY_SEC}"]`);
                await expect(entity).toBeVisible();
                await entity.click(); // no prior Play → switch-and-seek → startTrack(t, 42)

                await expect(page.getByTestId('pulse-player-bar')).toBeVisible();
                await expect.poll(() => audio.evaluate((el: HTMLMediaElement) => el.duration || 0),
                    { timeout: 15_000 }).toBeGreaterThan(1);
                // Reaching 38s within the 15s poll window is only possible via the seek
                // jump to 42 — from-zero playback could not get there in time.
                await expect.poll(currentTime, { timeout: 15_000 }).toBeGreaterThan(ENTITY_SEC - 4);
            });

            await test.step('speed chip applies its rate to the <audio> element', async () => {
                const rate = page.getByTestId('pulse-player-rate');
                await rate.click();
                await expect(rate).toHaveText('1.25×');
                await expect.poll(playbackRate).toBe(1.25);

                await rate.click();
                await expect(rate).toHaveText('1.5×');
                await expect.poll(playbackRate).toBe(1.5);
            });

            await test.step('transcript timecode seeks in place (backward jump)', async () => {
                await page.getByRole('button', { name: 'Transcript', exact: true }).click();
                const line = page.locator(`[data-testid="pulse-transcript-line"][data-seek-sec="${TRANSCRIPT_SEC}"]`);
                await expect(line).toBeVisible();
                await line.click(); // active track → seek-current → seekTo(15)
                // It was playing well past 30s; only the backward seek can drop it below 30.
                await expect.poll(currentTime, { timeout: 15_000 }).toBeLessThan(30);
            });
        } finally {
            await api.cleanup(cleanup);
            await api.dispose();
        }
    });
});
