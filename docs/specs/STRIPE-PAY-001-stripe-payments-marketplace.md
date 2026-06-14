---
id: STRIPE-PAY-001
title: Stripe Payments Marketplace Integration
product: Albusto FSM
status: Proposed
priority: P0
owner: Product / Payments
created_at: 2026-06-14
target_area:
  - settings.integrations
  - invoices
  - payments
  - transactions
  - mobile.field-service
stripe_api_version: 2026-02-25.clover
integration_type: tenant_customer_payments
marketplace_app_key: stripe-payments
setup_path: /settings/integrations/stripe-payments
primary_users:
  - tenant_admin
  - office_dispatcher
  - field_technician
  - finance_manager
business_goals:
  - Любая tenant-компания может подключить прием платежей Stripe из marketplace Albusto.
  - Компания может принимать платежи по invoice link, ручному вводу карты и NFC Tap to Pay на поддерживаемых телефонах.
  - Все Stripe-платежи попадают в единый canonical payment ledger Albusto.
  - Tenant customer payments отделены от Albusto platform billing.
recommended_stripe_surfaces:
  tenant_onboarding: Stripe Connect Accounts v2
  invoice_payment_link: Checkout Sessions
  manual_card_entry: Payment Element or embedded Checkout backed by Checkout Sessions
  onsite_nfc_payment: Stripe Terminal Tap to Pay
  ledger_sync: Stripe webhooks
recommended_connect_charge_model:
  default: direct_charges
  rationale: tenant-компания является merchant of record; connected account владеет charges, disputes, payouts и основной платежной ответственностью
  decision_required_if_platform_fee_needed: destination_charges_or_application_fees
out_of_scope:
  - Albusto platform subscription billing
  - saved cards and off-session billing
  - recurring customer subscriptions
  - financing
  - accounting system export
  - non-Stripe processors
source_docs:
  - https://docs.stripe.com/connect/accounts-v2
  - https://docs.stripe.com/connect/direct-charges
  - https://docs.stripe.com/payments/checkout
  - https://docs.stripe.com/payments/payment-element
  - https://docs.stripe.com/terminal/payments/setup-reader/tap-to-pay
  - https://docs.stripe.com/terminal/features/connect
  - https://docs.stripe.com/get-started/development-environment
---

# Бизнес-требование: STRIPE-PAY-001 - Stripe Payments Marketplace Integration

## 1. Общее описание

Albusto должен предоставить общее tenant-scoped решение для приема платежей через Stripe. Любая компания, которая пользуется Albusto, должна иметь возможность открыть `/settings/integrations`, выбрать приложение `Stripe Payments`, подключить Stripe merchant account, пройти onboarding и начать принимать платежи от клиентов.

Интеграция должна поддерживать три основных способа приема оплаты:

- прием оплаты на месте через NFC на поддерживаемых телефонах, используемых как Stripe Terminal Tap to Pay reader;
- ручной ввод карты через Stripe-rendered payment form;
- отправка payment link клиенту, включая доступность ссылки из invoice form и public invoice flow.

Это решение относится к платежам tenant-компании от ее клиентов. Оно не должно смешиваться с Stripe Billing, который используется для оплаты подписки Albusto самой tenant-компанией.

## 2. Бизнес-цели

- Ускорить сбор платежей: technician или dispatcher может принять оплату сразу после выполнения работы.
- Снизить количество неоплаченных invoice за счет payment link прямо в invoice flow.
- Сделать подключение Stripe повторяемым self-service процессом для каждой новой компании.
- Сохранить единый финансовый ledger Albusto: все успешные Stripe-платежи должны попадать в `payment_transactions`.
- Минимизировать PCI scope Albusto: карточные данные собираются только через Stripe UI, Stripe SDK или Stripe Terminal SDK.

## 3. Заинтересованные стороны

- Tenant owner/admin: подключает Stripe, проходит onboarding, управляет настройками.
- Office dispatcher: отправляет invoice payment links, может принимать keyed card payment при наличии прав.
- Field technician: принимает оплату на месте через Tap to Pay.
- Finance manager: контролирует payments, refunds, disputes, reconciliation и payout visibility.
- Albusto support/admin: помогает с onboarding и диагностикой статусов без доступа к card data.

## 4. Scope

### 4.1 In scope

