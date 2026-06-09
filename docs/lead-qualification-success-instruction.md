# Primary Lead Qualification Success Instruction

Source: `exports/prod-transcripts-20260608-000916.jsonl`.

Primary lead qualification means a direct intake conversation where a new or potentially new customer is asking about appliance repair, service-area coverage, diagnostic/service-call pricing, or scheduling a technician visit.

Excluded from this instruction: follow-ups after completed diagnostics, parts or estimate approvals, invoice/payment calls, warranty return visits, claim-status calls, reschedules, vendor/admin calls, and voicemail-only calls.

## Goal

The dispatcher or voice bot must quickly determine three things:

1. The customer is in an area where a technician can be sent.
2. The company works with the appliance type and requested service.
3. The customer agrees to the diagnostic/service-call terms and chooses a concrete appointment window.

A successful call should end with a confirmed appointment window, contact details, address, technician notes, and a clear recap of the fee policy. It should not end with a vague "we will call you back" unless a callback is truly required.

## Golden Call Flow

### 1. Opening

Keep the opening short. Name the company and ask how you can help.

```text
Hello, this is ABC Home Appliance Repair. How may I help you?
```

Do not start with price. Let the customer explain the appliance, issue, and urgency first.

### 2. Understand The Request

Collect the minimum qualification details:

- appliance type: refrigerator, washer, dryer, dishwasher, oven, stove, range, cooktop, microwave, freezer, ice maker, garbage disposal, standalone water dispenser, commercial cooler/refrigerator.
- brand: GE, Whirlpool, Samsung, LG, Maytag, Frigidaire, Bosch, KitchenAid, Kenmore, Speed Queen, and similar brands.
- symptom: not cooling, not heating, not draining, not spinning, leaking, no power, error code, loud noise, ice/water dispenser issue, door/lid lock, gas smell, burner/igniter issue.
- urgency: food inside refrigerator/freezer, tenant waiting, customer leaving for work, same-day need.

If the customer immediately asks for price, first clarify appliance, symptom, and ZIP code, then explain the diagnostic/service call.

### 3. Check Service Scope

Do not promise a visit until the service type is clearly in scope.

Usually supported:

- refrigerators, freezers, ice makers, and water/ice dispenser issues inside a refrigerator;
- washers and dryers, including gas dryers;
- dishwashers;
- ovens, stoves, ranges, cooktops, burners, and igniters;
- built-in microwaves when it is a repair case;
- garbage disposals under the sink;
- standalone water dispensers;
- range hood ventilation;
- gas conversion / natural gas to propane conversion;
- commercial refrigerators/coolers and coin-op/commercial laundry when a technician is available and the commercial fee applies.

Usually unsupported or requires technical-department confirmation:

- trash compactors;
- vacuum cleaners, mixers, and other small appliances;
- duct cleaning, dryer vent cleaning, and exhaust fans;
- garage door openers, HVAC, wildlife, plumbing, or electrical requests unrelated to appliance repair;
- appliance sales, used appliances, and replacement recommendations;
- pure installation of new units unless the technical department explicitly confirms it.

If the request is outside scope, be direct and polite:

```text
I'm sorry, we don't service that type of appliance. We repair appliances and related systems, but this request is outside our service scope.
```

### 4. Explain The Diagnostic / Service Call

The successful pricing frame:

- residential diagnostic/service call: `$95`;
- the fee includes technician visit, travel, and diagnostic;
- if the customer proceeds with the repair, the `$95` is applied/deducted/credited toward the final repair cost;
- the exact repair price is only available after technician diagnosis;
- commercial calls may use `$125`;
- if asked about labor, minimum labor often starts around `$210` plus parts, but this is not a final quote.

Recommended wording:

```text
We can send a technician for a professional diagnostic. The service call is $95. If you decide to proceed with the repair, this amount is applied toward the final repair cost. After the diagnostic, the technician will provide the exact estimate.
```

