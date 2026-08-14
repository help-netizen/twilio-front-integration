# INVOICE-REDESIGN-001 — current-state inventory

Status: read-only design-phase inventory. This document maps the implementation that exists on 2026-08-13; it does not prescribe replacement markup, layout, or interaction design.

## Scope and shared behavior

- Operational invoice entry points, their mounted invoice surfaces, and all dialog/overlay descendants found under `frontend/src` are included. The customer payment page, authenticated/public PDF hand-off, estimate-to-invoice bridge, and invoice-specific document-template settings are recorded as adjacent surfaces.
- `/settings/billing` is company subscription billing, not customer invoicing, and is out of scope. Estimate-only dialogs that cannot be reached from an invoice surface are also out of scope.
- Shared `Button` sizes are: default `h-9` (36 px), `sm` `h-8` (32 px), `lg` `h-10` (40 px), and `icon` 36 × 36; call-site dimensions below override these defaults (`frontend/src/components/ui/button.tsx:7-41`).
- Desktop `DialogContent variant="dialog"` is centered; `size="sm"` is `max-w-md`, default is `max-w-lg`, `wide` is `max-w-3xl`, and `full` is `max-w-5xl`. Desktop `variant="panel"` is a right drawer: default/sm use `--blanc-layer-width` (`min(760px, 100vw - 100px)`), wide is `min(1020px, 100vw - 100px)`, and full is `min(1320px, 100vw - 72px)` (`frontend/src/components/ui/dialog.tsx:35-57`, `frontend/src/styles/design-system.css:47-55`).
- On mobile, **both** dialog variants become a rounded-top bottom sheet capped at `100dvh - 16px`, unless `mobileFullScreen` is set. Mobile sheets suppress first-field autofocus, track `visualViewport`, lift above the keyboard, and call `scrollIntoView` when the focused control is covered (`frontend/src/components/ui/dialog.tsx:103-126`, `frontend/src/components/ui/dialog.tsx:218-245`, `frontend/src/hooks/useSheetViewport.ts:101-211`). `mobileFullScreen` instead follows the visible viewport's live top and keyboard bottom (`frontend/src/components/ui/dialog.tsx:80-94`, `frontend/src/hooks/useFullScreenViewport.ts:26-50`).
- `DialogPanelHeader` and `DialogPanelFooter` are `shrink-0`; only `DialogBody` scrolls. The footer has a border, tinted background, and upward shadow (`frontend/src/components/ui/dialog.tsx:335-411`). “Pinned” below means this implementation behavior.
- `FloatingDetailPanel wide` is a nonmodal desktop right drawer sized `--blanc-layer-width-wide` (`min(1320px, 100vw - 72px)`) and an opaque, body-scroll-locked `100vw × 100dvh` cover on mobile; it is not a Dialog or bottom sheet. It supplies a mobile 40 × 40 close button (`frontend/src/components/ui/FloatingDetailPanel.tsx:13-76`, `frontend/src/styles/design-system.css:998-1044`).

## Surface inventory

### 1. InvoicesPage — operational invoice list

- **Purpose / entry:** authenticated `/invoices`, route-gated by `invoices.view`; it is also the landing surface for `/invoices?openId=<id>` after estimate conversion (`frontend/src/App.tsx:148-151`, `frontend/src/pages/InvoicesPage.tsx:51-69`).
- **Container:** ordinary page (`blanc-page-wrapper`), not a Dialog. Header and pagination participate in page layout; the table region is the only `overflow-auto` area (`frontend/src/pages/InvoicesPage.tsx:97-138`, `frontend/src/pages/InvoicesPage.tsx:203-227`).
- **Header / footer:** unified header, not sticky, containing `Invoices`, a raw search input, fixed-width 160 px status Select, and `New Invoice`. No page footer; pagination sits after the table (`frontend/src/pages/InvoicesPage.tsx:99-130`). On mobile the title/search stay on row one and controls wrap to row two (`frontend/src/styles/design-system.css:660-683`).
- **Row:** seven-column table tile: invoice number, `contact_name || title || '-'`, status badge, total, balance, due date, and actions. Clicking anywhere on the row fetches/selects the invoice and opens the detail panel. Rows have white cell backgrounds with 12 px end caps and 8 px inter-row spacing (`frontend/src/pages/InvoicesPage.tsx:148-199`, `frontend/src/styles/design-system.css:822-864`). There is no mobile row/card variant; the table is inside a horizontal-capable `overflow-auto` region.
- **Boxes:** no outer table card. Each table row visually forms a rounded tile through first/last-cell radii; selected cells get an rgba lavender fill. Empty/loading states are unboxed (`frontend/src/pages/InvoicesPage.tsx:137-200`).
- **Buttons/actions:** `New Invoice` is a custom primary chip with a 42 px minimum height in the unified controls; row click opens detail. **Kebab-hidden:** a 28 × 28 icon-only `MoreHorizontal` trigger hides `Edit`, draft-only `Send`, non-void/non-refunded `Void`, and `Delete` (`frontend/src/pages/InvoicesPage.tsx:126-128`, `frontend/src/pages/InvoicesPage.tsx:162-195`, `frontend/src/styles/design-system.css:621-650`). Pagination has icon-only Previous and Next `sm` buttons (32 px high) with no aria-label/title (`frontend/src/pages/InvoicesPage.tsx:203-225`).
- **Inputs / keyboard:** search is a raw borderless text `<input>`; status is a shadcn Select. This is a page, so there is no sheet/full-screen viewport hook or focused-field reveal (`frontend/src/pages/InvoicesPage.tsx:102-125`).
- **Opens:** `InvoiceEditorDialog`, `InvoiceSendDialog`, and `InvoiceDetailPanel` inside `FloatingDetailPanel wide` (`frontend/src/pages/InvoicesPage.tsx:230-269`). `Void` and `Delete` call the APIs directly; no confirmation is inserted.

### 2. JobFinancialsTab — job-context invoice shelf and payment entry point

- **Purpose / entry:** embedded Finance section inside the job detail experience. It lists job invoices, creates an invoice with `defaultJobId`, opens invoice detail, and hosts the job-level card/offline payment flows (`frontend/src/components/jobs/JobFinancialsTab.tsx:195-227`, `frontend/src/components/jobs/JobFinancialsTab.tsx:389-471`).
- **Container / header / footer:** inline section, not its own overlay. The invoice shelf is a `rounded-md border` box with a bordered header. Its surrounding job detail owns scrolling/chrome. No shelf footer (`frontend/src/components/jobs/JobFinancialsTab.tsx:389-439`).
- **Row:** whole-row button showing a 36 px rgba icon tile, invoice number, status, `title || 'Invoice'`, total, and chevron; it opens a wide `FloatingDetailPanel` (`frontend/src/components/jobs/JobFinancialsTab.tsx:410-438`, `frontend/src/components/jobs/JobFinancialsTab.tsx:536-571`).
- **Boxes:** money summary is a rounded/bordered tile group; transaction rows are `rounded-md` rgba boxes; invoice shelf is a rounded/bordered box and each invoice has a rounded rgba icon tile (`frontend/src/components/jobs/JobFinancialsTab.tsx:204-237`, `frontend/src/components/jobs/JobFinancialsTab.tsx:389-439`).
- **Buttons/actions:** `Pay by Card` and `Record Payment` are full-width default buttons (36 px) in the money box; `New invoice` outline `sm` (32 px) in a nonempty shelf; empty-state `Create` `sm` (32 px); invoice row itself is the detail action (`frontend/src/components/jobs/JobFinancialsTab.tsx:215-227`, `frontend/src/components/jobs/JobFinancialsTab.tsx:395-435`). **Kebab-hidden payment actions:** each transaction has a 28 × 28 icon-only menu hiding `Review`, permitted `Refund`, and permitted `Void transaction` (`frontend/src/components/jobs/JobFinancialsTab.tsx:228-280`).
- **Inputs / keyboard:** none on the shelf. Descendant payment/editor surfaces own their keyboard handling.
- **Opens:** `InvoiceEditorDialog`; `InvoiceDetailPanel` in `FloatingDetailPanel wide`; sibling `InvoiceSendDialog`; `CollectPaymentDialog`; `JobRecordPaymentDialog`; job-level `VoidPaymentDialog`; transaction review/refund surfaces (`frontend/src/components/jobs/JobFinancialsTab.tsx:461-629`).

### 3. LeadFinancialsTab — lead-context invoice shelf

