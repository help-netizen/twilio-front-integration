import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '../ui/button';

interface DiagramPreviewProps {
    scxmlContent: string;
}

const ZOOM_STEP = 0.15;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;

/**
 * Parse SCXML XML and convert to state-machine-cat (smcat) notation.
 */
function scxmlToSmcat(xmlString: string): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'text/xml');

    const parseError = doc.querySelector('parsererror');
    if (parseError) {
        throw new Error(`XML parse error: ${parseError.textContent?.slice(0, 200)}`);
    }

    const scxml = doc.querySelector('scxml');
    if (!scxml) throw new Error('No <scxml> element found');

    const initial = scxml.getAttribute('initial') || '';
    const BLANC_NS = 'https://blanc.app/fsm';

    const allStates = doc.querySelectorAll('state, final');
    const labelMap = new Map<string, string>();
    const finalStates = new Set<string>();

    allStates.forEach(state => {
        const id = state.getAttribute('id') || '';
        const label = state.getAttributeNS(BLANC_NS, 'statusName') ||
                      state.getAttributeNS(BLANC_NS, 'label') ||
                      id.replace(/_/g, ' ');
        labelMap.set(id, label);
        if (state.tagName === 'final') {
            finalStates.add(id);
        }
    });

    // Declare states with labels and type attributes
    const stateDecls: string[] = [];
    allStates.forEach(state => {
        const id = state.getAttribute('id') || '';
        const label = labelMap.get(id) || id;
        const attrs: string[] = [];
        if (label !== id) attrs.push(`label="${label}"`);
        if (finalStates.has(id)) attrs.push('color="grey"');
        const attrStr = attrs.length > 0 ? ` [${attrs.join(' ')}]` : '';
        stateDecls.push(`${id}${attrStr}`);
    });

    const lines: string[] = [];

    // State declarations (comma-separated, semicolon-terminated)
    if (stateDecls.length > 0) {
        lines.push(stateDecls.join(',\n') + ';');
        lines.push('');
    }

    // Initial transition
    if (initial && labelMap.has(initial)) {
        lines.push(`initial -> ${initial};`);
    }

    // Transitions
    allStates.forEach(state => {
        const id = state.getAttribute('id') || '';
        const transitions = state.querySelectorAll(':scope > transition');
        transitions.forEach(tr => {
            const target = tr.getAttribute('target') || '';
            const event = tr.getAttribute('event') || '';
            const trLabel = tr.getAttributeNS(BLANC_NS, 'label') || event;
            if (trLabel) {
                lines.push(`${id} -> ${target} : ${trLabel};`);
            } else {
                lines.push(`${id} -> ${target};`);
            }
        });
    });

    if (stateDecls.length === 0) {
        throw new Error('No states or transitions found in SCXML');
    }

    return lines.join('\n');
}

async function renderSmcatToSvg(smcatString: string): Promise<string> {
    const smc = await import('state-machine-cat');
    const svg = await smc.render(smcatString, { outputType: 'svg' });
    return svg;
}

export function DiagramPreview({ scxmlContent }: DiagramPreviewProps) {
    const [svgString, setSvgString] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [zoom, setZoom] = useState(1);
    const containerRef = useRef<HTMLDivElement>(null);
    const renderIdRef = useRef(0);

    const debouncedContent = useDebounce(scxmlContent, 300);

    useEffect(() => {
        if (!debouncedContent.trim()) {
            setSvgString('');
            setError(null);
            return;
        }

        const currentId = ++renderIdRef.current;
        setLoading(true);

        (async () => {
            try {
                const smcat = scxmlToSmcat(debouncedContent);
                const svg = await renderSmcatToSvg(smcat);

                // Only update if this is still the latest render
                if (currentId === renderIdRef.current) {
                    setSvgString(svg);
                    setError(null);
                }
            } catch (err) {
                if (currentId === renderIdRef.current) {
                    setSvgString('');
                    setError(err instanceof Error ? err.message : String(err));
                }
            } finally {
                if (currentId === renderIdRef.current) {
                    setLoading(false);
                }
            }
        })();
    }, [debouncedContent]);

    const handleZoomIn = useCallback(() => {
        setZoom(z => Math.min(z + ZOOM_STEP, ZOOM_MAX));
    }, []);

    const handleZoomOut = useCallback(() => {
        setZoom(z => Math.max(z - ZOOM_STEP, ZOOM_MIN));
    }, []);

    const handleFitToScreen = useCallback(() => {
        setZoom(1);
        if (containerRef.current) {
            containerRef.current.scrollTo(0, 0);
        }
    }, []);

    const zoomPercent = useMemo(() => Math.round(zoom * 100), [zoom]);

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar */}
            <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--blanc-line)]">
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleZoomOut}
                    disabled={zoom <= ZOOM_MIN}
                    className="h-7 w-7 p-0"
                    title="Zoom out"
                >
                    <ZoomOut className="h-3.5 w-3.5" />
                </Button>
                <span className="text-xs text-[var(--blanc-ink-3)] min-w-[3rem] text-center tabular-nums">
                    {zoomPercent}%
                </span>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleZoomIn}
                    disabled={zoom >= ZOOM_MAX}
                    className="h-7 w-7 p-0"
                    title="Zoom in"
                >
                    <ZoomIn className="h-3.5 w-3.5" />
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleFitToScreen}
                    className="h-7 w-7 p-0"
                    title="Fit to screen"
                >
                    <Maximize2 className="h-3.5 w-3.5" />
                </Button>

                {loading && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--blanc-ink-3)] ml-auto" />
                )}
            </div>

            {/* Canvas */}
            <div
                ref={containerRef}
                className="flex-1 overflow-auto bg-[var(--blanc-bg)]"
            >
                {error ? (
                    <div className="flex flex-col items-center justify-center h-full gap-2 px-6">
                        <AlertTriangle className="h-5 w-5 text-[var(--blanc-ink-3)]" />
                        <p className="text-sm font-medium text-[var(--blanc-ink-2)]">
                            Can't render diagram
                        </p>
                        <p className="text-xs text-[var(--blanc-ink-3)] text-center max-w-md break-words">
                            {error}
                        </p>
                    </div>
                ) : svgString ? (
                    <div
                        className="p-4 inline-block min-w-full"
                        style={{
                            transform: `scale(${zoom})`,
                            transformOrigin: 'top left',
                        }}
                    >
                        <div
                            className="[&>svg]:max-w-full [&>svg]:h-auto"
                            dangerouslySetInnerHTML={{ __html: svgString }}
                        />
                    </div>
                ) : !loading ? (
                    <div className="flex items-center justify-center h-full">
                        <p className="text-sm text-[var(--blanc-ink-3)]">
                            No diagram to display
                        </p>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

/** Simple debounce hook */
function useDebounce<T>(value: T, delay: number): T {
    const [debounced, setDebounced] = useState(value);

    useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);

    return debounced;
}

export { scxmlToSmcat };
