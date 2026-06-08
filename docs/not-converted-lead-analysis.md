# Not-Converted Lead Analysis

Источник: `exports/primary-lead-qualification-candidates-20260608.jsonl`.

Raw bucket `not_converted = 216` был эвристическим. После аудита:

- `177` выглядят как реальные no-booking outcomes по summary.
- `16` выглядят как false positives: appointment был scheduled, но строка попала в not-converted из-за слов вроде `model number`, `call back`, `parts`.
- `23` требуют ручной проверки: в них есть callback/confirm ambiguity, но не всегда понятно, был ли слот окончательно забронирован.

Для практического анализа я смотрел `200` звонков: реальные no-booking + ambiguous, исключая явные scheduled false positives.

## Главные Причины

| Reason | Count | Share |
|---|---:|---:|
| Wants exact quote / part certainty before visit | 128 | 64% |
| Availability or urgency mismatch | 26 | 13% |
| Generic hesitation / no close | 24 | 12% |
| Diagnostic fee objection | 8 | 4% |
| Needs spouse/tenant/manager/logistics confirmation | 8 | 4% |
| Warranty/manufacturer uncertainty | 5 | 2.5% |
| Shopping around | 1 | 0.5% |

Appliances most represented in this loss bucket:

- refrigerator/fridge/freezer: dominant urgency/food-loss category;
- washer/washing machine;
- dryer;
- stove/oven/range;
- dishwasher.

Call length pattern:

- `<1 min`: 18
- `1-2 min`: 50
- `2-4 min`: 90
- `4-7 min`: 37
- `7m+`: 5

Most losses happened before a strong close. The customer asked about price, model/part, or timing, got an informational answer, then left with "I'll call back".

## Core Diagnosis

The main issue is not the $95 fee by itself. The bigger issue is that many customers wanted certainty before committing:

- "How much will this repair cost?"
- "Can you quote the belt/gasket/control board/glass top?"
- "I already know the part."
- "Can I send the model number?"
- "Is it worth repairing?"
- "Can you come earlier/today?"

The dispatcher often answered factually but did not convert the answer into a scheduling decision. The conversation became:

1. Customer asks for quote/certainty.
2. Dispatcher says exact price requires diagnostic or technical department.
3. Customer says they will call back / think / check.
4. Call ends without a reserved slot.

Better pattern:

1. Acknowledge the need for certainty.
2. Give the safe boundary: exact estimate after diagnostic.
3. Reframe the visit as the fastest way to get certainty.
4. Offer a concrete slot immediately.
5. If model/photo is useful, collect it while still keeping the appointment motion alive.

## How To Convert These Better

### 1. Quote Before Visit

Bad outcome pattern:

```text
Customer: How much to replace the belt/control board/gasket?
Dispatcher: I need to ask technical department. We will call you back.
```

Better:

```text
I understand you want the price before committing. For that part, the final price depends on the exact model and diagnosis. The fastest way to get an accurate estimate is to schedule the diagnostic. The $95 service call is applied toward the repair if you proceed. I can also note the suspected part and model for the technician. We have [slot]. Should I reserve that?
```

If customer has model/serial:

```text
Great, please send the model/serial photo to this number. I can still reserve the diagnostic window now, and the technician will use that information to prepare. The exact estimate is confirmed after inspection.
```

### 2. $95 Fee Objection

Bad outcome pattern:

```text
Customer: $95 just to come out?
Dispatcher: Yes, that's our service fee.
Customer: I'll call back.
```

Better:

```text
I understand. The $95 is not an extra charge if you repair with us. It covers the visit and diagnostic, and if you approve the repair, it is applied toward the final bill. If you don't repair, you still get the exact diagnosis and estimate. Would you like the earliest slot today/tomorrow?
```

For fixed-budget/old appliance:

```text
That makes sense, especially with an older appliance. The diagnostic helps you decide whether repair is worth it. If it doesn't make sense to repair, the technician will tell you before doing the work.
```

### 3. $210 Minimum Labor Shock

This came up less often than broad quote questions, but when it appeared it could kill the call.

Do not lead with `$210` unless customer specifically asks about repair labor. If asked:

```text
Our minimum labor often starts around $210 plus parts, but I don't want to guess because the exact issue may be simpler or more complex. The diagnostic gives you the accurate estimate first, and you decide before repair work starts.
```

Then close:

```text
The diagnostic slot I can offer is [slot]. Would you like to have the technician check it and give you the exact number?
```

### 4. Availability / Urgency Mismatch

Common especially for refrigerators/freezers not cooling.

Bad outcome:

```text
Customer: I need today.
Dispatcher: We only have tomorrow.
Customer: I'll call around.
```

Better:

```text
I understand, with a refrigerator that is urgent. The soonest confirmed window I have is [slot]. I recommend we reserve it so you have a technician locked in. I can add a note that earlier is preferred, and if the route opens up we can call/text you.
```

If they still want to call around:

```text
That's fine. I can hold the next available option by creating the appointment now; if you find someone earlier, call or text us back. Otherwise you won't lose this window.
```

Use this only if operations allows cancellation/adjustment without penalty. If not, say:

```text
I can give you our direct number, but the window is only confirmed once we book it.
```

### 5. Spouse / Tenant / Manager Confirmation

Bad outcome:

```text
Customer: I need to ask my husband/tenant/manager.
Dispatcher: Okay, call us back.
```

Better:

```text
No problem. To avoid losing the slot, we can schedule it now and add the correct contact notes. Who should the technician call for access, and who approves payment?
```

If decision-maker is unavailable:

```text
Would you like me to send the appointment details by text so you can confirm with them? The available window is [slot].
```

Landlord/tenant pattern:

```text
I can list the tenant as the access contact and you as the payer/approval contact. The technician can text the tenant before arrival and call you for payment approval.
```

### 6. Warranty Uncertainty

Some customers had new appliances or wanted manufacturer warranty. These should not be pushed too hard, but there is still a private-service close when urgency is high.

```text
We are a private appliance repair company, so we don't process manufacturer warranty. If you want warranty coverage, the manufacturer is the right path. If you want faster private service, we can schedule a diagnostic for [slot], and the $95 applies toward repair if you proceed.
```

### 7. Generic Callback

When the customer says "I'll call back", the dispatcher should ask one soft closing question before ending.

```text
Of course. Before I let you go, is the main concern the price, the timing, or needing to check with someone?
```

Then route:

- price: explain diagnostic credit and decision-before-repair;
- timing: offer nearest slot and earlier-arrival note;
- other person: collect/access/payer notes or offer text confirmation.

## Updated Bot Rule

The bot should treat "call back" as an objection, not as the end of the call.

When customer says they will call back, ask once:

```text
Sure. Just so I can help: is it the price, the appointment time, or do you need to confirm with someone?
```

Then make one relevant attempt to close. If the customer still declines, end politely and record the reason.

## Most Important Prompt Patch

```text
If the caller asks for an exact repair quote before scheduling, do not end with "we will call you back" unless technical review is truly required. Explain that the accurate estimate comes after diagnostic, that the service call is credited toward repair, and immediately offer a concrete appointment window. If model/serial/photos are useful, collect them as notes while still trying to reserve a diagnostic slot.

If the caller says "I'll call back", ask one clarifying close: "Is the main concern price, timing, or checking with someone?" Handle that objection and offer the best concrete slot one more time.
```
