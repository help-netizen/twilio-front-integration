/**
 * PULSE-PLAYER-001 (OB-13) harness — REAL PulseCallListItem cards + the REAL
 * floating PulsePlayerBar, no auth/backend. Audio = generated WAV sweeps, so
 * seek/skip are audible and the duration is real.
 *
 * Run: npx vite (frontend/) → /player-harness.html
 */
import { createRoot } from 'react-dom/client';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { PulseCallListItem } from '../components/pulse/PulseCallListItem';
import { PulsePlayerProvider } from '../components/pulse/pulsePlayer';
import { PulsePlayerBar } from '../components/pulse/PulsePlayerBar';
import type { CallData } from '../components/call-list-item';

/** 16-bit mono PCM WAV: rising tone sweep so position within the track is audible. */
function makeWavUrl(seconds: number, baseHz: number): string {
    const rate = 8000;
    const n = seconds * rate;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data');
    v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
        const t = i / rate;
        const hz = baseHz + (t / seconds) * 400; // sweep up over the track
        v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * hz * t) * 12000), true);
    }
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

const TRANSCRIPT = [
    '[0ms] Agent: Thanks for calling ABC Homes, how can I help?',
    '[6000ms] Customer: My dryer stopped heating yesterday.',
    '[14000ms] Agent: Got it — is it a Samsung or an LG?',
    '[21000ms] Customer: Samsung, about four years old.',
    '[30000ms] Agent: We can have a technician out tomorrow morning.',
].join('\n');

const call = (sid: string, from: string, minutesAgo: number, seconds: number, hz: number): CallData => ({
    id: sid,
    callSid: sid,
    from,
    to: '+16175006181',
    direction: 'incoming',
    status: 'completed',
    startTime: new Date(Date.now() - minutesAgo * 60_000),
    duration: seconds,
    totalDuration: seconds,
    recordingDuration: seconds,
    audioUrl: makeWavUrl(seconds, hz),
    transcription: TRANSCRIPT,
    summary: 'Customer reports a Samsung dryer not heating; technician visit scheduled for tomorrow morning.',
} as unknown as CallData);

function App() {
    return (
        <PulsePlayerProvider>
            <div className="min-h-screen p-6" style={{ background: 'var(--blanc-bg)' }}>
                <div className="mx-auto max-w-2xl space-y-4 pb-28">
                    <h1 className="text-2xl font-semibold" style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}>
                        Pulse player harness
                    </h1>
                    <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                        Два настоящих звонка. Play на карточке → плавающий бар снизу; клик по строке
                        транскрипта перематывает общий плеер (и переключает трек, если играет другой).
                    </p>
                    <PulseCallListItem call={call('CA_harness_1', '+18573895812', 42, 35, 320)} />
                    <PulseCallListItem call={call('CA_harness_2', '+16175550100', 7, 50, 640)} />
                </div>
                <PulsePlayerBar />
            </div>
        </PulsePlayerProvider>
    );
}

createRoot(document.getElementById('root')!).render(<App />);