- **Purpose / entry:** embedded Financials tab inside lead detail. Lists lead invoices, creates with `defaultLeadId`, and opens detail/send (`frontend/src/components/leads/LeadFinancialsTab.tsx:146-204`).
- **Container / header / footer:** inline section. No outer invoice box or footer; a section label and `New` precede compact rows (`frontend/src/components/leads/LeadFinancialsTab.tsx:146-173`).
- **Row:** whole-row button with invoice number, `title || 'Invoice'`, status badge, and total. It uses `py-1.5 px-2 rounded`; there is no chevron or inline row action (`frontend/src/components/leads/LeadFinancialsTab.tsx:157-172`).
- **Boxes:** rows gain only a rounded hover background. The parent tab still contains separators between estimate/invoice sections (`frontend/src/components/leads/LeadFinancialsTab.tsx:144-173`).
- **Buttons/actions:** `New` is a ghost `sm` button forced to `h-7` (28 px); row click opens detail. No kebab on the invoice row (`frontend/src/components/leads/LeadFinancialsTab.tsx:148-170`).
- **Inputs / keyboard:** none on the shelf.
- **Opens / mount discrepancy:** `InvoiceEditorDialog`; `InvoiceSendDialog`; and **InvoiceDetailPanel inside default centered `DialogContent className="p-0 max-w-96 overflow-hidden"`**, not `FloatingDetailPanel`. Desktop is a narrow 384 px centered modal; mobile becomes the shared bottom sheet. This is the only one of the three live detail mounts with that container (`frontend/src/components/leads/LeadFinancialsTab.tsx:194-204`, `frontend/src/components/leads/LeadFinancialsTab.tsx:269-333`).

### 4. InvoiceEditorDialog — create/edit invoice

