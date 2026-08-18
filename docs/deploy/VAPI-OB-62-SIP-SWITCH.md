# OB-62 — переключение SIP ingress на `assistant-request`

Статус: **NO-GO до исправления raw-mount в protected `src/server.js`**. Этот
runbook ничего не меняет сам по себе. Любой `PATCH` Vapi выполняется только в
owner-approved окне.

## Константы окна

- SIP resource: `d446b324-f016-48ba-b536-78c61652184d`
- статический rollback assistant: `30e85a87-9d7e-4694-828e-1fea7d10f3ef`
- dynamic endpoint:
  `https://api.albusto.com/api/vapi/call-status/assistant-request`
- операторский helper: `scripts/vapi-ob62-sip-switch.js`; `switch` и `rollback`
  являются dry-run без `--apply`. Секрет не печатается.

## Обязательный code precondition

`src/server.js` сейчас монтирует `/api/vapi/call-status` после глобального
`express.json()`. Это противоречит комментарию в
`backend/src/routes/vapiCallStatus.js`: точные provider bytes уже потеряны, поэтому
EoC пишет `exact usage body unavailable` и не создаёт observation.

До окна protected mount должен быть перенесён **до** глобального JSON parser и
должен передавать Buffer существующему router:

```js
const vapiCallStatusRouter = require('../backend/src/routes/vapiCallStatus');
app.use(
    '/api/vapi/call-status',
    express.raw({ type: '*/*', limit: '2mb' }),
    vapiCallStatusRouter,
);
```

Поздний mount тех же path/router удаляется. `parseRawVapiJson` внутри router
преобразует Buffer в `req.body`, сохраняя `req.vapiRawJson` для денежного parser.
Без этого изменения переключение не выполняет денежную цель OB-62.

## До окна

На prod host:

```bash
cd /opt/albusto
docker compose exec -T app node scripts/vapi-ob62-sip-switch.js inspect
docker compose exec -T app node -e "const r=require('./backend/src/routes/vapiAssistantRequest'); console.log(r.ASSISTANT_REQUEST_PROBE_VARIABLES)"
docker compose exec -T postgres psql -X -U albusto -d albusto -v ON_ERROR_STOP=1 -c "SELECT r.company_id,r.id AS resource_id,r.vapi_phone_number_id,r.sip_uri,r.status AS resource_status,r.is_active,p.id AS profile_id,p.vapi_assistant_id,p.status AS profile_status,p.is_active AS profile_active,ar.id AS assistant_request_credential_id,ar.revoked_at AS assistant_request_revoked_at,ar.expires_at AS assistant_request_expires_at,ar.scopes,cs.id AS call_status_credential_id,cs.revoked_at AS call_status_revoked_at,cs.expires_at AS call_status_expires_at FROM vapi_tenant_resources r JOIN vapi_assistant_profiles p ON p.id=r.assistant_profile_id AND p.company_id=r.company_id JOIN api_integrations ar ON ar.id=r.server_credential_id AND ar.company_id=r.company_id LEFT JOIN api_integrations cs ON cs.id=p.call_status_credential_id AND cs.company_id=p.company_id WHERE r.vapi_phone_number_id='d446b324-f016-48ba-b536-78c61652184d';"
```

Ожидается ровно одна строка: resource/profile active, assistant id равен rollback
assistant, assistant-request credential не отозван/не истёк и имеет
`vapi_assistant_request:invoke`; call-status credential аналогично готов. `inspect`
должен показать текущий static assistant и пустой `serverUrl`.

Получить plaintext `vapi_assistant_request` secret из операционного secret store.
В БД его восстановить нельзя. Не помещать значение в историю shell:

```bash
read -rsp 'vapi_assistant_request secret: ' VAPI_ASSISTANT_REQUEST_SECRET
export VAPI_ASSISTANT_REQUEST_SECRET
printf '\n'
docker compose exec -T -e VAPI_ASSISTANT_REQUEST_SECRET app node scripts/vapi-ob62-sip-switch.js switch
```

Dry-run обязан показать `assistantId:null`, правильный URL, timeout 20 и
`secret:"<redacted>"`; provider при dry-run не вызывается.

До изменения открыть второй терминал для логов:

```bash
cd /opt/albusto
docker compose logs --since 2m -f app
```

## Переключение

В первом терминале:

```bash
docker compose exec -T -e VAPI_ASSISTANT_REQUEST_SECRET app node scripts/vapi-ob62-sip-switch.js switch --apply
```

Helper делает GET → PATCH → GET и завершится успешно только если readback содержит:

- `assistantId:null`;
- точный `server.url`;
- `server.timeoutSeconds:20`;
- `isServerUrlSecretSet:true` (secret write-only, его отсутствие в GET нормально).

Сразу после успешного readback владелец делает один входящий звонок. В логах до
первой реплики должен появиться:

```text
POST /api/vapi/call-status/assistant-request
[vapiAssistantRequest] bound { companyId, providerCallId, sessionId, idempotent }
```