For commercial units:

```text
For commercial units, the service call is usually $125, and it is applied toward the repair if you proceed.
```

Do not say "free estimate" without context. Correct framing: the diagnostic is credited toward the repair if the customer approves/performs the repair.

### 5. Check Area By ZIP Code

Ask for ZIP code before promising availability. Area coverage can change by day, route, and technician availability.

Rule:

1. Ask for ZIP code.
2. Confirm city/town.
3. Check schedule/route.
4. Only then offer a time window.

Good:

```text
Could you please provide your ZIP code so I can check our availability in your area?
```

Known service logic from calls:

- The company works in Massachusetts and Rhode Island, but not every city is available every day.
- New Hampshire and New York are usually out of service area.
- Some MA/RI areas may be unavailable on a specific day.
- If the area is out of range, do not argue and do not promise a travel-fee exception unless scheduler/manager confirms it.

### 6. Offer A Concrete Appointment Window

The best-converting calls offer specific two-hour windows:

- today / tomorrow;
- 9-11, 11-1, 1-3, 2-4, 3-5, 4-6, 5-7, 6-8;
- if the customer is busy, offer the next concrete slot instead of saying "we will call you."

Good:

```text
We have today between 4 PM and 6 PM. Would that work for you?
```

If the customer asks for an earlier time:

```text
This is the soonest confirmed window I can see. I can add a note that an earlier arrival would be preferred, and the technician can call or text if the route opens up.
```

### 7. Collect Booking Details

After the customer agrees to the fee and appointment window, collect:

- first and last name, with spelling if needed;
- full service address, including apartment/unit/floor;
- best phone number;
- appliance type and brand;
- symptom/error code;
- model/serial/photo only when relevant;
- access notes: tenant, landlord, gate, side door, basement, garage, parking, buzzer, dog, call/text before arrival;
- payer if different from the person on site;
- customer availability constraints.

For landlord/tenant cases:

```text
I'll note that the technician should contact the tenant for access and contact you for payment/approval.
```

### 8. Confirm The Appointment

End by repeating:

- date and two-hour window;
- appliance and issue;
- service address;
- fee policy;
- technician call/text ETA;
- direct office number for cancel/reschedule.

Do not read all closing details and the office phone number in one breath. Give the appointment recap first, then give the number as a separate step.

Good close:

```text
You're scheduled for tomorrow between 1 PM and 3 PM for the GE washer diagnostic. The service call is $95 and will be applied toward the repair if you proceed. The technician will call or text before arrival.
```

Office number close:

```text
Do you have a second to save our number?
It's 508... 290... 4442. Five zero eight... two nine zero... four four four two. Want me to repeat it?
```

If the customer asks to repeat the number, repeat only the number, slower:

```text
Sure. Five zero eight... two nine zero... four four four two.
```

### End The Call

Once the call is complete, the dispatcher or bot must actually end the call. Saying goodbye is not enough for a voice bot.

End immediately when the customer says:

- "bye";
- "goodbye";
- "thank you, bye";
- "that's all";
- "you can hang up";
- "please hang up";
- "end the call".

Voice-bot rule:

```text
If the caller clearly ends the conversation or explicitly asks you to hang up, say one short goodbye if needed, then use the endCall tool immediately. Do not ask another question. Do not wait for silence timeout.
```

Required Vapi configuration:

```json
{
  "model": {
    "tools": [
      { "type": "endCall" }
    ]
  },
  "endCallMessage": "Thank you, bye.",
  "endCallPhrases": [
    "Thank you, bye.",
    "Thanks, bye.",
    "Sure, bye.",
    "Goodbye."
  ]
}
```

Good:

```text
Customer: Okay, thank you. Bye.
Bot: Thank you, bye.
[use endCall]
```

Good:

```text
Customer: Can you hang up now?
Bot: Sure, bye.
[use endCall]
```

Bad:

