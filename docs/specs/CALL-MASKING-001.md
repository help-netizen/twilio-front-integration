# CALL-MASKING-001 — Backend call masking

## Decisions

- Contact codes are stable six-digit, zero-padded per-company sequences. The
  database stores the integer value; API/TwiML boundaries render six digits.
- Direct post-dial DTMF and manual IVR entry share one Twilio `<Gather>` action.
- The recording notice is “This call may be recorded.” It is played to the
  provider before `<Dial>` and to the customer through `<Number url>` before
  the parties connect.
- A customer calling the masking number follows the existing company group/IVR
  or voicemail route. Assigned-provider callback routing is deferred.
- Resolver access requires `call_masking.use`; provider record visibility still
  obeys the existing `job_visibility` scope.

## Tenancy & Roles

| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| `GET/PUT /api/telephony/numbers/masking-settings` | `req.companyFilter.company_id` | company id + selected E.164 | `tenant.telephony.manage` | tenant admin ✓; provider ✗ | foreign selected number |
| `GET /api/contacts/:id/call-masking` | `req.companyFilter.company_id` + provider scope | contact id | `call_masking.use` | granted provider/admin ✓; ungranted role ✗ | foreign contact id |
| `GET /api/jobs/:id/call-masking` | `req.companyFilter.company_id` + provider scope | job id + contact id | `call_masking.use` | granted provider/admin ✓; ungranted role ✗ | foreign job/contact id |
| Twilio masking gather/code/screen/dial callbacks | signed `AccountSid` → company, then owned `To` | provider phone + six-digit code | Twilio signature + registered provider | registered provider ✓; other caller follows company IVR | same phone/code in another tenant |
| inbox worker call/recording attribution | signed event `AccountSid` → company | call SID + parent call SID | webhook-only | n/a | same SID in another tenant |

## API response

An enabled resolver returns:

```json
{
  "enabled": true,
  "masking_number": "+16174044425",
  "code": "000001",
  "display_number": "+16174044425",
  "tel_uri": "tel:+16174044425,,000001"
}
```

Disabled or unconfigured masking returns the same shape with `enabled:false`
and the dial fields set to `null`. Foreign or provider-invisible entities are
reported as `404`.