- Marketplace app `stripe-payments`.
- Dedicated settings page `/settings/integrations/stripe-payments`.
- Per-tenant Stripe Connect account onboarding.
- Отображение readiness/status для account, capabilities, payouts, Terminal и webhook.
- Invoice payment link creation, copy, send.
- Public invoice `Pay now`.
- Manual card entry through Stripe Payment Element or embedded Checkout.
- Mobile Tap to Pay through Stripe Terminal SDK.
- Stripe webhook ingestion and idempotent ledger sync.
- Отображение Stripe-платежей в invoices, payments и transactions.
- RBAC permissions для setup, online collection, keyed entry, terminal collection и refunds.

### 4.2 Out of scope

- Albusto SaaS/platform subscription billing.
- Saved cards и off-session customer billing.
- Customer recurring subscriptions.
- Non-Stripe processors.
- Financing, loans, BNPL-specific workflows.
- Accounting export в QuickBooks/Xero.
- Сырой ввод card number/CVC в Albusto backend.
- Полная payout reconciliation в P0.

## 5. Текущий контекст продукта

В Albusto уже есть:

- Marketplace infrastructure в `/settings/integrations`.
- Паттерн custom setup page, используемый VAPI AI.
- Invoice detail и invoice send flows.
- Canonical payment ledger `payment_transactions`.
- `/payments` и `/transactions`.
- Архитектурное разделение platform billing и tenant customer payments.

Stripe Payments должен расширять эти поверхности, а не создавать отдельный payment center с другой моделью данных.

## 6. Архитектурное решение Stripe

### 6.1 Connect model

Albusto выступает как Stripe Connect platform. Каждая tenant-компания подключает собственный Stripe connected account.

Рекомендуемое решение для P0:

- использовать Stripe Connect Accounts v2 для новых connected accounts;
- использовать direct charges как базовую модель;
- считать tenant-компанию merchant of record;
- хранить `stripe_account_id` per tenant company;
- обновлять локальный статус через Stripe API и webhooks.

Если Albusto должен брать application fee с каждого customer payment, требуется отдельное решение до реализации funds flow. В этом случае нужно подтвердить charge model: direct charges с application fee, destination charges или другой Connect pattern. В одном payment flow нельзя смешивать разные charge types.

### 6.2 Payment surfaces

Invoice payment links:

- использовать Stripe Checkout Sessions;
- создавать session динамически от текущего invoice balance;
- передавать metadata: `company_id`, `invoice_id`, `job_id`, `contact_id`, `payment_session_id`.

Manual card entry:

- использовать Stripe Payment Element или embedded Checkout;
- не строить собственные card-number fields в Albusto;
- не отправлять PAN/CVC на backend Albusto.

On-site NFC:

- использовать Stripe Terminal Tap to Pay;
- требовать mobile app shell или native/React Native implementation;
- browser-only web app не является достаточной поверхностью для превращения телефона в NFC terminal.

Ledger sync:

- использовать Stripe webhooks для final payment outcomes;
- успешные платежи писать в `payment_transactions` с `external_source = 'stripe'`;
- invoice `amount_paid`, `balance_due`, `status` обновлять через canonical ledger path.

## 7. UX требования

### 7.1 Marketplace card

Path: `/settings/integrations`

Добавить marketplace card:

- Name: `Stripe Payments`
- Provider: `Stripe`
- Category: `payments`
- Description: `Accept invoice payments, keyed card payments, and Tap to Pay in the field.`
- Primary button:
  - `Configure`, если Stripe еще не подключен;
  - `Manage`, если Stripe подключен или требует внимания.
- Status badge:
  - `Available`
  - `Setup incomplete`
  - `Connected`
  - `Action required`
  - `Payouts disabled`
  - `Disconnected`

Карточка не должна открывать generic marketplace enable dialog. Click ведет на `/settings/integrations/stripe-payments`.

### 7.2 Stripe settings page

Path: `/settings/integrations/stripe-payments`

Страница должна показывать setup checklist:

1. Connect Stripe account.
2. Complete business onboarding.
3. Enable payment methods.
4. Configure field payment location/devices.
5. Run a test payment.

Страница должна показывать отдельные readiness states:

- account connected;
- payments capability enabled;
- card payments enabled;
- transfers/payouts enabled;
- requirements due;
- webhook active;
- Terminal/Tap to Pay ready;
- test mode/live mode.

