import { useState } from 'react';
import { AlertCircle, Loader2, MapPin, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { AreaCodeSearchCriterion } from '../../data/areaCodes';
import { authedFetch } from '../../services/apiClient';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { FloatingField } from '../ui/floating-field';
import { AreaCodeCombo } from './AreaCodeCombo';

interface FoundNumber {
    phone_number: string;
    locality: string | null;
    region: string | null;
    capabilities?: { voice?: boolean; sms?: boolean };
    monthly_price_usd?: number | string | null;
}

interface NumberSearchProps {
    onPurchased: () => void | Promise<void>;
    onViewPlans: () => void;
}

function InlineError({ text }: { text: string }) {
    return (
        <div className="flex items-start gap-1.5 text-[13px] text-[var(--blanc-danger)]">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{text}</span>
        </div>
    );
}

export function NumberSearch({ onPurchased, onViewPlans }: NumberSearchProps) {
    const [searchCriterion, setSearchCriterion] = useState<AreaCodeSearchCriterion | null>(null);
    const [incompleteAreaCode, setIncompleteAreaCode] = useState(false);
    const [containsDigits, setContainsDigits] = useState('');
    const [tollFree, setTollFree] = useState(false);
    const [searching, setSearching] = useState(false);
    const [searched, setSearched] = useState(false);
    const [results, setResults] = useState<FoundNumber[]>([]);
    const [buying, setBuying] = useState<string | null>(null);
    const [limitUpsell, setLimitUpsell] = useState<string | null>(null);
    const [numberError, setNumberError] = useState<string | null>(null);

    const runSearch = async () => {
        if (incompleteAreaCode) return;
        setSearching(true);
        setNumberError(null);
        try {
            const qs = new URLSearchParams();
            if (searchCriterion) qs.set(searchCriterion.kind, searchCriterion.value);
            if (containsDigits.trim()) qs.set('contains', containsDigits.trim());
            if (tollFree) qs.set('toll_free', 'true');
            const response = await authedFetch(`/api/telephony/numbers/search?${qs}`);
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                if (response.status === 403) {
                    setNumberError("You don't have permission to manage telephony — ask your administrator.");
                } else if (response.status >= 500) {
                    setNumberError('Could not set up your phone workspace — try again.');
                } else {
                    toast.error(body.error || 'Number search failed');
                }
                return;
            }
            setResults(Array.isArray(body.results) ? body.results : []);
            setSearched(true);
        } catch {
            setNumberError('Could not set up your phone workspace — try again.');
        } finally {
            setSearching(false);
        }
    };

    const buyNumber = async (phone: string) => {
        setBuying(phone);
        try {
            const response = await authedFetch('/api/telephony/numbers/buy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone_number: phone }),
            });
            const body = await response.json().catch(() => ({}));
            if (response.ok) {
                setLimitUpsell(null);
                await onPurchased();
                return;
            }
            if (response.status === 422 && body.code === 'NUMBER_LIMIT') {
                setLimitUpsell(body.error || 'Your plan does not include more phone numbers.');
                return;
            }
            if (response.status === 409) {
                toast.error(body.error || 'This number was just taken — pick another one');
                await runSearch();
                return;
            }
            if (response.status === 403) {
                setNumberError("You don't have permission to manage telephony — ask your administrator.");
                return;
            }
            if (response.status >= 500) {
                setNumberError('Could not set up your phone workspace — try again.');
                return;
            }
            toast.error('Failed to buy the number');
        } catch {
            toast.error('Failed to buy the number');
        } finally {
            setBuying(null);
        }
    };

    const priceFor = (found: FoundNumber) =>
        `$${Number(found.monthly_price_usd ?? (tollFree ? 2.15 : 1.15)).toFixed(2)}/mo`;

    return (
        <div className="space-y-6">
            {limitUpsell && (
                <div className="rounded-2xl border border-[var(--blanc-warning)] bg-[var(--blanc-surface-muted)] px-4 py-3.5">
                    <div className="text-[13.5px] text-[var(--blanc-ink-1)]">{limitUpsell}</div>
                    <div className="mt-1 text-[13px] text-[var(--blanc-ink-2)]">
                        Need more numbers? Switch to a package plan.
                    </div>
                    <Button size="sm" className="mt-2.5" onClick={() => { setLimitUpsell(null); onViewPlans(); }}>
                        View plans
                    </Button>
                </div>
            )}

            {numberError && <InlineError text={numberError} />}

            <div className="space-y-3.5">
                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                    <AreaCodeCombo
                        value={searchCriterion}
                        onChange={setSearchCriterion}
                        onIncompleteChange={setIncompleteAreaCode}
                        disabled={searching}
                    />
                    <FloatingField
                        label="Contains digits"
                        value={containsDigits}
                        onChange={event => setContainsDigits(event.target.value)}
                    />
                </div>
                <div className="flex flex-wrap items-center gap-4">
                    <label className="flex cursor-pointer items-center gap-2 text-[13.5px] text-[var(--blanc-ink-1)]">
                        <Checkbox checked={tollFree} onCheckedChange={checked => setTollFree(checked === true)} />
                        Toll-free
                    </label>
                    <Button onClick={runSearch} disabled={searching || incompleteAreaCode}>
                        {searching
                            ? <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                            : <Search className="mr-1.5 size-3.5" />}
                        Search
                    </Button>
                </div>
            </div>

            {searched && !searching && results.length === 0 && (
                <p className="mx-0.5 text-[13.5px] text-[var(--blanc-ink-3)]">
                    No numbers found — try another area code or city.
                </p>
            )}

            {results.length > 0 && (
                <div className="flex flex-col gap-2">
                    {results.map(found => (
                        <div
                            key={found.phone_number}
                            className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--blanc-line)] bg-[var(--blanc-surface-strong)] px-3.5 py-2.5"
                        >
                            <div className="min-w-[200px] flex-[1_1_200px]">
                                <div className="text-sm font-semibold text-[var(--blanc-ink-1)]">{found.phone_number}</div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-[var(--blanc-ink-2)]">
                                    <MapPin className="size-3 shrink-0 text-[var(--blanc-ink-3)]" />
                                    <span>{[found.locality, found.region].filter(Boolean).join(', ') || 'US'}</span>
                                    {found.capabilities?.voice && <Badge variant="outline" className="text-[10px]">Voice</Badge>}
                                    {found.capabilities?.sms && <Badge variant="outline" className="text-[10px]">SMS</Badge>}
                                </div>
                            </div>
                            <span className="text-xs font-semibold text-[var(--blanc-ink-2)]">{priceFor(found)}</span>
                            <Button size="sm" onClick={() => buyNumber(found.phone_number)} disabled={buying != null}>
                                {buying === found.phone_number && <Loader2 className="mr-1.5 size-3 animate-spin" />}
                                Buy
                            </Button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
