/**
 * NOTE-PHOTO-COMPRESS-001 harness — exercises the production compression module
 * against the owner's three acceptance fixtures. It does not call the backend.
 *
 * Run: npx vite → /photo-compress-harness.html
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import './photoCompressionHarness.css';
import {
    compressImagesForUpload,
    DEFAULT_IMAGE_COMPRESSION_OPTIONS,
    type ImageCompressionResult,
} from '../lib/imageCompression';
import labelFixtureUrl from './fixtures-compress/label.jpeg?url';
import rotatedKitchenFixtureUrl from './fixtures-compress/rotated-kitchen.jpeg?url';
import burntFixtureUrl from './fixtures-compress/burnt-24mp.jpeg?url';

const LONG_EDGES = [1600, 2048, 2560] as const;
const QUALITIES = [0.7, 0.8, 0.85] as const;

interface FixtureSpec {
    name: string;
    url: string;
    purpose: string;
}

interface FixtureResult {
    spec: FixtureSpec;
    result: ImageCompressionResult;
    outputUrl: string;
}

const FIXTURES: FixtureSpec[] = [
    {
        name: 'label.jpeg',
        url: labelFixtureUrl,
        purpose: 'Acceptance: MODEL JB850S T1SS and SERIAL ZV2 21708Q remain readable.',
    },
    {
        name: 'rotated-kitchen.jpeg',
        url: rotatedKitchenFixtureUrl,
        purpose: 'Orientation 6 must remain visually upright after EXIF metadata is removed.',
    },
    {
        name: 'burnt-24mp.jpeg',
        url: burntFixtureUrl,
        purpose: 'Diagnostic detail in the damaged wiring must remain useful.',
    },
];

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatDimensions(width: number | null, height: number | null): string {
    return width && height ? `${width} × ${height}` : 'Not decoded';
}

function reductionPercent(original: number, output: number): string {
    return `${Math.round((1 - output / original) * 100)}% smaller`;
}

async function loadFixture(spec: FixtureSpec): Promise<File> {
    const response = await fetch(spec.url);
    if (!response.ok) throw new Error(`Could not load ${spec.name}: HTTP ${response.status}`);
    const blob = await response.blob();
    return new File([blob], spec.name, { type: blob.type || 'image/jpeg' });
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="metric">
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

function FixtureCard({ row }: { row: FixtureResult }) {
    const { spec, result, outputUrl } = row;
    return (
        <section className="fixture-card">
            <div className="fixture-heading">
                <div>
                    <h2>{spec.name}</h2>
                    <p>{spec.purpose}</p>
                </div>
                <span className="reduction-badge">{reductionPercent(result.original.bytes, result.output.bytes)}</span>
            </div>

            <div className="metrics-grid">
                <Metric label="Before dimensions" value={formatDimensions(result.original.width, result.original.height)} />
                <Metric label="Before bytes" value={formatBytes(result.original.bytes)} />
                <Metric label="After dimensions" value={formatDimensions(result.output.width, result.output.height)} />
                <Metric label="After bytes" value={formatBytes(result.output.bytes)} />
            </div>

            <div className="image-pair">
                <figure>
                    <figcaption>Before</figcaption>
                    <div className="full-image-frame"><img src={spec.url} alt={`${spec.name} before compression`} /></div>
                </figure>
                <figure>
                    <figcaption>After · {result.file.name}</figcaption>
                    <div className="full-image-frame"><img src={outputUrl} alt={`${spec.name} after compression`} /></div>
                </figure>
            </div>
        </section>
    );
}

function NativeCrop({ label, url, width, height }: { label: string; url: string; width: number; height: number }) {
    const left = Math.round(width * 0.31);
    const top = Math.round(height * 0.42);
    return (
        <figure>
            <figcaption>{label} · 100% pixel zoom</figcaption>
            <div className="native-crop">
                <img
                    src={url}
                    alt={`${label} crop of model and serial label`}
                    style={{ width, height, left: -left, top: -top }}
                />
            </div>
        </figure>
    );
}

function LabelCropComparison({ row }: { row: FixtureResult }) {
    const originalWidth = row.result.original.width;
    const originalHeight = row.result.original.height;
    const outputWidth = row.result.output.width;
    const outputHeight = row.result.output.height;
    if (!originalWidth || !originalHeight || !outputWidth || !outputHeight) return null;

    return (
        <section className="crop-card">
            <div>
                <p className="blanc-eyebrow">Rating-label acceptance crop</p>
                <h2>MODEL JB850S T1SS · SERIAL ZV2 21708Q</h2>
                <p>Each image pixel is shown as one CSS pixel. The crop is intentionally not scaled to fit; compare letter edges and scroll the page if needed.</p>
            </div>
            <div className="crop-pair">
                <NativeCrop label="Before" url={row.spec.url} width={originalWidth} height={originalHeight} />
                <NativeCrop label="After" url={row.outputUrl} width={outputWidth} height={outputHeight} />
            </div>
        </section>
    );
}

function Harness() {
    const [maxLongEdge, setMaxLongEdge] = useState<number>(DEFAULT_IMAGE_COMPRESSION_OPTIONS.maxLongEdge);
    const [quality, setQuality] = useState<number>(DEFAULT_IMAGE_COMPRESSION_OPTIONS.quality);
    const [rows, setRows] = useState<FixtureResult[]>([]);
    const [status, setStatus] = useState('Loading fixtures…');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const objectUrls: string[] = [];
        setRows([]);
        setError(null);
        setStatus('Loading fixtures…');

        const run = async () => {
            try {
                const files: File[] = [];
                for (const spec of FIXTURES) files.push(await loadFixture(spec));
                if (cancelled) return;

                setStatus(`Compressing 0 / ${files.length}…`);
                const results = await compressImagesForUpload(
                    files,
                    { maxLongEdge, quality, skipBelowBytes: DEFAULT_IMAGE_COMPRESSION_OPTIONS.skipBelowBytes },
                    ({ completed, total, file }) => {
                        if (!cancelled) setStatus(`Compressed ${completed} / ${total}: ${file.name}`);
                    },
                );
                if (cancelled) return;

                const nextRows = results.map((result, index) => {
                    const outputUrl = URL.createObjectURL(result.file);
                    objectUrls.push(outputUrl);
                    return { spec: FIXTURES[index]!, result, outputUrl };
                });
                setRows(nextRows);
                setStatus(`Ready · ${maxLongEdge}px long edge · JPEG q${quality}`);
            } catch (caught) {
                if (!cancelled) {
                    setError(caught instanceof Error ? caught.message : 'Compression failed');
                    setStatus('Failed');
                }
            }
        };

        void run();
        return () => {
            cancelled = true;
            objectUrls.forEach(url => URL.revokeObjectURL(url));
        };
    }, [maxLongEdge, quality]);

    const labelRow = rows.find(row => row.spec.name === 'label.jpeg');

    return (
        <main className="harness-shell">
            <header>
                <p className="blanc-eyebrow">NOTE-PHOTO-COMPRESS-001 · harness only</p>
                <h1>Note photo compression</h1>
                <p>Native browser canvas, production module, no backend and no third-party image dependency.</p>
            </header>

            <section className="controls" aria-label="Compression parameters">
                <fieldset>
                    <legend>Maximum long edge</legend>
                    <div className="control-options">
                        {LONG_EDGES.map(value => (
                            <button key={value} type="button" className={maxLongEdge === value ? 'active' : ''} onClick={() => setMaxLongEdge(value)}>
                                {value}px
                            </button>
                        ))}
                    </div>
                </fieldset>
                <fieldset>
                    <legend>JPEG quality</legend>
                    <div className="control-options">
                        {QUALITIES.map(value => (
                            <button key={value} type="button" className={quality === value ? 'active' : ''} onClick={() => setQuality(value)}>
                                q{value}
                            </button>
                        ))}
                    </div>
                </fieldset>
                <div className="status" role="status">{status}</div>
            </section>

            {error && <div className="error" role="alert">{error}</div>}
            {labelRow && <LabelCropComparison row={labelRow} />}
            <div className="fixture-list">
                {rows.map(row => <FixtureCard key={row.spec.name} row={row} />)}
            </div>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