- **Purpose / entry:** creates from InvoicesPage, JobFinancialsTab, or LeadFinancialsTab; list-row `Edit` is the only live edit entry. Context props can preset job, lead, contact, estimate, and a context label (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:65-88`; mounts at `frontend/src/pages/InvoicesPage.tsx:231-236`, `frontend/src/components/jobs/JobFinancialsTab.tsx:461-471`, `frontend/src/components/leads/LeadFinancialsTab.tsx:194-204`).
- **Container:** `DialogContent variant="panel" size="full" mobileFullScreen`; desktop right drawer up to `min(1320px, 100vw - 72px)`, mobile edge-to-edge full visible viewport. `modal={!isMobile}` (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:310-314`).
- **Pinned header:** `DialogPanelHeader` with `New invoice` or invoice number, optional default-context caption, and live total (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:314-335`).
- **Pinned footer:** `DialogPanelFooter`; `Cancel` ghost and `Create invoice` / `Save invoice`, both default 36 px (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:590-595`).
- **Body / boxes:** one scrolling `DialogBody`. Boxed regions are: AI generation `rounded-xl` accent-soft block; nested disabled notice `rounded-xl` with accent-soft fill; populated Summary `rounded-2xl border`; empty Summary `rounded-2xl dashed border` with `rgba(25,25,25,.03)` fill; Totals `rounded-2xl` with the same rgba fill; discount `$ / %` toggle `rounded-[10px] border`; Total uses a top border (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:337-410`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:480-566`). Item rows themselves are flat vertical groups; their controls are individually rounded/bordered. Order List is a separate flat section.
- **Buttons/actions:** `Generate` default 36 px inline in AI box; populated-summary collapse row plus icon-only Pencil `sm` (32 px); empty-summary `Add summary` outline `sm` (32 px); per-item icon-only Remove 32 × 32; discount `$` and `%` raw compact toggles (`px-2.5 py-0.5`), icon-only Remove discount 32 × 32, and raw text `Add discount`; `OrderListSection` and the preset picker contribute their actions; footer Cancel/Create/Save are 36 px. No kebab/DropdownMenu (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:341-408`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:419-477`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:487-541`).
- **Inputs:** AI report is a raw textarea; on mobile it is read-only and opens `FullScreenTextEditor`. Each item uses raw `Input` with `CELL_INPUT` for title/quantity, `AutoGrowTextarea` for description, `MoneyInput` for unit price, and Checkbox for taxable. Discount is `MoneyInput` or raw decimal text input; tax is raw `Input` with `inputMode="decimal"`; payment terms is `FloatingSelect`; Order List uses raw inputs (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:59-61`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:355-374`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:419-468`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:515-582`).
- **Keyboard:** main mobile editor uses `mobileFullScreen`/`useFullScreenViewport`; its body is an ordinary scroller and has no call-site autofocus or custom per-field reveal. The report and summary use dedicated full-screen keyboard-aware editors. Desktop uses normal field focus (`frontend/src/components/ui/dialog.tsx:80-126`, `frontend/src/hooks/useFullScreenViewport.ts:26-50`).
- **Reads/writes:** initializes `notes`, `tax_rate`, `discount_amount`, `payment_terms`, `items`, and `order_list`; preserves linked IDs from the invoice or defaults. Save emits `contact_id`, `lead_id`, `job_id`, `estimate_id`, create-only `ai_generation_id`, `notes`, `tax_rate`, computed fixed `discount_amount`, `payment_terms`, items, and serialized `order_list`. It does **not** emit `title`, `internal_note`, `currency`, or `due_date`; due date is derived from the invoice template on create (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:122-143`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:273-301`).
- **Opens:** mobile report `FullScreenTextEditor`; mobile/desktop summary editor; local custom-item Dialog; `ItemPresetSearchCombobox`, whose mobile branch opens `FullScreenSearchPicker` (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:367-374`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:599-700`).

### 5. InvoiceEditor summary editor — second level

- **Purpose / entry:** Pencil/Add summary inside `InvoiceEditorDialog` (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:166-169`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:384-410`).
- **Container:** mobile `FullScreenTextEditor`; desktop nested `DialogContent variant="panel"` at default panel width (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:599-637`).
- **Header/footer:** mobile has the full-screen editor's fixed header and bottom action dock. Desktop has pinned `DialogPanelHeader` with `Summary`, and pinned `DialogPanelFooter` with `Cancel` and `Save summary`, both default 36 px (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:609-636`).
- **Body / boxes / inputs:** no body card; desktop `DialogBody` contains one `FloatingField textarea` (10 rows). Mobile has a flat full-screen textarea. Desktop nested panel uses mobile-sheet viewport behavior only if this branch is somehow rendered under mobile; the actual mobile branch uses visual-viewport keyboard inset. No kebab (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:601-636`).

### 6. InvoiceEditor custom-item dialog — second level

- **Purpose / entry:** `Create new “…”` from the preset picker; local state also supports edit mode, but no existing editor item opens it in the current markup (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:116-120`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:242-269`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:639-700`).
- **Container:** nested `DialogContent variant="panel"`, default desktop panel width; mobile bottom sheet (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:640-642`).
- **Pinned header/footer:** title `Add custom item` / `Edit custom item`; footer `Cancel` and `Save item`, default 36 px (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:642-650`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:693-698`).
- **Body / boxes / inputs:** no rounded body card; `FloatingField` title, description textarea, numeric/decimal quantity and unit price, plus Checkbox. The bottom sheet inherits `useSheetViewport`, autofocus suppression, and focus reveal. No kebab (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:651-690`).
- **Write side effect:** adds the local invoice item. When entered through `Create new`, it also attempts `createEstimateItemPreset` and records usage; failure is swallowed (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:249-267`).

### 7. InvoiceDetailPanel — view, inline edit, and invoice actions

- **Purpose / entry:** opens from an InvoicesPage row, a JobFinancialsTab invoice row, a LeadFinancialsTab invoice row, or the `?openId` bridge. It starts in read-only preview and switches inline to edit (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:99-126`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:182-198`).
- **Container:** the component is only `flex h-full`; its parent determines presentation. InvoicesPage and Job mount it in `FloatingDetailPanel wide`; Lead mounts it in a 384 px centered Dialog (mobile sheet) (`frontend/src/pages/InvoicesPage.tsx:255-269`, `frontend/src/components/jobs/JobFinancialsTab.tsx:536-571`, `frontend/src/components/leads/LeadFinancialsTab.tsx:269-307`).
- **Header:** invoice number/job link, status, contact, balance due, and total are **inside the single body scroller and explicitly not pinned** (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:379-418`). `FloatingDetailPanel` supplies the 40 × 40 mobile close button outside this header.
- **Pinned footer:** custom `shrink-0` bordered/tinted bottom bar outside the scroller. `More` outline `sm` (32 px), `Edit`/`Save` secondary default (36 px), and state-primary `Send` or `Preview PDF` default (36 px) (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:762-805`).
- **Body / boxes:** single scroll surface, main document plus desktop 300 px aside. Read-only Summary and item rows are flat. Edit Summary is `rounded-2xl border`; empty edit Summary is `rounded-2xl dashed border` with rgba fill. Editable items are `rounded-xl border` tiles; loading and no-item notices are rounded/bordered boxes (no-item also amber background). Totals is `rounded-2xl` with rgba fill; its payment-progress track is rounded with rgba fill and Total/Balance rows have top borders. Task cards are rounded/bordered. There is no enclosing main/aside card (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:419-551`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:617-646`).
- **Buttons/actions in document:** invoice number is a link that opens the job in a new tab; Summary collapse is a raw inline button, edit Pencil is 28 × 28, and `Add summary` is outline `sm` (32 px). An editable item tile itself opens edit; it also has 28 × 28 Edit and Remove icon buttons. Preset/group selection adds immediately. Totals has raw `Add Discount` and a 32 × 32 Remove discount. A manual payment in edit mode has a **24 × 24 icon-only Void payment** button. Task actions are listed under TaskStack below (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:423-469`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:472-547`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:558-610`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:687-743`).
- **Footer / kebab actions:** primary is `Send` for a permitted draft, otherwise `Preview PDF`. `Edit`/`Save` remains visible for every nonvoid status. **Kebab-hidden:** `Preview PDF` when it is not primary, `Send`/`Resend` when not primary, `Void`, and `Delete` (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:362-377`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:764-803`).
- **Inputs:** in edit mode, Summary and line-item edits happen in nested dialogs. Inline totals use `MoneyInput` for discount and raw decimal `Input` for tax; due date is native `Input type="date"`. Writes auto-save on blur through `updateInvoice`; explicit Save blurs, waits 150 ms, refetches, and exits edit (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:325-344`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:366-374`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:558-611`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:650-674`).
- **Keyboard:** the wide mobile `FloatingDetailPanel` is fixed full-screen with a body-scroll lock but no `useSheetViewport`/`useFullScreenViewport`; the inner scroller and browser own native date/totals focus. The Lead mount instead inherits mobile sheet lift/reveal from Dialog.
- **Reads / hydration:** consumes virtually the entire `Invoice`, `items`, `events`, plus invoice payments. If a caller passes a list row without `items`, it fetches the full invoice before rendering items (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:127-146`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:173-180`).
- **Opens:** `EstimateSummaryDialog`; shared `EstimateItemDialog`; `ItemPresetSearchCombobox` / mobile full-screen search; `VoidPaymentDialog`; `TaskFormDialog` through TaskStack; parent-owned `InvoiceSendDialog`; authenticated PDF in a new browser tab (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:727-743`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:807-819`).

### 8. InvoiceSendDialog — email/SMS dispatch

- **Purpose / entry:** Send/Resend from detail footer/More, or draft `Send` in InvoicesPage row kebab. Opening mints/reuses a public token, rewrites `/i/` to `/pay/`, and builds a contact-, balance-, due-date-, and operator-aware default message (`frontend/src/components/invoices/InvoiceSendDialog.tsx:51-112`, `frontend/src/components/invoices/InvoiceSendDialog.tsx:116-166`).
- **Container:** default `DialogContent` with `max-w-md`; centered desktop modal, shared bottom sheet on mobile. It is not panel/full-screen (`frontend/src/components/invoices/InvoiceSendDialog.tsx:194-199`).
- **Header/footer:** standard non-panel `DialogHeader` with `Send Invoice`; standard `DialogFooter` with `Cancel` outline and `Send Invoice`, default 36 px. These are not separately pinned from a `DialogBody` (`frontend/src/components/invoices/InvoiceSendDialog.tsx:197-199`, `frontend/src/components/invoices/InvoiceSendDialog.tsx:265-273`).
- **Body / boxes:** no nested rounded/bordered body card; controls sit in a flat `space-y-4` group (`frontend/src/components/invoices/InvoiceSendDialog.tsx:201-263`).
- **Buttons/actions:** Email and SMS segmented as two `sm` Buttons (32 px); native `Include payment link` checkbox; footer Cancel/Send (36 px). No kebab (`frontend/src/components/invoices/InvoiceSendDialog.tsx:203-235`, `frontend/src/components/invoices/InvoiceSendDialog.tsx:265-273`).
- **Inputs / keyboard:** Label + raw shadcn `Input` (`email` or `tel`), Label + raw `Textarea` (5 rows), and native checkbox—not FloatingField/PhoneInput. Mobile inherits sheet autofocus suppression, visual-viewport lift, and focused-field reveal; no call-site autofocus (`frontend/src/components/invoices/InvoiceSendDialog.tsx:225-262`).
- **Writes:** `InvoiceSendData { channel, recipient.trim(), message.trim(), includePaymentLink }`; recipient and message are required client-side (`frontend/src/components/invoices/InvoiceSendDialog.tsx:168-185`).

### 9. Void invoice confirmation — absent surface

- **Current state:** there is **no** confirmation Dialog, AlertDialog, `window.confirm`, reason input, or second step for voiding an invoice. `Void` from the list kebab and detail More menu directly invokes `voidInvoice` (`frontend/src/pages/InvoicesPage.tsx:189-192`, `frontend/src/pages/InvoicesPage.tsx:255-266`, `frontend/src/components/jobs/JobFinancialsTab.tsx:546-552`, `frontend/src/components/leads/LeadFinancialsTab.tsx:280-286`).
- **Container/header/footer/buttons/inputs/nesting:** none. The existing menu item is hidden under a kebab; selecting it is the destructive action.

### 10. Delete invoice confirmation — absent surface

- **Current state:** there is **no** confirmation Dialog, AlertDialog, `window.confirm`, or second step for deleting an invoice. `Delete` from the list/detail kebab directly invokes `deleteInvoice` (`frontend/src/pages/InvoicesPage.tsx:192`, `frontend/src/pages/InvoicesPage.tsx:255-266`, `frontend/src/components/jobs/JobFinancialsTab.tsx:562-568`, `frontend/src/components/leads/LeadFinancialsTab.tsx:296-303`).
- **Container/header/footer/buttons/inputs/nesting:** none. The existing menu item is hidden under a kebab; selecting it is the destructive action.

### 11. EstimateSummaryDialog — shared detail-summary editor

- **Purpose / entry:** edits InvoiceDetailPanel `notes`/Summary; this is distinct from the editor's local summary implementation (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:807-812`).
- **Container:** mobile delegates to `FullScreenTextEditor`; desktop is centered default Dialog with `max-w-xl` (`frontend/src/components/estimates/EstimateSummaryDialog.tsx:25-55`).
- **Header/footer:** desktop standard header `Summary` and standard footer `Cancel` outline / `Save Summary`, default 36 px; not separately pinned. Mobile has fixed full-screen header and keyboard-riding footer (`frontend/src/components/estimates/EstimateSummaryDialog.tsx:40-54`).
- **Body / inputs:** flat raw `Textarea` with 10 rows on desktop; no nested box. Mobile full-screen textarea. No kebab or further dialog (`frontend/src/components/estimates/EstimateSummaryDialog.tsx:41-55`).

### 12. EstimateItemDialog — shared detail line-item editor

- **Purpose / entry:** add/edit a line item from InvoiceDetailPanel (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:813-819`).
- **Container:** `DialogContent variant="panel"`, default panel width; mobile bottom sheet (`frontend/src/components/estimates/EstimateItemDialog.tsx:41-44`).
- **Pinned header/footer:** `Add item` / `Edit item`; footer `Cancel` ghost and `Add item` / `Save changes`, default 36 px (`frontend/src/components/estimates/EstimateItemDialog.tsx:44-52`, `frontend/src/components/estimates/EstimateItemDialog.tsx:99-104`).
- **Body / boxes / inputs:** no inner box. FloatingField title, description textarea, quantity and unit price with decimal keyboard, plus Checkbox. Mobile inherits sheet viewport lift/focus reveal and no autofocus. No kebab/nesting (`frontend/src/components/estimates/EstimateItemDialog.tsx:54-97`).
- **Writes:** `ItemDraft { name, description, quantity, unit_price, taxable }`; InvoiceDetail maps it to add/update item endpoints (`frontend/src/components/estimates/EstimateItemDialog.tsx:7-21`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:276-310`).

