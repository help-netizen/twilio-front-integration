# INSPECTOR-LLM-QUEUE-001 — paced single-flight LLM queue

**Date:** 2026-07-20  
**Status:** Implemented and deterministically verified

## Scope

Add in-process quota insurance around Inspector's provider-neutral JSON LLM transport:

- serialize Inspector calls through one FIFO, single-flight queue;
- keep a configurable minimum interval between every Inspector HTTP request start, including retries;
- retry transient provider failures with bounded exponential backoff plus jitter;
- honor a larger provider `Retry-After` value;
- enforce one maximum-attempt ceiling across retries and model fallback;
- preserve Inspector spend-cap safe-stop behavior; and
- leave Mail Secretary's call site and legacy transport behavior unchanged.

This change does not add a route, worker, webhook, query, migration, permission, or user-facing
surface. It does not change `INSPECTOR-AGENT-001.md` or `src/server.js`.

## Shared-client decision

`jsonLlmClient` remains shared infrastructure, but pacing is opt-in per call. The generic client
exports `createPacedQueue()` and only enters the paced path when the caller supplies a `rateLimit`
object with an explicit queue. `inspectorClassifier` owns one module-level queue and supplies that
option. `mailAgentClassifier` supplies no `rateLimit` option, so it keeps the existing `maxRetries`
and fixed `backoffMs` behavior. Neither Mail Secretary source file changed.

A process-global default limiter was rejected because it would serialize unrelated Mail Secretary
traffic. A purpose-keyed registry was also unnecessary: an explicit queue makes ownership visible
at the Inspector call site and gives tests an isolated state object.

## Queue and retry contract

The queue holds one complete `generateJson` operation, including its retry waits, so no two calls
using the Inspector queue can have provider requests in flight concurrently. Before each provider
request, the queue waits until at least `minIntervalMs` has elapsed since the previous request start.
Queued calls are admitted FIFO.

For retry index `n`, starting at zero, the client delay is:

`min(maxBackoffMs, baseBackoffMs * 2^n + jitter)`

Jitter is uniformly sampled from zero through 25% of the exponential delay, constrained by the
remaining cap. Tests inject a zero-valued random source. The actual retry wait is the greater of
that calculated delay and the parsed `Retry-After`. The local exponential delay is capped;
`Retry-After` remains an authoritative lower bound even when it exceeds that cap.

The paced path counts HTTP request starts across the whole call. Model fallback cannot exceed
`maxAttempts`. Existing bad-JSON and network-error retries remain bounded by the same ceiling;
the required 429, 500, 502, 503, 504, and timeout cases retain their typed retryable behavior.

Inspector sets `allowModelFallbackOn429: false`. Its existing wrapper treats every final 429 as a
spend-cap/rate-limit stop, because the current transport contract has no reliable provider-body
signal that distinguishes a per-minute quota from account spend exhaustion. Therefore Inspector
stops on its first 429; generic paced callers that allow 429 fallback/retry do retry it. This favors
the existing spend-cap safety contract over guessing at an undocumented signal.

The Gemini thinking fix remains intact: Gemini requests still set
`generationConfig.thinkingConfig.thinkingBudget` to zero by default, and Inspector still requests
`maxOutputTokens: 1024`.

## Configuration

All values are parsed with the existing bounded-integer helper.

| variable | default | bounds | meaning |
|---|---:|---:|---|
| `INSPECTOR_LLM_MIN_INTERVAL_MS` | 250 | 0–60,000 | minimum time between Inspector request starts |
| `INSPECTOR_LLM_MAX_ATTEMPTS` | 3 | 1–5 | total HTTP attempts for one entity, including model fallback |
| `INSPECTOR_LLM_BASE_BACKOFF_MS` | 1,000 | 0–60,000 | first retry's exponential base |
| `INSPECTOR_LLM_MAX_BACKOFF_MS` | 30,000 | 0–300,000, raised to base when lower | local exponential/jitter cap |

`INSPECTOR_AGENT_TIMEOUT_MS` and provider/model settings are unchanged. If the new attempts knob is
absent, the existing `INSPECTOR_AGENT_RETRY_MAX` remains a compatibility fallback and is translated
as `maxAttempts = maxRetries + 1`; the default remains three attempts. Mail Secretary continues
using `MAIL_AGENT_RETRY_MAX` through the client's non-paced legacy path.

## Tenancy and roles

No data-level tenancy or RBAC surface is introduced. Queue state contains only scheduling times and
promises, never company data. One Inspector queue serializes any concurrent Inspector calls in the
same Node process, but the existing scheduler runs one company at a time. The opt-in design prevents
Inspector pacing from affecting Mail Secretary or other shared-client callers.