Primary actions:

- `Connect Stripe`
- `Resume onboarding`
- `Open Stripe Dashboard`
- `Enable payment links`
- `Configure Tap to Pay`
- `Run test payment`
- `Disconnect Stripe`

### 7.3 Invoice detail flow

Текущий action `Record payment` должен быть разделен на два разных понятия:

- `Collect payment`
  - `Send payment link`
  - `Copy payment link`
  - `Enter card manually`
  - `Tap to Pay`
- `Record offline payment`
  - `Cash`
  - `Check`
  - `Other`

Invoice detail должен показывать:

- Stripe readiness warning, если прием платежей не подключен;
- active payment link, если он уже создан;
- latest online payment attempt;
- successful linked payments;
- failure reason для последней failed attempt;
- payment history с source/surface.

### 7.4 Invoice send flow

Invoice send dialog должен поддерживать:

- toggle `Include payment link`;
- channel email или SMS;
- editable message body;
- copy/preview payment link;
- warning, если Stripe не подключен или payment collection not ready.

Default behavior:

- если invoice balance больше 0 и Stripe готов, payment link включается по умолчанию;
- если invoice paid или void, link не включается;
- если invoice draft, send behavior следует существующим invoice rules.

### 7.5 Public invoice flow

Public invoice page должен показывать:

- invoice summary;
- balance due;
- `Pay now` CTA, если balance больше 0;
- paid state, если balance равен 0;
- unavailable state, если Stripe disconnected или invoice void.

Click `Pay now` создает или переиспользует валидную Checkout Session для текущего invoice balance и redirect клиента в Stripe.

### 7.6 Field technician Tap to Pay flow

Technician из mobile job/invoice context должен иметь возможность:

1. Нажать `Collect payment`.
2. Выбрать `Tap to Pay`.
3. Проверить amount, invoice/job и customer.
4. Подключить локальный Tap to Pay reader на телефоне.
5. Передать телефон клиенту для contactless card/wallet payment.
6. Увидеть success/failure state.
7. Отправить receipt по SMS/email, если contact data доступна.

Flow должен блокироваться, если:

- Stripe не подключен;
- у пользователя нет permission;
- устройство не поддерживается;
- connected account не имеет нужных capabilities;
- invoice balance равен 0;
- invoice void/refunded.

## 8. Функциональные требования

### FR-001 Marketplace app registration

- Система должна seed-ить `marketplace_apps` с `app_key = 'stripe-payments'`.
- App должен быть published и видим tenant admin в `/settings/integrations`.
- App metadata должен содержать `setup_path = '/settings/integrations/stripe-payments'`.
- Installation должен быть tenant-scoped.
- Disconnect не должен удалять исторические payment records.

### FR-002 Tenant Stripe account connection

- Tenant admin может начать Stripe onboarding из Albusto.
- Backend создает или находит tenant Stripe connected account.
- Backend создает Stripe onboarding/account link или equivalent onboarding session.
- Albusto хранит connected account id и onboarding status.
- Albusto не хранит raw bank account data или card data.
- Albusto обновляет account capabilities и requirements после onboarding return и webhooks.

### FR-003 Setup status and gating

- Online collection заблокирован, пока Stripe account не имеет необходимых payment capabilities.
- UI показывает actionable status, если requirements due или past due.
- Система различает states:
  - not connected;
  - onboarding incomplete;
  - payments disabled;
  - payouts disabled;
  - connected and ready;
  - disconnected.
- Marketplace card status должен соответствовать readiness state.

### FR-004 Invoice payment link creation

- Authorized user может создать payment link для invoice с outstanding balance.
- Link отражает текущий invoice balance, если пользователь явно не выбрал partial amount.
- Система не должна создавать duplicate active sessions для того же invoice/amount, если валидная session уже есть.
- Payment link должен иметь expiration policy.
- Link должен быть доступен в invoice detail и invoice send dialog.

### FR-005 Payment link sending

- Authorized user может отправить invoice payment link по email или SMS.
- Message body редактируется перед отправкой.
- Send event логируется в invoice event/timeline stream.
- Sending должен показать понятную ошибку, если Stripe not ready.

### FR-006 Public invoice payment