### 13. ItemPresetSearchCombobox / FullScreenSearchPicker — price-book chooser

- **Purpose / entry:** inline under Items in InvoiceEditor and editable InvoiceDetail. Searches recent presets or categories; detail additionally supports Price Book groups (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:474-477`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:539-545`).
- **Container:** desktop is a 36 px raw input plus an absolute dropdown (`max-h-80 rounded-xl border shadow`). Mobile is a 36 px trigger opening body-portaled, opaque `FullScreenSearchPicker` (`frontend/src/components/estimates/ItemPresetSearchCombobox.tsx:269-320`).
- **Pinned header/footer on mobile:** shrink-0 header with 36 × 36 close button and no title from this caller; scrollable list; bottom dock with 44 px search field and conditional 28 × 28 Clear. There is no Save action for this caller (`frontend/src/components/shared/FullScreenSearchPicker.tsx:131-196`).
- **Body / boxes:** desktop dropdown is the one rounded/bordered/shadowed box; list rows use rgba selected/highlight backgrounds. Mobile surface itself is flat; search is a rounded field at the bottom (`frontend/src/components/estimates/ItemPresetSearchCombobox.tsx:190-267`, `frontend/src/components/estimates/ItemPresetSearchCombobox.tsx:315-318`).
- **Buttons/actions:** mobile trigger; header Close; breadcrumb buttons; Uncategorized/category navigation; group row (adds all); preset row (adds immediately); `Create new “…”` (opens item dialog); Clear search. Desktop also supports ArrowUp/Down/Enter/Backspace/Escape (`frontend/src/components/estimates/ItemPresetSearchCombobox.tsx:149-188`, `frontend/src/components/estimates/ItemPresetSearchCombobox.tsx:193-265`). No kebab.
- **Inputs / keyboard:** desktop raw text input. Mobile full-screen search defaults `autoFocusSearch=true`, explicitly focuses on mount, tracks both visual viewport top and keyboard inset, traps focus, locks the surface behind it, and docks the input above the keyboard (`frontend/src/components/shared/FullScreenSearchPicker.tsx:56-80`, `frontend/src/components/shared/FullScreenSearchPicker.tsx:98-128`, `frontend/src/components/shared/FullScreenSearchPicker.tsx:151-181`). The ItemPreset comment says “no auto-keyboard,” but it does not pass `autoFocusSearch={false}` (`frontend/src/components/estimates/ItemPresetSearchCombobox.tsx:269-292`).
- **Data:** reads item presets and Price Book category/item/group APIs; preset/group selection maps defaults to invoice items. `Create new` may also write a preset. Preset/category/group reads require `price_book.view`; preset creation requires `price_book.manage` (`frontend/src/services/estimateItemPresetsApi.ts:3-60`, `frontend/src/services/priceBookApi.ts:21-94`, `backend/src/routes/estimate-item-presets.js:34-80`, `backend/src/routes/price-book.js:33-34`).

### 14. OrderListSection — internal parts list inside editor

- **Purpose / entry:** inline in InvoiceEditor; captures parts to order and explicitly says they never appear on the customer copy (`frontend/src/components/estimates/OrderListSection.tsx:4-22`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:568`).
- **Container/header/footer:** flat inline section, no dialog, pinned chrome, or enclosing card.
- **Boxes:** each raw input is a 36 px rounded/bordered transparent field; no row or section box (`frontend/src/components/estimates/OrderListSection.tsx:25-26`, `frontend/src/components/estimates/OrderListSection.tsx:49-90`).
- **Buttons/actions:** 36 × 36 icon-only Remove part per row; `Add part` outline `sm` (32 px). No kebab (`frontend/src/components/estimates/OrderListSection.tsx:78-95`).
- **Inputs / keyboard:** raw part number/name inputs and numeric-keyboard quantity in a fixed `minmax + minmax + 72px + auto` four-column grid; no viewport/focus helper. Serialization silently drops rows without both names and positive quantity, and converts quantity to number (`frontend/src/components/estimates/OrderListSection.tsx:18-22`, `frontend/src/components/estimates/OrderListSection.tsx:52-87`).

### 15. FullScreenTextEditor — mobile report/summary editor

- **Purpose / entry:** InvoiceEditor mobile AI report and summary; EstimateSummaryDialog mobile branch from InvoiceDetail (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:367-374`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:601-608`, `frontend/src/components/estimates/EstimateSummaryDialog.tsx:25-37`).
- **Container:** body-portaled fixed opaque full-screen dialog at z-index 1000, with its bottom ending at the live keyboard inset. It locks/fixes the layer behind it (`frontend/src/components/shared/FullScreenTextEditor.tsx:32-63`, `frontend/src/components/shared/FullScreenTextEditor.tsx:67-83`).
- **Pinned header/footer:** header has a 36 × 36 Close and optional title. Bottom dock has 44 px `Done`; optional 44 px `Re-polish` exists in the primitive but invoice call sites do not supply it (`frontend/src/components/shared/FullScreenTextEditor.tsx:84-101`, `frontend/src/components/shared/FullScreenTextEditor.tsx:133-172`).
- **Body / boxes / input:** flat, borderless full-height textarea; no nested box. It autofocuses unless `busy`, scrolls internally, and uses `useKeyboardInset` so the action dock rides above the keyboard. No kebab or nested surface (`frontend/src/components/shared/FullScreenTextEditor.tsx:103-131`).

### 16. TaskStack / TaskFormDialog / TaskSnoozeMenu — nested invoice tasks

- **Purpose / entry:** InvoiceDetail aside always renders `TaskStack parentType="invoice"`. Users with task create/manage permission can add; assignee or manager can act/edit (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:644-646`, `frontend/src/components/tasks/TaskStack.tsx:25-40`).
- **Inline container / boxes:** each task is a `rounded-xl` bordered surface with rgba badges/avatar; multiple collapsed tasks add two rounded/bordered rgba “peek” layers (`frontend/src/components/tasks/TaskCard.tsx:30-38`, `frontend/src/components/tasks/TaskStack.tsx:70-94`).
- **Inline actions:** `Add task` compact raw button (`4px 10px`); task Edit is a very small icon-only raw button (`p-1`, 14 px icon); `Done`, `Reopen`, and `Snooze` are compact raw buttons (`4px 10px`); `Show N more`/`Show less` is raw full-width text. Snooze opens a 240 px Popover with preset rows, `Pick a date…`, `Back`, and Calendar—not a Dialog. Task action types may add their own buttons (`frontend/src/components/tasks/TaskStack.tsx:52-107`, `frontend/src/components/tasks/TaskCard.tsx:72-145`, `frontend/src/components/tasks/TaskSnoozeMenu.tsx:25-96`). No kebab.
- **TaskForm container:** `DialogContent variant="panel"`, default width / mobile bottom sheet, `modal={!isMobile}`. Pinned header `New task`/`Edit task`; pinned footer has edit-only `Delete`, `Cancel`, and `Add task`/`Save`, all default 36 px. Delete uses browser `window.confirm`, not a nested Albusto dialog (`frontend/src/components/tasks/TaskFormDialog.tsx:103-121`, `frontend/src/components/tasks/TaskFormDialog.tsx:119-185`).
- **TaskForm body / inputs / keyboard:** no inner box; mobile-aware `FloatingTextField` description, `FloatingSelect` assignee, and raw native date/time inputs in FloatingLabel wrappers. On mobile, description is a read-only trigger for a third-level `NoteComposerOverlay`; date/time stay in the sheet and use sheet focus reveal (`frontend/src/components/tasks/TaskFormDialog.tsx:129-170`, `frontend/src/components/shared/FloatingTextField.tsx:33-110`). The composer is a dimmed full-screen portal with a rounded input card docked above the keyboard and a 40 × 40 Done button (`frontend/src/components/shared/NoteComposerOverlay.tsx:70-141`).

### 17. VoidPaymentDialog — payment reversal confirmation

