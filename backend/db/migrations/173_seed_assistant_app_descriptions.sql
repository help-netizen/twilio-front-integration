-- ASSISTANT-BOT-001 — bot-facing app descriptions (metadata.assistant)
--
-- Backfills the SECOND description layer (the marketplace app standard, spec §4a)
-- onto every published marketplace app. The CRM-expert assistant reads
-- metadata.assistant to advise users which apps to connect and how to configure
-- them. Product-level, English, NO company data.
--
-- Idempotent: each UPDATE sets metadata.assistant via jsonb_set (create_missing),
-- preserving all other metadata keys. COALESCE guards a null metadata. Re-running
-- overwrites the assistant block with the same content. No-op on absent app_key.
--
-- GOING FORWARD (standard): a new/changed marketplace app seeds/updates its own
-- metadata.assistant in its OWN migration — this backfill is a one-time catch-up
-- for the 12 pre-standard apps.

-- 1) Website Leads (formerly Lead Generator) --------------------------------
UPDATE marketplace_apps SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{assistant}', '{
  "what_it_does": "Turns orders and form submissions from your own company website into Albusto leads with source attribution.",
  "prerequisites": ["A website with an order or contact form you can wire to an API"],
  "setup_steps": ["Settings → Integrations → Website Leads → Connect", "Copy the issued API key", "Point your website form/backend to POST submissions to the Albusto leads endpoint with that key"],
  "outcome": "Every website enquiry lands in Leads automatically, attributed to your website.",
  "recommend_when": ["User wants to capture leads from their own website", "User asks how online enquiries reach the CRM"],
  "gotchas": ["The website form must actually be wired to the leads API — connecting the app alone does not scrape the site"]
}'::jsonb, true), updated_at = NOW() WHERE app_key = 'lead-generator';

-- 2) Pro Referral Leads -----------------------------------------------------
UPDATE marketplace_apps SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{assistant}', '{
  "what_it_does": "Ingests leads from the Pro Referral network into Albusto with source attribution.",
  "prerequisites": ["An active Pro Referral lead feed for your company"],
  "setup_steps": ["Settings → Integrations → Pro Referral Leads → Connect"],
  "outcome": "Pro Referral leads appear in Leads tagged to that source.",
  "recommend_when": ["User receives leads from Pro Referral and wants them in the CRM"],
  "gotchas": ["Lead intake is driven by the external Pro Referral feed; nothing to poll from the CRM side"]
}'::jsonb, true), updated_at = NOW() WHERE app_key = 'pro-referral-leads';

-- 3) Rely Leads (has per-install settings) ----------------------------------
UPDATE marketplace_apps SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{assistant}', '{
  "what_it_does": "Ingests Rely leads into Albusto and can filter which leads are accepted by service zone, unit type, and brand.",
  "prerequisites": ["An active Rely lead feed for your company"],
  "setup_steps": ["Settings → Integrations → Rely Leads → Connect", "Open the app''s Settings to set the accepted zone (company service area or a custom ZIP list), unit types, and brands"],
  "outcome": "Rely leads flow in; leads outside your configured zone/types/brands are marked Rejected instead of cluttering the pipeline.",
  "recommend_when": ["User gets Rely leads", "User wants to only accept Rely leads in their service area or for certain appliance types/brands"],
  "gotchas": ["Filtering is fail-open: a lead missing zone/type/brand data is accepted, not dropped", "The default zone is the company service area, active from connect"]
}'::jsonb, true), updated_at = NOW() WHERE app_key = 'rely-leads';

-- 4) NSA Leads --------------------------------------------------------------
UPDATE marketplace_apps SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{assistant}', '{
  "what_it_does": "Ingests leads from NSA into Albusto with source attribution.",
  "prerequisites": ["An active NSA lead feed for your company"],
  "setup_steps": ["Settings → Integrations → NSA Leads → Connect"],
  "outcome": "NSA leads appear in Leads tagged to that source.",
  "recommend_when": ["User receives NSA leads and wants them in the CRM"],
  "gotchas": ["Intake is driven by the external NSA feed"]
}'::jsonb, true), updated_at = NOW() WHERE app_key = 'nsa-leads';

-- 5) LHG Leads --------------------------------------------------------------
UPDATE marketplace_apps SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{assistant}', '{
  "what_it_does": "Ingests LHG leads into Albusto with source attribution.",
  "prerequisites": ["An active LHG lead feed for your company"],
  "setup_steps": ["Settings → Integrations → LHG Leads → Connect"],
  "outcome": "LHG leads appear in Leads tagged to that source.",
  "recommend_when": ["User receives LHG leads and wants them in the CRM"],
  "gotchas": ["Intake is driven by the external LHG feed"]
}'::jsonb, true), updated_at = NOW() WHERE app_key = 'lhg-leads';

-- 6) Mail Secretary ---------------------------------------------------------
UPDATE marketplace_apps SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{assistant}', '{
  "what_it_does": "Triages the connected Gmail mailbox and surfaces only emails that need attention, turning them into dispatcher tasks.",
  "prerequisites": ["Google Email must be connected first (Mail Secretary reads that mailbox)"],
  "setup_steps": ["Connect Google Email (Settings → Integrations → Google Email)", "Settings → Integrations → Mail Secretary → Connect", "Optionally tune exclusions so noise (newsletters, no-reply) is muted"],
  "outcome": "The team sees actionable email as tasks instead of scanning a full inbox.",
  "recommend_when": ["User is overwhelmed by email and wants only the important ones flagged", "User wants inbound email to create follow-up tasks"],
  "gotchas": ["Requires a connected Google mailbox — it will not work standalone", "It reads message content for triage but stores references/results, not raw bodies"]
}'::jsonb, true), updated_at = NOW() WHERE app_key = 'mail-secretary';