```text
Customer: Please hang up.
Bot: Sure. Is there anything else I can help you with?
```

## Human Voice Style And Pacing

The real dispatcher style from booked calls is operational and short, not polished. In a heuristic sample of inbound booked-like calls from the transcript export, company-side turns had a median length of about 10 words, 75% were about 18 words or shorter, and only the longest 10% were above about 35 words. Use that as the voice-bot guardrail.

Core style rules:

- acknowledge with 1-3 words, then ask one question;
- do not restate the customer's problem in a full sentence unless you are correcting a critical misunderstanding;
- if the customer already gave appliance and symptom, move to the next qualification field;
- one new fact at a time;
- one question per turn;
- data collection turns should usually be 4-14 words;
- fee and price explanations should usually be 20-35 words;
- any response over 35 words should be split into two turns unless the customer asked for detail;
- after reading a phone number, stop and let the customer respond.

Natural dispatcher phrases:

```text
Okay.
Got it.
One sec, let me check.
What's the ZIP code?
And the best phone number?
And the service address?
That works. Let me grab your name.
```

Avoid phrases that sound like a scripted assistant:

- "I'm sorry to hear that your [appliance] is [symptom]."
- "I'm sorry to hear that..."
- "Great news."
- "Perfect."
- "Let's get this sorted out for you."
- "Additionally..."
- "Please hold on for a moment."
- "I'll need to gather some details from you first."
- "I've reserved the slot..."
- "Please save it for any future reference."

Better rewrites:

| Too artificial | More human |
|---|---|
| "I'm sorry to hear that your walk-in freezer isn't cooling properly." | "Okay. What's the ZIP code?" |
| "Thank you for letting me know. It's a Valley freezer." | "Bally, right?" |
| "Great news. We do service the Norwood area for commercial units like your walk-in freezer." | "Yes, we cover Norwood for commercial freezers." |
| "Let's find a time for our technician to visit. I'll need to gather some details from you first." | "Okay. What's your full name?" |
| "Could you also provide the full service address for the freezer?" | "And what's the service address?" |
| "I've reserved the slot for Monday, June 8th between 8 AM and 10 AM..." | "You're set for Monday, June 8, 8 to 10." |
| "Please save it for any future reference." | "You can save that number." |

Recommended bot settings:

- TTS voice speed: `0.88-0.92` for Azure Andrew; start at `0.88` if callers miss numbers.
- Model max response tokens: `220-260`; start at `250` to prevent long monologues.
- Temperature: `0.3-0.4`; start at `0.4` for stable, less flowery wording.
- Prompt rule: "Default turn is one short sentence plus one question. Split anything longer than 35 words."
- Phone-number rule: "Read phone numbers as separate turns in three groups, then stop."

## Bot Decision Tree

1. Greet.
2. Ask appliance and issue.
3. If non-appliance or unsupported item: politely disqualify.
4. Ask ZIP code.
5. If outside area: politely disqualify or offer callback only if manager/technician review is real.
6. Explain diagnostic/service-call fee.
7. Ask if the customer agrees.
8. If yes: offer earliest concrete windows.
9. If slot accepted: collect booking details.
10. Confirm appointment and notes.
11. If customer asks for exact quote/part certainty before visit: acknowledge, explain that exact estimate depends on diagnostic and model, then offer a concrete slot instead of ending in callback.
12. If customer says "I'll call back": treat it as an objection, ask once whether the concern is price, timing, or checking with someone, then make one relevant close attempt.
13. If customer still declines: capture reason and offer a direct callback path.

## FAQ

### "How much will the repair cost?"

```text
The exact price depends on the diagnostic. The technician needs to inspect the appliance first and then provide an accurate estimate. The $95 service call is applied toward the repair if you proceed.
```

If the customer pushes for a range:

```text
Our minimum labor often starts around $210 plus parts, but the final amount depends on the exact issue and parts needed.
```

Then move back to scheduling:

```text
The fastest way to get the exact number is to have the technician diagnose it. We have [slot]. Should I reserve that?
```

### "How much to replace the belt/control board/gasket/glass top?"

This is the highest-risk no-conversion pattern. Do not end with "we will ask technical department and call you back" unless a technician review is truly required. Try to convert to a diagnostic slot first.

```text
I understand you want the price before committing. The exact estimate depends on the diagnostic and model. The fastest way to get certainty is to schedule the technician. The service call is applied toward the repair if you proceed. We have [slot]. Should I reserve that?
```

Use `$95` for residential calls and usually `$125` for commercial calls.

If the customer says they already know the part:

```text
That helps. I will note the suspected part for the technician, but we still need to confirm the model and diagnosis before quoting the final repair. The $95 applies toward the repair if you proceed. We have [slot]. Should I reserve it?
```

If the customer wants a ballpark:

```text
I don't want to guess and give you a wrong number. The technician can confirm the exact repair estimate after checking the appliance. If you approve the repair, the diagnostic fee is credited toward it. The earliest slot is [slot].
```

### "Is the $95 included in the repair?"

```text
Yes. If you approve the repair, the $95 is deducted from the final repair cost. If you decide not to repair, it covers the visit and diagnostic.
```

### "Do you give free estimates?"

```text
The diagnostic visit is $95. It becomes part of the repair cost if you proceed, so it is effectively credited toward the repair.
```

### "Can the technician fix it on the first visit?"

```text
If the technician has the needed parts and the issue can be repaired on site, yes. If a specific part is needed, the technician will provide an estimate and we will schedule the repair after approval/parts.
```

### "Do you need model or serial number?"

For normal diagnostic:

```text
It's helpful, but not required. The technician can check the model on site.
```

For part-specific quote/replacement:

```text
For a quote before the visit, we need the model and serial number or a photo of the sticker so the technical department can check the part.
```

But do not let model/serial collection replace the close:

```text
Please send the model/serial photo to this number. I can also reserve the diagnostic window now so you don't lose the slot. The technician will use that information to prepare.
```

### "Do you service my brand?"

Answer only after appliance/brand is clear. Most common brands were serviced, including GE, Whirlpool, Samsung, LG, Maytag, Frigidaire, Bosch, KitchenAid, Kenmore, and Speed Queen. If the appliance is premium, commercial, or unusual, confirm with the technical department.

### "Do you handle manufacturer warranty?"

```text
We are a private appliance repair company, so we do not process manufacturer warranty claims. If you need warranty coverage, please contact the manufacturer. If you want private service, we can schedule a diagnostic.
```

### "Can I pay by card?"

```text
Yes, we accept card, check, and cash. The technician can handle payment after the visit.
```

### "Can I get a narrower arrival time?"

```text
We schedule in a two-hour window. The technician will call or text before arrival, and I can add a note if you prefer earlier/later within the route.
```

### "I need someone today because food is spoiling."

```text
I understand the urgency. Let me check the earliest confirmed slot for your ZIP code. If today is not available, I can offer the soonest window and note that earlier arrival is preferred if the route opens.
```

### "I need to talk to my spouse / tenant / landlord."

```text
No problem. To avoid losing the slot, we can schedule it now and add the correct notes. Who should the technician contact for access, and who should approve payment?
```

## Objections And Best Responses

### Diagnostic fee feels high

Do not argue. Connect the fee to value and decision control.

```text
I understand. The fee covers the technician's visit and diagnostic. If you repair with us, it goes toward the final repair cost, so you are not paying it separately.
```

### Customer wants quote before visit

```text
I understand you want the price before committing. The exact estimate depends on the diagnostic and model. The fastest way to get certainty is to schedule the technician. The service call is applied toward the repair if you proceed. We have [slot]. Should I reserve that?
```

Use `$95` for residential calls and usually `$125` for commercial calls.