- **Purpose / entry:** 24 px payment icon in InvoiceDetail edit mode, and job transaction kebab for manual payments (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:707-743`, `frontend/src/components/jobs/JobFinancialsTab.tsx:270-276`, `frontend/src/components/jobs/JobFinancialsTab.tsx:624-629`).
- **Container:** `DialogContent variant="dialog" size="sm"`; centered `max-w-md` desktop confirmation, mobile bottom sheet (`frontend/src/components/payments/VoidPaymentDialog.tsx:56-59`).
- **Header/footer:** standard, non-pinned header contains title and caller-specific body copy. Standard footer has `Cancel` ghost and destructive `Void payment`, default 36 px (`frontend/src/components/payments/VoidPaymentDialog.tsx:59-90`).
- **Body / boxes / input:** no inner body box. Required `FloatingField` reason textarea (2 rows, max 500) plus helper text. Mobile inherits sheet viewport/focus handling. No kebab/nesting (`frontend/src/components/payments/VoidPaymentDialog.tsx:20-54`, `frontend/src/components/payments/VoidPaymentDialog.tsx:71-90`).

### 18. CollectPaymentDialog — job-level card/link collection

- **Purpose / entry:** `Pay by Card` from JobFinancialsTab. It explicitly collects an arbitrary job amount with no invoice required, even when invoices exist (`frontend/src/components/jobs/CollectPaymentDialog.tsx:144-165`, `frontend/src/components/jobs/JobFinancialsTab.tsx:215-220`).
- **Container:** `DialogContent variant="panel"`, default desktop panel / mobile bottom sheet (`frontend/src/components/jobs/CollectPaymentDialog.tsx:334-350`).
- **Pinned header/footer:** `Collect payment`; pinned footer contains only `Close` ghost, default 36 px (`frontend/src/components/jobs/CollectPaymentDialog.tsx:338-348`, `frontend/src/components/jobs/CollectPaymentDialog.tsx:515-518`).
- **Body / boxes:** saved-card charge is a full-width `rounded-2xl` accent box; method chooser has three full-width `rounded-2xl border` boxes; send-channel segmented control is a rounded-full filled box. Error group is unboxed (`frontend/src/components/jobs/CollectPaymentDialog.tsx:125-139`, `frontend/src/components/jobs/CollectPaymentDialog.tsx:371-435`, `frontend/src/components/jobs/CollectPaymentDialog.tsx:442-466`).
- **Buttons/actions:** saved-card charge row (`py-4`, large full-width); `Enter a different card` default 36 px; three method rows `Enter card manually`, `Send payment link`, `Copy payment link` (`py-4`); Email/Text raw segmented controls (`py-2`); inline `Back` ghost and `Send link` default buttons; footer `Close`. No kebab (`frontend/src/components/jobs/CollectPaymentDialog.tsx:381-510`).
- **Inputs / keyboard:** amount `FloatingField` with numeric keyboard and cents mask; email `FloatingField`; SMS `PhoneInput`. Mobile inherits sheet viewport lift/autofocus suppression/focus reveal (`frontend/src/components/jobs/CollectPaymentDialog.tsx:350-369`, `frontend/src/components/jobs/CollectPaymentDialog.tsx:468-484`).
- **Writes:** create/copy link `{ amount }`; send link `{ amount, channel, recipient }`; saved-card charge `{ saved_card_id, amount, expected_due, request_key }`; manual entry passes `{ jobId, amount }` to ManualCardDialog (`frontend/src/components/jobs/CollectPaymentDialog.tsx:230-279`, `frontend/src/components/jobs/CollectPaymentDialog.tsx:291-330`, `frontend/src/components/jobs/CollectPaymentDialog.tsx:541-555`).
- **Opens:** saved-card confirmation and `ManualCardDialog`.

### 19. Saved-card charge confirmation — third level

- **Purpose / entry:** saved-card row in CollectPaymentDialog (`frontend/src/components/jobs/CollectPaymentDialog.tsx:281-289`, `frontend/src/components/jobs/CollectPaymentDialog.tsx:371-379`).
- **Container:** centered `DialogContent variant="dialog" size="sm"`; mobile bottom sheet (`frontend/src/components/jobs/CollectPaymentDialog.tsx:521-539`).
- **Header/footer/body:** standard title/description, no body card/input. Footer `Cancel` ghost and `Charge $X.XX`, default 36 px. No pinned panel chrome, kebab, or deeper dialog (`frontend/src/components/jobs/CollectPaymentDialog.tsx:521-538`).

### 20. ManualCardDialog — keyed card workflow host

- **Purpose / entry:** generalized card charge surface accepting either `jobId` or `invoiceId`; the only live mount found is CollectPaymentDialog with `jobId` (`frontend/src/components/invoices/ManualCardDialog.tsx:511-525`, `frontend/src/components/jobs/CollectPaymentDialog.tsx:541-555`).
- **Container:** `DialogContent variant="panel"`, default desktop panel / mobile bottom sheet, `modal={!isMobile}`. Non-success mobile sheet has `min-height:56dvh`; there is no `mobileFullScreen`. Dismiss is blocked during collecting/charging/authenticating/network phases (`frontend/src/components/invoices/ManualCardDialog.tsx:1051-1069`).
- **Pinned header / footer:** pinned `DialogPanelHeader` shows `Charge card`, `Job <id>` or `Invoice`, and amount. **No `DialogPanelFooter`.** Cancel/Pay/Check status and success Done are inside the scrolling DialogBody in an `mt-auto` row (`frontend/src/components/invoices/ManualCardDialog.tsx:1070-1083`, `frontend/src/components/invoices/ManualCardDialog.tsx:1174-1237`).
- **Body / boxes:** `rounded-2xl` security accent box; `rounded-2xl` selected-card or Add-card filled row; `rounded-2xl` collecting, charging, authenticating, declined, and network status boxes (`frontend/src/components/invoices/ManualCardDialog.tsx:1084-1172`).
- **Buttons/actions:** inline `Change` text; full-width rounded `Add card` row; bottom `Cancel` default ghost, `Pay $X` default, or `Check status` default; success `Send receipt` secondary full-width and `Done` default full-width. No kebab (`frontend/src/components/invoices/ManualCardDialog.tsx:1102-1134`, `frontend/src/components/invoices/ManualCardDialog.tsx:1174-1232`; receipt at `frontend/src/components/invoices/ManualCardDialog.tsx:255-297`).
- **Inputs / keyboard:** card details are not entered in this Dialog; Add/Change launches the secure card-entry window. Success email uses `FloatingTextField`; on mobile it opens a third-level `NoteComposerOverlay` with autofocus and a 40 × 40 Send button. The host sheet uses `useSheetViewport`; `modal={!isMobile}` is specifically to avoid trapping focus away from that overlay (`frontend/src/components/invoices/ManualCardDialog.tsx:1056-1060`, `frontend/src/components/shared/FloatingTextField.tsx:33-110`).
- **Data:** creates a manual-card session for job or invoice; consumes `{ session_id, client_secret, payment_intent_id, account_id, amount, save_for_future }`; confirms/finalizes/reconciles; reads `{ status, amount, brand, last4 }`; optionally posts receipt email (`frontend/src/services/stripePaymentsApi.ts:42-57`, `frontend/src/services/stripePaymentsApi.ts:71-149`, `frontend/src/services/stripePaymentsApi.ts:157-183`).

### 21. Secure CardEntryPage — separate top-level card surface

- **Purpose / entry:** opened by ManualCardDialog in a popup or same-window hand-off; card data stays in Stripe-hosted fields (`frontend/src/components/invoices/ManualCardDialog.tsx:591-605`, `frontend/src/card-entry/main.tsx:26-63`).
- **Container:** standalone page, not Dialog. A centered `max-width:420px` shell with rounded corners, surface fill, shadow, and 28 px padding sits on a padded `100dvh` page (`frontend/src/card-entry/card-entry.css:4-18`). No pinned header/footer or mobile-specific alternate layout.
- **Body / boxes:** shell card; rounded accent security box; rounded/fill Stripe card field; rounded/fill ZIP input (`frontend/src/card-entry/card-entry.css:42-67`, `frontend/src/card-entry/card-entry.css:81-108`).
- **Buttons/actions:** `Cancel` and `Add card`, both min-height 42 px; authentication mode keeps Cancel and Stripe verification; expired hand-off shows `Back to job` styled as primary (`frontend/src/card-entry/main.tsx:78-99`, `frontend/src/card-entry/main.tsx:174-193`, `frontend/src/card-entry/card-entry.css:124-152`). No kebab.
- **Inputs / keyboard:** Stripe Card Element plus raw ZIP text input with numeric keyboard/autocomplete. ZIP is programmatically focused after card completion; no visual-viewport/scroll helper (`frontend/src/card-entry/main.tsx:65-71`, `frontend/src/card-entry/main.tsx:119-157`).

### 22. JobRecordPaymentDialog — offline cash/check flow

- **Purpose / entry:** `Record Payment` from JobFinancialsTab; records payment at job level, then offers receipt email (`frontend/src/components/jobs/JobFinancialsTab.tsx:222-225`, `frontend/src/components/jobs/JobFinancialsTab.tsx:615-622`).
- **Container:** `DialogContent variant="panel"`, default desktop panel / mobile bottom sheet, `modal={!isMobile}` (`frontend/src/components/jobs/JobRecordPaymentDialog.tsx:110-113`).
- **Pinned header/footer:** `Record payment`; form footer `Cancel` / `Record payment`; success footer `Done`, all default 36 px (`frontend/src/components/jobs/JobRecordPaymentDialog.tsx:113-123`, `frontend/src/components/jobs/JobRecordPaymentDialog.tsx:204-215`).
- **Body / boxes:** form is flat with no inner box. Success state is a centered flat column, with no success card (`frontend/src/components/jobs/JobRecordPaymentDialog.tsx:125-201`).
- **Buttons/actions:** form Cancel/Record; success full-width `Send receipt` secondary (36 px) and footer Done. No kebab (`frontend/src/components/jobs/JobRecordPaymentDialog.tsx:142-155`, `frontend/src/components/jobs/JobRecordPaymentDialog.tsx:204-214`).
- **Inputs / keyboard:** `FloatingField` masked numeric amount, `FloatingSelect` cash/check, `FloatingField` reference, native date through `FloatingField type="date"`, and FloatingField internal-note textarea. Success email is `FloatingTextField`, so mobile opens the keyboard-docked `NoteComposerOverlay`; the parent bottom sheet freezes while the overlay owns the keyboard (`frontend/src/components/jobs/JobRecordPaymentDialog.tsx:142-199`, `frontend/src/components/shared/FloatingTextField.tsx:33-110`).
- **Writes:** `{ amount:number, payment_method:'cash'|'check', reference_number?, payment_date?, memo? }`, then receipt `{ channel:'email', recipient }` (`frontend/src/components/jobs/JobRecordPaymentDialog.tsx:75-99`).

### 23. PublicInvoicePayPage — customer-facing pay screen (lower priority)

- **Purpose / entry:** unauthenticated `/pay/:token`, reached by InvoiceSendDialog's included payment link (`frontend/src/App.tsx:127-130`, `frontend/src/components/invoices/InvoiceSendDialog.tsx:140-149`).
- **Container:** standalone centered page; a single inline-styled 460 px / `max-width:94vw` card with 24 px radius, border, white fill, and 30 px padding. No Dialog, pinned header/footer, mobile sheet, or viewport hook (`frontend/src/pages/PublicInvoicePayPage.tsx:122-131`).
- **Header/body/boxes:** company label and thank-you title; optional technician row bounded by top/bottom borders; invoice/balance; tip and total; Stripe Payment Element. The outer card is the primary nested box; technician row has borders; tip controls and custom input are individually rounded/bordered (`frontend/src/pages/PublicInvoicePayPage.tsx:139-218`).
- **Buttons/actions:** `$5`, `$10`, `$20`, and `Other` tip buttons (`12px 6px` padding); `Continue to payment` full-width (`13px` padding); pay step raw text `← Change tip`; full-width `Pay $X` (`13px` padding). No kebab (`frontend/src/pages/PublicInvoicePayPage.tsx:160-209`).
- **Inputs / keyboard:** custom tip is raw input with `inputMode="decimal"` and immediate `autoFocus`; card/wallet inputs are Stripe Payment Element. No custom keyboard inset/focused-field reveal (`frontend/src/pages/PublicInvoicePayPage.tsx:179-183`, `frontend/src/pages/PublicInvoicePayPage.tsx:195-208`).
- **Data:** GET returns `invoice_number`, `status`, numeric `balance_due`, `currency`, `paid`, `payable`, `company_name`, `thank_you`, and optional technician name/photo. POST pay-intent sends `{ tip }` and returns Stripe account/client secret; UI confirms Payment Element and transitions to done (`frontend/src/pages/PublicInvoicePayPage.tsx:11-22`, `frontend/src/pages/PublicInvoicePayPage.tsx:54-120`).

### 24. Invoice PDF preview/public PDF — browser document surface

- **Purpose / entry:** `Preview PDF` from InvoiceDetail opens `/api/invoices/:id/pdf` as an authenticated blob in a new tab. InvoiceSend's short `/i/:token` URL redirects to the public PDF endpoint, although its customer message rewrites the URL to `/pay/:token` (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:373-377`, `backend/src/routes/invoices.js:445-461`, `backend/src/routes/public-invoices.js:10`, `backend/src/routes/public-invoices.js:100`).
- **Container/header/footer/buttons/inputs/nesting:** browser-native PDF viewer, not a frontend component; app code does not own its chrome or controls.