Повтор delivery с тем же call id допустим и должен иметь `idempotent:true`. Во
время/после звонка ожидаются `status-update`, затем `end-of-call-report`.

Сразу после строки `bound` проверить идентичность:

```bash
docker compose exec -T postgres psql -X -U albusto -d albusto -v ON_ERROR_STOP=1 -c "SELECT id,company_id,vapi_call_id,state,bind_source,bound_at,twilio_parent_call_sid FROM vapi_call_sessions WHERE direction='inbound' AND created_at>now()-interval '10 minutes' ORDER BY created_at DESC LIMIT 5;"
```

После EoC проверить provisional cost:

```bash
docker compose exec -T postgres psql -X -U albusto -d albusto -v ON_ERROR_STOP=1 -c "SELECT s.vapi_call_id,s.state AS session_state,o.id AS observation_id,o.validation_state,o.supplier_cost::text,u.state AS usage_state,u.supplier_cost::text AS projected_cost,u.next_reconcile_at FROM vapi_call_sessions s LEFT JOIN vapi_call_usage_observations o ON o.vapi_call_session_id=s.id AND o.company_id=s.company_id LEFT JOIN vapi_call_usage u ON u.vapi_call_session_id=s.id AND u.company_id=s.company_id WHERE s.direction='inbound' AND s.created_at>now()-interval '10 minutes' ORDER BY s.created_at DESC,o.observed_at DESC LIMIT 10;"
```

Не должно быть свежего `provider_orphan`, `quarantined`, `assistant_mismatch` или
`provider_call_collision` для call id окна:

```bash
docker compose exec -T postgres psql -X -U albusto -d albusto -v ON_ERROR_STOP=1 -c "SELECT kind,provider_call_id,details,created_at FROM vapi_usage_alerts WHERE created_at>now()-interval '10 minutes' ORDER BY created_at DESC;"
```

## T1 probe в том же звонке

Handler возвращает только server-owned безопасный probe:

```json
{
  "assistantId": "30e85a87-9d7e-4694-828e-1fea7d10f3ef",
  "assistantOverrides": {
    "variableValues": {
      "albusto_context_contract": "assistant-request-probe/v1",
      "albusto_context_status": "generic",
      "albusto_ob62_probe": "sip-assistant-request-v1"
    }
  }
}
```

После получения `vapi_call_id` прочитать call и вывести только безопасные поля:

```bash
read -rp 'Vapi call id: ' VAPI_OB62_CALL_ID
docker compose exec -T -e VAPI_OB62_CALL_ID app node -e "(async()=>{const id=process.env.VAPI_OB62_CALL_ID;const r=await fetch('https://api.vapi.ai/call/'+encodeURIComponent(id),{headers:{Authorization:'Bearer '+process.env.VAPI_API_KEY}});if(!r.ok)throw new Error('GET_CALL_HTTP_'+r.status);const c=await r.json();console.log({id:c.id,assistantId:c.assistantId,assistantOverrides:c.assistantOverrides&&{variableValues:c.assistantOverrides.variableValues}})})().catch(e=>{console.error(e.message);process.exit(1)})"
```

Точное наличие трёх значений в call object доказывает, что override был принят и
прикреплён к входящему SIP call. Поскольку текущий prompt Sara не ссылается на
`albusto_ob62_probe`, этот звонок **не доказывает поведенческое Liquid-rendering**.
Для полного T1 нужен отдельный owner-approved marker/ветка в prompt либо иной
наблюдаемый эффект; этот runbook prompt не меняет.

## Success и немедленный rollback

Успех OB-62 — одновременно:

1. владелец без необычной паузы слышит обычного Sara и разговор продолжается;
2. authenticated assistant-request даёт `bound`, а session получает тот же
   `vapi_call_id`, что provider call;
3. EoC создаёт accepted observation и provisional usage с ненулевым supplier cost;
4. свежих identity/cost quarantine alerts для call id нет;
5. GET call показывает выбранного Sara и probe `variableValues` (transport proof T1).

Откатываться сразу, не дожидаясь конца окна, если: owner слышит тишину/отбой/voice
mail вместо Sara; endpoint возвращает 4xx/5xx; нет `bound` до первой реплики;
выбран не Sara; helper readback не совпал; bind ушёл в unattributed/quarantine. Если
разговор прошёл, но EoC не создал observation/usage, цель денег также не достигнута:
откатить и исправить raw-mount/status credential.

Откат с ноутбука — одна команда, секрет assistant-request не нужен:

```bash
ssh deploy@108.61.87.117 'cd /opt/albusto && docker compose exec -T app node scripts/vapi-ob62-sip-switch.js rollback --apply'
```

Команда восстанавливает static assistant, отправляет `server:null`, перечитывает
resource и требует точный assistant id плюс отсутствие `server.url`. После неё:

```bash
ssh deploy@108.61.87.117 'cd /opt/albusto && docker compose exec -T app node scripts/vapi-ob62-sip-switch.js inspect'
```
