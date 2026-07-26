-- MARKETPLACE-RATINGS-001: authoritative human-facing app copy and pricing.
--
-- Migration files are replayed idempotently in this project. This high-numbered
-- update MUST run after every older app seed so legacy ON CONFLICT copy cannot
-- win. It preserves every metadata key except metadata.pricing.

WITH app_copy (
    app_key,
    display_name,
    short_description,
    long_description,
    pricing_text
) AS (
    VALUES
        (
            'chatgpt-crm-mcp',
            'Avatars',
            'Give each teammate a personal AI copy that works in Albusto with their own access.',
            'Connect a personal ChatGPT or Claude avatar for any teammate. It reads and acts in your CRM through that person''s exact permissions and record access — never more — and every action is logged as their avatar.',
            'Free while in preview — runs on your own ChatGPT or Claude account.'
        ),
        (
            'lead-generator',
            'Website Leads',
            'Turn your website contact forms into Albusto leads, instantly.',
            'Every enquiry from your website''s contact or booking form lands in Albusto as a new lead within seconds, so nothing slips through and your team can follow up right away.',
            'Free — unlimited website-form lead capture.'
        ),
        (
            'yelp-leads',
            'Yelp Leads',
            'Reply to new Yelp leads in seconds and offer the earliest visit.',
            'When a customer requests a quote on Yelp, Albusto answers within seconds — greets them by name, references their appliance, and proposes the soonest available appointment — while your dispatcher gets a heads-up to call.',
            'Free — auto-replies to unlimited Yelp leads.'
        ),
        (
            'pro-referral-leads',
            'Pro Referral Leads',
            'Bring your Pro Referral jobs into Albusto automatically.',
            'Leads from Pro Referral flow straight into Albusto as new opportunities, auto-greeted and ready for your team — no copy-pasting between tabs.',
            'Free — included with your Albusto plan.'
        ),
        (
            'rely-leads',
            'Rely Leads',
            'Import and auto-answer leads from the Rely network.',
            'Connect your Rely feed and Albusto captures every new lead, greets the customer, and creates a follow-up task for dispatch.',
            'Free — included with your Albusto plan.'
        ),
        (
            'nsa-leads',
            'NSA Leads',
            'Pull your NSA service leads into Albusto automatically.',
            'New leads from your NSA account arrive in Albusto the moment they come in, so your team can respond first.',
            'Free — included with your Albusto plan.'
        ),
        (
            'lhg-leads',
            'LHG Leads',
            'Bring your LHG leads into Albusto automatically.',
            'Leads from your LHG account flow into Albusto as new opportunities, captured and greeted without manual entry.',
            'Free — included with your Albusto plan.'
        ),
        (
            'mail-secretary',
            'Mail Secretary',
            'An AI secretary that reads your inbox and turns it into tasks.',
            'Mail Secretary triages incoming email for you — surfacing what needs a reply, muting the noise, and turning real customer messages into tasks on the right job or lead.',
            'Free — included with your Albusto plan.'
        ),
        (
            'vapi-ai',
            'AI Receptionist',
            'An AI voice agent that answers calls and books jobs after hours.',
            'When your team can''t pick up, the AI receptionist answers the phone, understands what the customer needs, and books the appointment — so after-hours calls become jobs instead of voicemails.',
            'Free — included with your Albusto plan.'
        ),
        (
            'stripe-payments',
            'Stripe Payments',
            'Take card payments and send payouts right from a job.',
            'Charge customers by card on estimates and invoices, see what''s paid at a glance, and receive payouts through Stripe — all without leaving Albusto.',
            'Free to install — standard Stripe processing fees apply.'
        ),
        (
            'smart-slot-engine',
            'Smart Scheduling',
            'Offer the soonest realistic appointment based on where your techs already are.',
            'Smart Scheduling looks at your technicians'' routes and working hours and suggests the nearest available window, so you book the earliest visit that actually fits the day.',
            'Free — included with your Albusto plan.'
        ),
        (
            'google-email',
            'Gmail',
            'Connect Gmail so customer emails sync into their timelines.',
            'Link your Google Workspace mailbox and every email to or from a customer appears on their Albusto timeline, so the whole team sees the full conversation.',
            'Free — connects your existing Google Workspace mailbox.'
        ),
        (
            'telephony-twilio',
            'Phone & Text',
            'Calls, texts and a desktop softphone for your whole team.',
            'Give your business a phone system inside Albusto — make and take calls, send and receive texts, and use the built-in softphone, each tied to the right customer.',
            'Free — you pay Twilio''s per-minute and per-message rates.'
        ),
        (
            'ai-repair-advisor',
            'Repair Advisor',
            'Adds a likely-cause repair note to every new job from your knowledge base.',
            'When a job is created, Repair Advisor pulls the most relevant fix from your knowledge base and drops a concise note on the job, so techs arrive already knowing the likely cause.',
            'Free — included with your Albusto plan.'
        ),
        (
            'outbound-lead-caller',
            'Auto Lead Callback',
            'Calls new leads automatically and connects them to a rep.',
            'The moment a new lead comes in, Albusto places an outbound call, confirms interest, and puts them through to an available rep — so you reach customers while they''re still warm.',
            'Free — included with your Albusto plan.'
        ),
        (
            'outbound-parts-caller',
            'Parts Arrival Caller',
            'Calls the customer automatically when their part arrives.',
            'As soon as an ordered part is marked as arrived, Albusto rings the customer to schedule the return visit — no manual follow-up needed.',
            'Free — included with your Albusto plan.'
        ),
        (
            'inspector',
            'Job Watchdog',
            'A daily check for stuck or aging jobs, turned into follow-ups.',
            'Every day, Job Watchdog reviews jobs that have stalled or slipped and creates follow-up tasks for your team, so nothing quietly falls behind.',
            'Free — included with your Albusto plan.'
        ),
        (
            'call-qa-agent',
            'Call Quality Review',
            'Scores and summarizes your team''s calls for coaching.',
            'Every call gets an automatic summary and a quality score, so you can spot coaching moments and keep customer service consistent.',
            'Free — included with your Albusto plan.'
        ),
        (
            'rate-me',
            'Rate Me',
            'Collect 5-star Google reviews automatically after every job.',
            'After a completed job, Albusto sends the customer a friendly rating page. Happy customers are guided to leave a Google review; unhappy ones reach you privately first.',
            'Free — unlimited review requests.'
        )
)
UPDATE marketplace_apps AS app
SET name = app_copy.display_name,
    short_description = app_copy.short_description,
    long_description = app_copy.long_description,
    metadata = jsonb_set(
        COALESCE(app.metadata, '{}'::jsonb),
        '{pricing}',
        jsonb_build_object(
            'paid', false,
            'label', 'Free',
            'text', app_copy.pricing_text
        ),
        true
    ),
    updated_at = NOW()
FROM app_copy
WHERE app.app_key = app_copy.app_key;