### 25. Estimate-to-invoice bridge

- **Purpose / entry:** approved EstimateDetail primary `Create Invoice` calls convert, then navigates to `/invoices?openId=<new id>`; linked estimates can `Open invoice` from the primary or More menu (`frontend/src/components/estimates/EstimateDetailPanel.tsx:283-296`, `frontend/src/components/estimates/EstimateDetailPanel.tsx:339-353`, `frontend/src/components/estimates/EstimateDetailPanel.tsx:734-735`).
- **Container/actions:** not a separate invoice container. `Create Invoice`/`Open invoice` are default footer actions; `Open invoice` can be **kebab-hidden** when it is not primary. No invoice inputs or confirmation.
- **Data/permission:** `POST /api/estimates/:id/convert`, guarded by `invoices.create` (`backend/src/routes/estimates.js:433-434`).

### 26. Invoice template settings — adjacent admin configuration

- **Purpose / entry:** Settings → Document templates row `Invoice`, then `/settings/document-templates/:id`; this config affects generated PDF structure/theme and new-invoice default due days. Both routes are frontend-gated by `tenant.integrations.manage` (`frontend/src/pages/DocumentTemplatesPage.tsx:36-74`, `frontend/src/App.tsx:158-162`, `frontend/src/App.tsx:189-192`).
- **Container/header/footer:** standalone settings/list pages, not Dialogs. List rows are `rounded-xl border` buttons. Editor has Back, `Structure`/`Preview` tabs, a shared document structure/theme builder, and a **fixed bottom bar** with `Reset to default` and `Save` (`frontend/src/pages/DocumentTemplateEditorPage.tsx:117-195`).
- **Invoice-specific box/input/actions:** `Invoice settings` is `rounded-2xl border`; raw number input `default_due_days` (0–365), plus small `Net 7/14/30/60` buttons (`frontend/src/pages/DocumentTemplateEditorPage.tsx:313-375`). Reset uses browser `window.confirm` (`frontend/src/pages/DocumentTemplateEditorPage.tsx:88-103`). The shared builder adds many rounded section/style cards, drag handles, small insert/remove/glue icon actions, and shared brand/theme inputs; these are document-template controls, not operational invoice dialogs (`frontend/src/components/documents/TemplateStructure.tsx:81-280`, `frontend/src/components/documents/TemplateStructure.tsx:283-495`).
- **Data:** `DocumentTemplate.content` preserves `schema_version`, layout/font, brand, theme, sections, footer, and invoice-only `{ default_due_days }`; client list/get/update/reset endpoints are in `documentTemplatesApi` (`frontend/src/types/documentTemplates.ts:62-90`, `frontend/src/services/documentTemplatesApi.ts:16-48`).

## Current nesting map

```text
InvoicesPage / JobFinancialsTab / LeadFinancialsTab
├─ InvoiceEditorDialog
│  ├─ FullScreenTextEditor (mobile report)
│  ├─ editor-local Summary panel OR FullScreenTextEditor
│  ├─ ItemPresetSearchCombobox
│  │  ├─ FullScreenSearchPicker (mobile)
│  │  └─ editor-local custom-item panel
│  └─ OrderListSection (inline)
├─ InvoiceDetailPanel (wide FloatingDetailPanel except Lead's narrow Dialog)
│  ├─ EstimateSummaryDialog → FullScreenTextEditor on mobile
│  ├─ ItemPresetSearchCombobox → FullScreenSearchPicker on mobile
│  ├─ EstimateItemDialog
│  ├─ TaskStack → TaskFormDialog → NoteComposerOverlay on mobile
│  ├─ VoidPaymentDialog
│  └─ parent-owned InvoiceSendDialog
└─ JobFinancialsTab payment branch
   ├─ CollectPaymentDialog
   │  ├─ saved-card confirmation
   │  └─ ManualCardDialog
   │     ├─ CardEntryPage (popup/same-window)
   │     └─ NoteComposerOverlay (mobile receipt email)
   ├─ JobRecordPaymentDialog → NoteComposerOverlay (mobile receipt email)
   └─ VoidPaymentDialog
```