## Risks and operational limits

- The queue is in-process, not distributed. Multiple Node processes can each start one request;
  enforcing a provider-account quota across a horizontally scaled deployment would require a
  shared limiter.
- The 250 ms default is light pacing, not proof of compliance with every possible per-minute quota;
  operations must configure it for the account's actual quota.
- A retrying call holds the FIFO during backoff. This preserves strict single-flight ordering but
  creates intentional head-of-line delay for later entities.
- Inspector cannot safely retry some 429s while immediately stopping only spend-cap 429s until a
  documented, tested provider error signal is added to the transport contract.

## Verification

### Deterministic coverage

- `SAB-INSP-LLM-PACING`: two concurrent calls share an injected queue, sleep, and clock; request
  starts are exactly `[0, 100]` and maximum in-flight count is one.
- `SAB-INSP-LLM-BACKOFF`: injected sleep/clock/random prove waits `[100, 350, 400]`; the middle wait
  honors a 350 ms `Retry-After`, while the unmasked waits prove exponential growth.
- Maximum attempts: three configured attempts yield exactly three provider starts and prevent a
  fallback model from exceeding the ceiling.
- `SAB-INSP-SPEND-CAP`: paced Inspector policy surfaces the first typed 429, preserves the 60-second
  retry hint, performs one provider call, and performs no sleep.
- Inspector wrapper: the four bounded env values and Inspector queue reach `generateJson`, while
  `maxOutputTokens` remains 1024.
- Thinking-budget regression: Gemini request JSON still contains
  `thinkingConfig: { thinkingBudget: 0 }`, with per-call override coverage.
- Mail unchanged: `mailAgentClassifier` passes no `rateLimit`; both classifier and service suites
  remain green.

Final restored-code command:

```sh
node --experimental-vm-modules --use-bundled-ca ../../../node_modules/jest/bin/jest.js --runInBand --config ./package.json --testPathIgnorePatterns /node_modules/ --runTestsByPath tests/jsonLlmClient.test.js tests/inspectorClassifier.test.js tests/inspectorRunner.test.js tests/mailAgentClassifier.test.js tests/mailAgentService.test.js
```

Result: exit 0; 5 suites passed, 36 tests passed, 0 snapshots.

The literal required-form command without a worktree ignore override was also run:

```sh
node --experimental-vm-modules --use-bundled-ca ../../../node_modules/jest/bin/jest.js --runInBand --config ./package.json --runTestsByPath tests/jsonLlmClient.test.js tests/inspectorClassifier.test.js tests/inspectorRunner.test.js tests/mailAgentClassifier.test.js tests/mailAgentService.test.js
```

Result: exit 1; Jest found no tests because committed `package.json` ignores
`/.claude/worktrees/`. The final command above overrides only that ignore while retaining
`/node_modules/`.

### Named sabotage controls

Before sabotage, `backend/src/services/llm/jsonLlmClient.js` was copied to
`/private/tmp/inspector-llm-queue-jsonLlmClient.js.bak`. Each sabotage was applied separately and
restored with `cp` from that file; `git checkout` was never used. `cmp -s` verified each restore,
and the temporary copy was removed after both controls.

1. Removed the call to `rateLimit.queue.waitForStart`, then ran:

   ```sh
   node --experimental-vm-modules --use-bundled-ca ../../../node_modules/jest/bin/jest.js --runInBand --config ./package.json --testPathIgnorePatterns /node_modules/ --runTestsByPath tests/jsonLlmClient.test.js --testNamePattern SAB-INSP-LLM-PACING
   ```

   Result: exit 1 as required; observed starts `[0, 0]`, expected `[0, 100]`.

2. Replaced `baseBackoffMs * (2 ** retryIndex)` with flat `baseBackoffMs`, then ran:

   ```sh
   node --experimental-vm-modules --use-bundled-ca ../../../node_modules/jest/bin/jest.js --runInBand --config ./package.json --testPathIgnorePatterns /node_modules/ --runTestsByPath tests/jsonLlmClient.test.js --testNamePattern SAB-INSP-LLM-BACKOFF
   ```

   Result: exit 1 as required; observed waits `[100, 350, 100]`, expected `[100, 350, 400]`.

No external Gemini call was made: the sandbox has no network, this task is transport hardening, and
the frame already records the live Tier-1 probe (15 rapid calls returned HTTP 200). Verification is
fully deterministic and exercises the real queue/retry path.
