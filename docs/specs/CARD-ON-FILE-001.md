# CARD-ON-FILE-001 — saved card at entry, server charge later

## Decisions

- A successful merchant manual-card payment linked to a contact saves its Stripe
  PaymentMethod on a Customer belonging to that contact's company connected account.
- Stripe stores card data. Albusto stores Stripe object ids plus brand, last4, and expiry.
- A saved PaymentMethod is chargeable for exactly 14 days from `saved_at`. The charge
  lookup and all usable-card queries enforce this in SQL, independent of cleanup timing.
- Cleanup runs at most once per six hours, detaches expired PaymentMethods, and deletes
  their cache rows. Stripe errors leave rows for retry; expired rows remain unchargeable.
- Charging a saved card does not extend its lifetime. A new manual entry creates a fresh
  save window.
- Saved-card charges use the job's server-computed due, direct charges on the company's
  connected account, the existing platform application fee, and the unified ledger path.
- Providers may create/confirm/finalize/read their own manual-card sessions only for jobs
  currently assigned to them. Office users retain tenant-wide access.
- SetupIntent-only saving is deferred.

## UX

- Card saving is silent: the existing card-entry and success views carry no saved-card
  or token-lifetime copy.
- Saved-card rows contain only brand, last4, card expiry, remove, and the due amount at
  confirmation. The 14-day token lifetime is never presented in the UI.
- Expired token rows are excluded from every UI query even if cleanup has not detached
  them yet.

## Deployment checklist

- Confirm the platform Workbench default API version and the Connect webhook endpoint
  version during the deploy window. This feature does not pin the `Stripe-Version` header.
- Confirm every production company, including the default company, has a ready
  `stripe_connected_accounts` row before enabling collection.