-- 7) VAPI AI (voice agent) --------------------------------------------------
UPDATE marketplace_apps SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{assistant}', '{
  "what_it_does": "Adds an AI voice agent to inbound call flows — it can greet, take intake, and qualify callers before handing to a human.",
  "prerequisites": ["Telephony (Twilio) connected so there is an inbound number and call flow"],
  "setup_steps": ["Connect Telephony — Twilio", "Settings → Integrations → VAPI AI → Connect", "In the Call Flow Builder, route calls to the VAPI AI node (e.g. after-hours or when dispatchers are busy)"],
  "outcome": "Calls are answered and qualified by an AI agent instead of going to voicemail.",
  "recommend_when": ["User misses calls or wants after-hours coverage", "User wants callers greeted/qualified automatically", "User wants a fallback when dispatchers are busy"],
  "gotchas": ["Needs telephony connected first", "Where the AI sits in the call flow (after-hours, on-busy) is configured in the Call Flow Builder"]
}'::jsonb, true), updated_at = NOW() WHERE app_key = 'vapi-ai';

-- 8) Stripe Payments --------------------------------------------------------
UPDATE marketplace_apps SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{assistant}', '{
  "what_it_does": "Connects the company Stripe account to collect customer payments — invoice payment links, keyed card payments, and Tap to Pay in the field.",
  "prerequisites": ["A Stripe account (or willingness to create one during the connect flow)"],
  "setup_steps": ["Settings → Integrations → Stripe Payments → Connect", "Complete the Stripe onboarding (hosted by Stripe)", "Once connected, send invoice payment links or collect payment from a Job"],
  "outcome": "Customers can pay online or in the field, and every payment reconciles in the unified ledger.",
  "recommend_when": ["User wants to take card payments", "User wants customers to pay invoices online", "User wants Tap to Pay on a phone in the field"],
  "gotchas": ["Test vs live mode — real charges require live mode", "Tenant customer payments are separate from the Albusto subscription billing"]
}'::jsonb, true), updated_at = NOW() WHERE app_key = 'stripe-payments';

-- 9) Smart Slot Engine ------------------------------------------------------
UPDATE marketplace_apps SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{assistant}', '{
  "what_it_does": "Recommends the best arrival time-frame and technician for a new job using travel distance, the existing schedule, and technician base locations.",
  "prerequisites": ["Technician base locations set on the Technicians settings page for accurate routing"],
  "setup_steps": ["Settings → Integrations → Smart Slot Engine → Connect", "Set each technician''s base location (Settings → Technicians)", "Recommendations then appear in the dispatcher when scheduling a new job"],
  "outcome": "Dispatchers get ranked arrival windows and the right technician, cutting drive time.",
  "recommend_when": ["User wants to optimize scheduling and routing", "User asks how to pick the best time/technician for a job"],
  "gotchas": ["Accuracy depends on technician base locations being set", "No credentials to manage — Albusto sends a live snapshot to the engine"]
}'::jsonb, true), updated_at = NOW() WHERE app_key = 'smart-slot-engine';

-- 10) Google Email ----------------------------------------------------------
UPDATE marketplace_apps SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{assistant}', '{
  "what_it_does": "Connects a company Google/Gmail account to send and receive email directly inside Albusto, threaded onto contact timelines.",
  "prerequisites": ["A Google/Gmail account for the company"],
  "setup_steps": ["Settings → Integrations → Google Email → Connect", "Sign in with Google to authorize"],
  "outcome": "Email send is enabled app-wide and incoming replies thread onto the contact timeline.",
  "recommend_when": ["User wants to send/receive email from the CRM", "User wants email history on the contact timeline", "It is a prerequisite for Mail Secretary"],
  "gotchas": ["Connect/disconnect is handled by Google sign-in — there are no credentials to enter"]
}'::jsonb, true), updated_at = NOW() WHERE app_key = 'google-email';

-- 11) Telephony — Twilio ----------------------------------------------------
UPDATE marketplace_apps SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{assistant}', '{
  "what_it_does": "Provides business phone numbers, calls, and texts for the company, powered by Twilio.",
  "prerequisites": [],
  "setup_steps": ["Settings → Integrations → Telephony — Twilio → Connect", "Use the wizard to get a new number or port an existing one", "Configure the call flow (routing, after-hours, autonomous mode)"],
  "outcome": "The company can make/receive calls and SMS in Albusto with a real business number.",
  "recommend_when": ["User needs a business phone number or texting", "User wants inbound calls routed and logged in the CRM", "It unlocks VAPI AI voice agents"],
  "gotchas": ["Autonomous mode forces all inbound to after-hours handling — leave it off unless intended", "Connection is derived from the telephony setup, not a pasted credential"]
}'::jsonb, true), updated_at = NOW() WHERE app_key = 'telephony-twilio';

-- 12) AI Repair Advisor -----------------------------------------------------
UPDATE marketplace_apps SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{assistant}', '{
  "what_it_does": "Auto-drafts a diagnostic starting-point note on every new job from a service-manual knowledge base — probable causes, diagnosis steps, and how to enter the unit''s diagnostic mode.",
  "prerequisites": ["Nothing to configure — runs automatically on new jobs once connected"],
  "setup_steps": ["Settings → Integrations → AI Repair Advisor → Connect"],
  "outcome": "Technicians arrive with a head start: a diagnostic note is appended to each new job automatically.",
  "recommend_when": ["User wants technicians better prepared before a visit", "User asks for diagnostic help on appliance jobs"],
  "gotchas": ["Runs in the background on job creation; reads the reported problem and appliance brand/model only", "Requires the service-manual knowledge base backend to be wired for notes to appear"]
}'::jsonb, true), updated_at = NOW() WHERE app_key = 'ai-repair-advisor';