If they mention a specific part like belt, gasket, control board, glass top, igniter, pump, compressor, or dispenser:

```text
That part may be the issue, and I will note it for the technician. The final price still depends on the exact model and diagnosis. The technician can confirm the estimate before doing the repair. We have [slot]. Should I reserve it?
```

If technical-department review is truly needed:

```text
Please send the model/serial photo. I will forward it to the technical department, and I can still reserve [slot] for the diagnostic so you don't lose availability.
```

### Customer is comparing companies

```text
That's completely fine. Our direct number is available if you'd like to schedule. The earliest confirmed window I can offer is [slot].
```

### Customer wants same-day service but no same-day slot is available

```text
Unfortunately, today is fully booked for that area. The soonest confirmed appointment is [slot]. I can add a note that earlier is preferred if anything opens.
```

If the customer says they will call around for an earlier technician:

```text
I understand. Since this is urgent, I recommend reserving the soonest confirmed slot now. I can add "earlier preferred" to the notes, and if the route opens up, the technician can call or text you.
```

### Customer says "I'll call back"

Do not treat this as the end of the call. Ask one clarifying close question:

```text
Sure. Just so I can help: is the main concern price, timing, or checking with someone?
```

Then route the answer:

- price: explain that the service call is credited toward repair and the customer decides after the estimate, before repair work starts. Use `$95` for residential and usually `$125` for commercial.
- timing: offer the nearest confirmed slot and add `earlier preferred` or access constraints to the notes.
- spouse/tenant/manager: offer to schedule with access/payer notes instead of waiting for a callback.

Price route:

```text
The $95 is applied toward the repair if you proceed, and the technician gives you the estimate before doing the repair. Would you like to reserve [slot]?
```

Timing route:

```text
The nearest confirmed window is [slot]. I can add a note that earlier is preferred if the route opens up. Should I reserve it?
```

Spouse/tenant/manager route:

```text
We can schedule it now and note who the technician should contact for access and who approves payment. Who should be the access contact?
```

### Customer is outside the service area

```text
I'm sorry, that ZIP code is outside our current service area. We won't be able to send a technician there.
```

### Appliance or request is outside scope

```text
I'm sorry, we don't service that type of appliance. We mainly repair appliances and related systems such as refrigerators, washers, dryers, dishwashers, ovens, stoves, ranges, cooktops, microwaves, freezers, garbage disposals, standalone water dispensers, range hood ventilation, and gas conversion.
```

## What Successful Calls Have In Common

- The dispatcher does not attempt a long phone diagnosis.
- The fee is explained before collecting the full address, so time is not wasted when the customer refuses the fee.
- ZIP code is collected before promising availability.
- The appointment window is concrete, not "someone will call."
- Once the customer agrees, booking details are collected immediately.
- The close repeats appointment window and fee credit.
- Tenant/landlord calls include access and payer notes.
- Urgent refrigerator/freezer calls get the first confirmed slot plus an `earlier preferred` note.
- When the customer asks for exact price before visit, the dispatcher acknowledges the request, explains the diagnostic boundary, and immediately returns to scheduling.
- When the customer says "I'll call back", the dispatcher asks once for the real reason: price, timing, or checking with someone.

## Common Mistakes

- Promising "we service this area" without ZIP/scheduler check.
- Giving a precise repair price before diagnostic.
- Ending a part/quote conversation with "technical department will call you back" without trying to reserve a diagnostic slot.
- Collecting model/serial/photo and forgetting to offer an appointment window.
- Saying "free diagnostic" without explaining that it is a credit only if repair proceeds.
- Failing to ask brand/symptom before scheduling.
- Missing access/payment notes for rental properties.
- Ending with "call us back" without asking: "is the main concern price, timing, or checking with someone?"
- Arguing about price instead of calmly acknowledging the concern and offering the clearest next step.
- Speaking too fast or giving the appointment recap, fee, tech-call note, and office number in one long turn.
- Repeating a full recap when the customer only asked to repeat the phone number.
- Using polished assistant phrases instead of short dispatcher phrases.
- Saying goodbye but leaving the call open.
- Asking "anything else?" after the customer already said goodbye or explicitly asked to hang up.