## Key mobile pain points observed in current code

1. **List is still a desktop table.** All seven columns remain in one table with only an overflow scroller; the row action is a 28 px icon-only kebab and four core actions are buried in it (`frontend/src/pages/InvoicesPage.tsx:148-199`).
2. **Actions are kebab-dependent.** Invoice list hides Edit/Send/Void/Delete; detail hides Preview/Send or Resend/Void/Delete; job transactions hide Review/Refund/Void. The detail's `More` label itself is hidden below `sm`, leaving only the icon (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:764-785`).
3. **Several touch targets are below 44 px.** Examples: list kebab 28 px, detail Summary/item actions 28 px, payment Void 24 px, task Edit roughly icon-plus-8 px padding, FullScreen overlay close 36 px, picker Clear 28 px, and most default Buttons 36 px.
4. **Pinned chrome consumes height in the longest forms.** InvoiceEditor is mobile full-screen with pinned header and footer around a long body. Detail deliberately scrolls its header but still pins a footer. Nested panel dialogs add another pinned header/footer layer. CollectPayment also pins header plus a footer containing only Close (`frontend/src/components/invoices/InvoiceEditorDialog.tsx:312-337`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:590-595`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:379-418`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:762-805`).
5. **Mount behavior changes by parent.** The same InvoiceDetailPanel is a wide full-screen mobile cover from Invoices/Job but a bottom sheet mounted through a narrow centered Dialog from Lead. Desktop content goes from up to 1320 px to 384 px (`frontend/src/components/leads/LeadFinancialsTab.tsx:269-307`).
6. **Deep overlay stacks.** Editor → picker → custom item, Detail → task form → keyboard composer, and Collect → ManualCard → card-entry popup/same-window are live second/third-level paths. The shared Dialog code contains special outside-interaction/focus handling specifically to keep nested dialogs from dismissing parents (`frontend/src/components/ui/dialog.tsx:205-216`).
7. **Keyboard handling is fragmented.** Dialog bottom sheets use `useSheetViewport`; the long editor uses `useFullScreenViewport`; detail in FloatingDetailPanel uses neither; long text uses `FullScreenTextEditor`; receipt/task text uses NoteComposerOverlay; public tip and secure card entry rely on browser behavior. The ItemPreset source comment says “no auto-keyboard,” while the actual picker defaults to autofocus.
8. **Order List is a rigid four-column input grid on mobile.** It has no responsive alternate markup and no keyboard/focus helper (`frontend/src/components/estimates/OrderListSection.tsx:49-88`).
9. **ManualCard actions are not a true fixed footer.** They sit at `mt-auto` inside the scrolling `DialogBody`, while the header is pinned (`frontend/src/components/invoices/ManualCardDialog.tsx:1070-1084`, `frontend/src/components/invoices/ManualCardDialog.tsx:1174-1237`).
10. **Destructive invoice actions have no confirmation.** Void and Delete execute directly from a hidden menu. Payment void does have a reasoned confirmation, making the invoice-level behavior notably different.
11. **Box density remains high in edit/payment states.** Editor and detail editing add rounded Summary/Totals/item boxes; payment collection uses rounded saved-card/method/status boxes; task cards add another bordered rounded stack. Read-only detail items/Summary are already flat, but the rest is mixed.
12. **Public pay is responsive only by `maxWidth:94vw`.** It uses a centered desktop-style card, immediate autofocus for custom tip, and no visible-viewport keyboard handling (`frontend/src/pages/PublicInvoicePayPage.tsx:122-131`, `frontend/src/pages/PublicInvoicePayPage.tsx:179-183`).

## Data contract the rebuild must preserve

### Canonical frontend types and hook behavior

- `InvoiceItem`: `id`, `invoice_id`, `sort_order`, `name`, nullable `description`, string `quantity`, nullable `unit`, string `unit_price`, string `amount`, `taxable`, and `metadata` (`frontend/src/services/invoicesApi.ts:13-25`).
- `Invoice`: identifiers/linkage (`id`, `company_id`, `contact_id`, `lead_id`, `job_id`, `estimate_id`); number/status; customer-facing `title`/`notes`; `internal_note`; optional `order_list`; all totals/paid/balance values as strings; optional `job_payment_allocated`; currency/terms/due/sent/paid/void timestamps; audit timestamps/IDs; optional `items`; enriched contact name/email/phone, lead serial, and job number (`frontend/src/services/invoicesApi.ts:27-65`).
- Status union: `draft | sent | viewed | partial | paid | overdue | void | refunded` (`frontend/src/services/invoicesApi.ts:31`).
- `InvoiceEvent`: id, invoice id, event type, actor type/id, metadata, timestamp. `InvoiceRevision`: revision number, snapshot, creator, timestamp (`frontend/src/services/invoicesApi.ts:67-84`).
- `InvoiceCreateData`: linked IDs, optional AI generation ID, title/notes/internal note, tax/discount/currency/terms/due date, items, and order list. `InvoiceSendData`: channel, recipient, optional message, optional include-payment-link. `InvoiceItemCreateData`: name, description, quantity, unit, unit price, taxable, sort order (`frontend/src/services/invoicesApi.ts:104-138`).
- `useInvoices` owns list/filter/selection/event state. Defaults are status/search empty, page 1, limit 50. Selection fetches detail then events sequentially. CRUD/actions toast, reload the list, and replace selected invoice where applicable (`frontend/src/hooks/useInvoices.ts:17-39`, `frontend/src/hooks/useInvoices.ts:42-84`, `frontend/src/hooks/useInvoices.ts:91-146`).

### Per-surface field contract

| Surface | Reads | Writes / actions |
|---|---|---|
| InvoicesPage | `id`, `invoice_number`, `contact_name`, fallback `title`, `status`, `total`, `balance_due`, `due_date`; list `total/page/limit` | filters `status/search/page/limit`; create/update/delete/send/void/select |
| Job invoice shelf | `id`, `invoice_number`, `status`, `title`, `total`; host contact/email/phone and job outstanding | create with `job_id`; open/send/void/delete; job-level payment actions |
| Lead invoice shelf | `id`, `invoice_number`, `status`, `title`, `total` | create with `lead_id`; open/send/void/delete |
| InvoiceEditor | linked IDs, `notes`, `tax_rate`, `discount_amount`, `payment_terms`, `items`, `order_list` | create/update payload detailed in Surface 4; AI draft consumes report/job and returns summary/items/order list/generation ID |
| InvoiceDetail | all Invoice header/totals/timestamps/enrichment, items, events, payments | update `notes`, `tax_rate`, `discount_amount`, `due_date`; item add/bulk/update/delete; send/void/delete; payment void; task mutations |
| InvoiceSend | contact email/phone/name, invoice number, balance/total/due date, current user's name, public link | `{ channel, recipient, message, includePaymentLink }` |
| OrderList | `order_list[]` part number/name/quantity | serialized `order_list[]`, dropping incomplete rows |
| Preset picker | presets/category tree/items/groups and defaults | add item(s), usage event, optional preset create |
| Collect payment | job due, contact email/phone, saved cards/due | link create/send, saved-card charge, keyed-card session |
| Record payment | job outstanding/contact email | cash/check payment payload and optional receipt email |
| Public pay | `PayInfo` listed in Surface 23 | tip amount and Stripe Payment Element confirmation |
| Invoice template | template descriptor and invoice default due days | entire `content` descriptor update/reset |

### Invoice API and permission matrix

All authenticated invoice endpoints use the shared `/api/invoices` client (`frontend/src/services/invoicesApi.ts:148-270`). Backend permission gates are the authoritative contract:

| Frontend operation | HTTP | Backend permission | Current surface(s) |
|---|---|---|---|
| `fetchInvoices` | `GET /api/invoices` | `invoices.view` | list, job/lead financial hooks |
| `fetchInvoice` | `GET /api/invoices/:id` | `invoices.view` | detail hydration |
| `createInvoice` | `POST /api/invoices` | `invoices.create` | editor, estimate conversion service path |
| `updateInvoice` | `PUT /api/invoices/:id` | `invoices.create` | editor, detail inline edit |
| `deleteInvoice` | `DELETE /api/invoices/:id` | `invoices.create` | list/detail kebab |
| `sendInvoice` | `POST /api/invoices/:id/send` | `invoices.send` | Send dialog |
| `voidInvoice` | `POST /api/invoices/:id/void` | `invoices.create` | list/detail kebab |
| `ensureInvoicePublicLink` | `POST /api/invoices/:id/public-link` | `invoices.send` | Send dialog |
| `syncItemsFromEstimate` | `POST /api/invoices/:id/sync-items` | `invoices.create` | client/caller compatibility; no current detail button |
| add/bulk/update/delete item | `/api/invoices/:id/items...` | `invoices.create` | detail item/preset flows |
| events/revisions | `GET .../events`, `GET .../revisions` | `invoices.view` | list/detail events; revisions API currently not rendered |
| payments | `GET /api/invoices/:id/payments` | `payments.view` | detail payment history |
| void invoice payment | `POST /api/invoices/:invoiceId/payments/:paymentId/void` | `payments.collect_offline` | VoidPaymentDialog |
| PDF | `GET /api/invoices/:id/pdf` | `invoices.view` | Preview PDF |

Route evidence: `backend/src/routes/invoices.js:40-79`, `backend/src/routes/invoices.js:112-178`, `backend/src/routes/invoices.js:209-265`, `backend/src/routes/invoices.js:302-398`, `backend/src/routes/invoices.js:425-478`.

### Adjacent permission gates

- InvoicesPage route itself only checks `invoices.view` (`frontend/src/App.tsx:150`). InvoiceDetail currently checks `invoices.send`, `price_book.manage`, and `payments.collect_offline`; `canEdit`/`canVoid` are based only on invoice status, not `invoices.create` (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:182-198`).
- InvoicesPage, JobFinancialsTab, and LeadFinancialsTab do not frontend-gate New/Edit/Void/Delete on `invoices.create`; InvoicesPage draft Send is not frontend-gated on `invoices.send`. Backend still rejects unauthorized calls.
- Item/preset browsing requires `price_book.view`; catalog creation requires `price_book.manage`. Detail checks `price_book.manage` before the catalog write; InvoiceEditor does not and silently swallows a rejected preset create (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:287-307`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:256-266`).
- InvoiceEditor's AI generation calls the estimates AI-draft endpoint, which requires `estimates.create`; the editor does not gate or label the feature by that permission (`frontend/src/services/estimatesApi.ts:207-225`, `backend/src/routes/estimates.js:105-124`).
- Invoice payments list requires `payments.view`; InvoiceDetail fetches it unconditionally and swallows failure. Manual payment void requires `payments.collect_offline` and is correctly hidden without that permission (`frontend/src/components/invoices/InvoiceDetailPanel.tsx:173-180`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:195-198`).
- Job `Pay by Card` is shown when the user has **any** of `payments.collect_online`, `payments.collect_offline`, or `payments.collect_keyed` and Stripe is ready. The actual APIs split permissions: create/send job payment link and saved-card listing/charge use `payments.collect_online`; keyed session/result/confirm/finalize/receipt use `payments.collect_keyed`; offline record uses `payments.collect_offline` (`frontend/src/components/jobs/JobFinancialsTab.tsx:110-123`, `backend/src/routes/jobs.js:1040-1069`, `backend/src/routes/jobs.js:1105-1138`, `backend/src/routes/payments.js:146-203`).
- Task stack: view `tasks.view`; add `tasks.create` or `tasks.manage`; acting is manager or current assignee; typed task actions require `tasks.manage` (`frontend/src/components/tasks/TaskStack.tsx:25-40`, `backend/src/routes/tasks.js:148-204`, `backend/src/routes/tasks.js:249-387`).
- Invoice template list/editor is `tenant.integrations.manage` at the frontend route and runtime API mount (`frontend/src/App.tsx:162`, `frontend/src/App.tsx:191`, `src/server.js:340-342`).

### Payment API contract and current mount status

- `invoiceStripeApi` declares invoice create/get/send link, manual-card-session, and refund helpers (`frontend/src/services/stripePaymentsApi.ts:151-200`). In the current backend invoice router, only `GET /:id/stripe-payment-link` is registered after the regular invoice endpoints (`backend/src/routes/invoices.js:464-483`).
- `ManualCardDialog` supports `invoiceId` in its public props and chooses `invoiceStripeApi` when supplied, but the only JSX mount is job-level CollectPaymentDialog (`frontend/src/components/invoices/ManualCardDialog.tsx:511-525`, `frontend/src/components/jobs/CollectPaymentDialog.tsx:541-555`).
- Job payment links/manual card/saved card are fully wired through `jobStripeApi` (`frontend/src/services/stripePaymentsApi.ts:202-269`). Offline record is `/api/jobs/:id/record-payment`; receipt and payment void use canonical payment APIs.
- `PublicInvoicePayPage` uses unauthenticated token endpoints rather than `invoicesApi`; the token is the credential (`frontend/src/pages/PublicInvoicePayPage.tsx:54-95`).

## Questions / contract risks for design and implementation planning

1. **List-row Edit hydration:** InvoicesPage passes the list-row `Invoice` straight to InvoiceEditor, but list rows commonly have no `items`; the editor initializes missing items to `[]` and saves the full items array. Should the later implementation treat edit as requiring a `fetchInvoice` first? Current detail explicitly hydrates this case, but editor does not (`frontend/src/pages/InvoicesPage.tsx:76-89`, `frontend/src/components/invoices/InvoiceEditorDialog.tsx:122-143`, `frontend/src/components/invoices/InvoiceDetailPanel.tsx:127-146`).
2. **List-row Send prefills:** row kebab sets `sendInvoiceId` from that row, but passes email/phone/name/number/balance/total/due date from `page.selectedInvoice`. If no row is selected—or a different row is selected—the target ID and displayed/default recipient/message data diverge (`frontend/src/pages/InvoicesPage.tsx:91-94`, `frontend/src/pages/InvoicesPage.tsx:238-251`).
3. **Pagination parameter mismatch:** client sends `page`; backend list route reads `offset` and ignores `page`. The hook still reports its local page value, so later pages may repeat backend results (`frontend/src/services/invoicesApi.ts:160-177`, `backend/src/routes/invoices.js:40-69`).
4. **Which permission model should mockups expose?** Current UI shows create/edit/void/delete to `invoices.view` users and lets the backend return 403; Detail only gates Send, price-book catalog writes, and payment void. The rebuild needs an explicit decision about visibility/disabled states without changing the backend permission contract.
5. **Payment collection ownership:** current `Collect payment` and `Record payment` are job-level, not invoice-level; InvoiceDetail only lists and voids payments. ManualCardDialog has dormant `invoiceId` support, while invoice Stripe create/send/manual endpoints are declared in the frontend but not registered in the inspected invoice router. Should invoice redesign mockups include direct invoice collection, or only link to/retain job collection?
6. **Collect button gate:** an offline-only user can satisfy `canCollect` and see `Pay by Card`, but all chooser methods require either online or keyed permission. Is this existing mismatch expected to be represented or corrected during implementation?
7. **Lead mount:** should Claude treat the narrow centered Lead invoice detail as intentional context behavior or an existing inconsistency? It is materially different from the wide drawer used by Invoices and Job.
8. **Invoice void/delete confirmation data:** neither action currently accepts a reason or confirmation payload (`voidInvoice` has no body; delete is plain DELETE). Any new confirmation can confirm the existing call, but collecting new data would require a contract change.
9. **Price Book “Create new” copy:** the picker always says the item “Will be saved to the catalog,” but InvoiceEditor may lack `price_book.manage` and silently continue without saving; detail suppresses catalog save when permission is absent (`frontend/src/components/estimates/ItemPresetSearchCombobox.tsx:260-264`).
10. **Item picker keyboard intent:** source comment says mobile should have “no auto-keyboard,” but the invoked FullScreenSearchPicker defaults to autofocus. Which behavior is the intended baseline for mockups?
11. **Unused ManualCard prop:** Collect passes `jobHasInvoices`, but ManualCardDialog does not destructure or read it (`frontend/src/components/jobs/CollectPaymentDialog.tsx:541-555`, `frontend/src/components/invoices/ManualCardDialog.tsx:592-605`). Confirm whether invoice presence is supposed to alter the collection flow.
12. **Invoice-template scope:** the invoice-specific default due days directly affect InvoiceEditor create behavior, but the template editor is an admin configuration surface shared with estimates/work orders. Confirm whether it belongs in the same redesign mockup set or remains adjacent.