- Public invoice page показывает `Pay now` для unpaid invoice.
- Public CTA использует opaque public token и не раскрывает internal ids.
- Если balance изменился, следующая payment session должна отражать новый balance.
- После успешной оплаты клиент возвращается на confirmation page или paid public invoice state.

### FR-007 Manual card entry

- Authorized user может принять card payment вручную из invoice/job/contact context.
- Card entry UI рендерится Stripe Payment Element или embedded Checkout.
- Albusto backend создает payment session/intent и получает только Stripe ids/tokens.
- Manual card payments должны иметь metadata marker для reporting и risk review.
- UI должен показывать note, что keyed/manual entry может иметь другие fees/risk, чем card-present payment.

### FR-008 Tap to Pay collection

- Authorized field user может принять card-present payment через Tap to Pay на поддерживаемом телефоне.
- Mobile app запрашивает Stripe Terminal connection token у Albusto backend.
- Backend scope-ит Terminal actions на tenant connected account.
- Payment связывается с invoice/job/contact, если они доступны.
- Flow поддерживает reader connection, collection, cancellation, failure и retry states.
- Успешный Tap to Pay outcome пишет payment в canonical ledger.

### FR-009 Payment ledger write

- Каждый успешный Stripe payment создает или обновляет canonical `payment_transactions` row.
- Ledger row должен содержать:
  - `company_id`;
  - `contact_id`, если доступен;
  - `invoice_id`, если доступен;
  - `job_id`, если доступен;
  - `transaction_type = 'payment'`;
  - `payment_method = 'credit_card'` или более специфичный разрешенный Stripe method;
  - `status`;
  - `amount`;
  - `currency`;
  - `reference_number`;
  - `external_id`;
  - `external_source = 'stripe'`;
  - `metadata`;
  - `processed_at`.
- Ledger writes должны быть idempotent по Stripe object id и tenant.

### FR-010 Invoice balance update

- Successful payment обновляет invoice `amount_paid`, `balance_due` и `status`.
- Partial payment переводит invoice в partial или equivalent existing status.
- Full payment переводит invoice в paid.
- Refund/void events корректируют paid totals через audited ledger entries.

### FR-011 Webhook processing

- Backend должен иметь Stripe tenant-payments webhook endpoint отдельно от platform billing webhook.
- Endpoint должен использовать raw body и Stripe signature verification.
- Stripe events должны сохраняться и обрабатываться идемпотентно.
- Minimum events:
  - `checkout.session.completed`;
  - `payment_intent.succeeded`;
  - `payment_intent.payment_failed`;
  - `charge.refunded`;
  - `charge.dispute.created`;
  - connected account/capability requirement updates.
- Webhook processing не должен доверять metadata без tenant-scope verification, если нужен direct Stripe API lookup.

### FR-012 Refunds

- Authorized user может инициировать full или partial refund для Stripe payment.
- Refund выполняется через Stripe.
- Refund отражается в `payment_transactions`.
- Invoice paid totals корректируются после успешного refund confirmation.
- UI показывает refunded, partially refunded и disputed states.

### FR-013 Disconnect behavior

- Tenant admin может отключить Stripe Payments из settings.
- Disconnect выключает future collection в Albusto.
- Historical payments и invoice records остаются видимыми.
- Active payment links становятся unavailable или перестают генерироваться.
- Marketplace app status становится disconnected.

### FR-014 Permissions

Добавить или подтвердить permissions:

- `tenant.integrations.manage` - connect/disconnect/manage Stripe.
- `payments.view` - view Stripe payments and payment state.
- `payments.collect_online` - create/send invoice payment links.
- `payments.collect_keyed` - manually enter card payments.
- `payments.collect_terminal` - collect Tap to Pay payments.
- `payments.refund` - issue refunds.
- `reports.payments.view` - view aggregate Stripe payment reporting.

### FR-015 Audit events

Система должна писать audit/domain events для:

- Stripe connected;
- onboarding resumed;
- requirements changed;
- payment link created;
- payment link sent;
- manual card payment started;
- Tap to Pay payment started;
- payment succeeded;
- payment failed;
- refund requested;
- refund succeeded;
- dispute opened;
- Stripe disconnected.

### FR-016 Reporting and filters

Payments и transactions views должны поддерживать filters:

- source: Stripe, Zenbooker, manual/offline;
- payment surface: invoice link, manual card, Tap to Pay;
- status: pending, processing, completed, failed, refunded, disputed, voided;
- invoice/job/contact;
- date range;
- user/technician who initiated collection.

## 9. Data requirements

### 9.1 New or extended tables

Suggested new tables:

- `stripe_connected_accounts`
- `stripe_payment_sessions`
- `stripe_terminal_locations`
- `stripe_webhook_events`

Suggested extensions:

- `payment_transactions.payment_method` может потребовать новые Stripe-specific values или normalization через metadata.
- `marketplace_installations.metadata` может хранить Stripe readiness summary, но не secrets.

### 9.2 stripe_connected_accounts

Required fields:

- `company_id`
- `marketplace_installation_id`
- `stripe_account_id`
- `livemode`
- `charges_enabled`
- `payouts_enabled`
- `details_submitted`
- `requirements_currently_due`
- `requirements_past_due`
- `capabilities`
- `status`
- `created_at`
- `updated_at`

### 9.3 stripe_payment_sessions

Required fields:

- `company_id`
- `invoice_id`
- `job_id`
- `contact_id`
- `created_by`
- `surface`: `checkout_link`, `manual_card`, `tap_to_pay`
- `amount`
- `currency`
- `status`
- `stripe_checkout_session_id`
- `stripe_payment_intent_id`
- `stripe_charge_id`
- `stripe_account_id`
- `url`
- `expires_at`
- `metadata`
- `created_at`
- `updated_at`

### 9.4 stripe_terminal_locations

Required fields:

- `company_id`
- `stripe_account_id`
- `stripe_location_id`
- `display_name`
- `address`
- `status`
- `created_at`
- `updated_at`

### 9.5 stripe_webhook_events

Required fields:

- `stripe_event_id`
- `livemode`
- `event_type`
- `stripe_account_id`
- `company_id`
- `processed_at`
- `processing_status`
- `payload`
- `error`
- `created_at`

## 10. API requirements

### 10.1 Settings and onboarding

- `GET /api/stripe-payments/status`
- `POST /api/stripe-payments/connect`
- `POST /api/stripe-payments/onboarding-link`
- `POST /api/stripe-payments/refresh-status`
- `POST /api/stripe-payments/disconnect`

### 10.2 Invoice payment links

- `POST /api/invoices/:id/stripe-payment-link`
- `GET /api/invoices/:id/stripe-payment-link`
- `POST /api/invoices/:id/send-payment-link`

### 10.3 Manual card entry

- `POST /api/invoices/:id/stripe-manual-card-session`
- `POST /api/jobs/:id/stripe-manual-card-session`

### 10.4 Tap to Pay / Terminal

- `POST /api/stripe-terminal/connection-token`
- `POST /api/invoices/:id/tap-to-pay/payment-intent`
- `POST /api/jobs/:id/tap-to-pay/payment-intent`
- `POST /api/stripe-terminal/payment-intents/:id/cancel`

### 10.5 Webhooks

- `POST /api/stripe-payments/webhook`

Endpoint должен быть mounted before JSON body parsing with raw body access. Он должен быть отдельным от `/api/billing/webhook`.

## 11. UI requirements

### 11.1 Settings page components

- Back link to Integrations.
- Stripe logo/name/status.
- Setup checklist.
- Account capability panel.
- Payment methods panel.
- Tap to Pay locations/devices panel.
- Test mode/live mode indicator.
- Disconnect section.

### 11.2 Invoice components

- Payment readiness banner, если Stripe не подключен.
- `Collect payment` action menu.
- `Record offline payment` action/menu.
- Payment link copy control.
- Latest payment status block.
- Linked payment attempts/history.

### 11.3 Mobile components

- Tap to Pay amount confirmation.
- Reader connection state.
- Present-card state.
- Success receipt action.
- Failure/retry action.

## 12. Non-functional requirements

### 12.1 Security

- Card data собирается только Stripe-controlled UI/SDK surfaces.
- Albusto не логирует и не хранит raw card number, CVC, magnetic stripe data или NFC payload.
- Webhook signatures должны проверяться.
- Stripe object ids должны проходить tenant-scope verification перед ledger mutation.
- Secrets хранятся в environment/secret manager, не в tenant metadata.