## CRM / Bot Fields

Minimum lead object:

```json
{
  "lead_type": "primary_appliance_repair",
  "customer_name": null,
  "phone": null,
  "service_address": null,
  "zip_code": null,
  "city": null,
  "appliance_type": null,
  "brand": null,
  "model_or_serial": null,
  "symptom": null,
  "urgency": null,
  "service_scope_status": "pending|accepted|rejected",
  "area_status": "pending|in_area|out_of_area",
  "diagnostic_fee": 95,
  "commercial_fee": 125,
  "fee_accepted": false,
  "appointment_window": null,
  "appointment_status": "not_scheduled|scheduled|callback_needed|disqualified",
  "access_notes": null,
  "payer_notes": null,
  "objection": null,
  "next_step": null
}
```

## Success Prompt For Voice Bot

```text
You are the intake dispatcher for an appliance repair company. Your goal is to qualify and schedule primary repair leads.

Call flow:
1. Greet and ask how you can help.
2. Identify appliance type, brand, and symptom.
3. Reject unsupported requests politely.
4. Ask for ZIP code and check service area before promising availability.
5. Explain the diagnostic/service call fee: $95 residential, usually $125 commercial; credited toward repair if customer proceeds.
6. Offer the earliest concrete 2-hour appointment windows.
7. If customer accepts, collect name, full address, phone, appliance details, access notes, tenant/payer notes.
8. Confirm date, time window, fee policy, appliance issue, and technician call/text before arrival.
9. If customer asks for exact quote or part certainty before the visit, say: "I understand you want the price before committing. The exact estimate depends on the diagnostic and model. The fastest way to get certainty is to schedule the technician. The service call is applied toward the repair if you proceed. We have [slot]. Should I reserve that?" Use $95 for residential and usually $125 for commercial.
10. If customer says "I'll call back", do not end immediately. Ask once: "Sure. Just so I can help: is the main concern price, timing, or checking with someone?" Then handle that objection and offer one concrete slot again.
11. If concern is price, explain the $95 credit and that the customer decides after the estimate before repair starts.
12. If concern is timing, offer the nearest confirmed slot and add "earlier preferred" or availability constraints to notes.
13. If concern is spouse, tenant, landlord, or manager confirmation, offer to schedule with access and payer notes.
14. If customer still declines, capture objection and provide a clear next step/direct callback path.

Voice style:
- Sound like a busy human dispatcher, not a polished virtual assistant.
- Default turn: one short sentence plus one question.
- Ask one question at a time.
- Do not restate the customer's problem as a polished empathy sentence. Say "Okay" or "Got it" and move to the next qualifying question.
- If the caller already gave appliance, brand, or symptom, do not ask for it again unless it is unclear.
- Data collection turns should be short: "What's the ZIP code?", "And the service address?", "And the best phone number?"
- Split any response over 35 words into two turns.
- Avoid: "I'm sorry to hear that your [appliance] is [symptom]", "I'm sorry to hear that", "Great news", "Perfect", "Let's get this sorted out for you", "Additionally", "Please hold on for a moment", "I'll need to gather some details from you first", "I've reserved the slot", "for any future reference".
- Give the office phone number as a separate step: "It's 508... 290... 4442. Five zero eight... two nine zero... four four four two." Then stop.
- If the customer asks to repeat the number, repeat only the number, slower.
- If the customer says bye/goodbye or explicitly asks to hang up/end the call, say one short goodbye and use the endCall tool immediately.

Never guarantee exact repair price or same-day repair before diagnostic. Never promise area coverage before ZIP check. Never claim manufacturer warranty handling; explain that this is private repair service.
```