### 12.2 Compliance

- Manual card entry должен использовать Stripe-rendered components для минимизации PCI scope.
- UI не должен создавать впечатление, что Albusto хранит карты клиентов.
- Support/admin views не должны показывать payment method details сверх Stripe-safe данных: brand, last4, receipt/reference ids.

### 12.3 Reliability

- Webhook processing must be idempotent.
- Payment initiation must use idempotency keys.
- UI должен терпеть webhook delay и показывать processing state.
- Retry должен быть safe для payment link generation и webhook processing.

### 12.4 Observability

- Логировать lifecycle с request id, company id, invoice/job id и Stripe object ids.
- Alerting для webhook failures, onboarding errors, repeated payment sync failures.
- Metrics: setup completion, payment volume, success rate, failure rate, refund/dispute rate.

## 13. Business rules

- Нельзя принимать платежи по void/refunded invoices.
- Amount не может превышать current balance, если overpayment support отдельно не утвержден.
- Partial payment разрешен, если invoice balance больше 0.
- Payment link использует current balance на момент создания.
- Manual card entry и Tap to Pay требуют явных permissions.
- Disconnect Stripe выключает новые платежи, но не меняет historical ledger.
- Refund не должен удалять original payment record.

## 14. Acceptance criteria

- Tenant admin видит `Stripe Payments` в `/settings/integrations`.
- Tenant admin открывает `/settings/integrations/stripe-payments` и стартует Stripe onboarding.
- Marketplace card отражает setup, connected и action-required states.
- Connected tenant может создать и скопировать invoice payment link.
- Invoice send dialog может включить payment link.
- Public invoice page позволяет оплатить outstanding balance через Stripe.
- Authorized office user может принять manual card payment без обработки raw card data в Albusto.
- Authorized field user может принять Tap to Pay payment на поддерживаемом mobile device.
- Successful Stripe payments отображаются в `/payments` и `/transactions`.
- Successful Stripe payments обновляют invoice paid/balance state.
- Failed payment attempts видимы, но не создают completed ledger payment.
- Stripe webhooks verified and idempotent.
- Disconnect Stripe отключает новые платежи и сохраняет историю.

## 15. Implementation phasing

### Phase 1 - Marketplace and onboarding foundation

- Seed marketplace app.
- Add settings route/page.
- Add connected-account storage.
- Add Connect onboarding and status refresh.
- Add readiness gating.

### Phase 2 - Invoice payment links

- Add Checkout Session creation for invoice balance.
- Add invoice send integration.
- Add public invoice `Pay now`.
- Add webhook success/failure processing into ledger.

### Phase 3 - Manual card entry

- Add manual card payment session from invoice/job.
- Add Stripe-rendered UI surface.
- Add permission gating and audit events.

### Phase 4 - Tap to Pay

- Add mobile Terminal connection token.
- Add Terminal payment intent flow.
- Add mobile Tap to Pay UI.
- Add technician/device readiness checks.

### Phase 5 - Refunds, reporting, hardening

- Add refunds.
- Add dispute visibility.
- Expand filters and reports.
- Add operational alerts and reconciliation views.

## 16. Open decisions

- Будет ли Albusto брать application fee с customer payments?
- Если application fee нужен, какая Connect charge model должна быть утверждена?
- Какая mobile shell будет поддерживать Tap to Pay: native iOS/Android, React Native или существующее Albusto mobile app?
- Нужен ли test-mode setup внутри production Albusto или только в staging/sandbox?
- Overpayments блокируются или записываются как account credit?
- Используем Stripe receipts, Albusto receipts или оба варианта?

## 17. References

- Stripe development environment: https://docs.stripe.com/get-started/development-environment
- Stripe Connect Accounts v2: https://docs.stripe.com/connect/accounts-v2
- Stripe direct charges: https://docs.stripe.com/connect/direct-charges
- Stripe Checkout: https://docs.stripe.com/payments/checkout
- Stripe Checkout Sessions API: https://docs.stripe.com/api/checkout/sessions/create
- Stripe Payment Element: https://docs.stripe.com/payments/payment-element
- Stripe Tap to Pay: https://docs.stripe.com/terminal/payments/setup-reader/tap-to-pay
- Stripe Terminal with Connect: https://docs.stripe.com/terminal/features/connect
