# CRM-SALES-MCP-002: MCP Transports

## Overview

Stage 2 exposes the Sales MCP adapter through public Streamable HTTP-compatible, legacy HTTP+SSE, and local stdio transports.

## Security Model

Public HTTP/SSE routes are mounted without app user auth but are not anonymous. They require:

- `SALES_MCP_PUBLIC_ENABLED=true`
- `Authorization: Bearer <SALES_MCP_PUBLIC_TOKEN>`
- `SALES_MCP_PUBLIC_COMPANY_ID`
- `SALES_MCP_PUBLIC_USER_ID`
- optional `SALES_MCP_PUBLIC_USER_EMAIL`

Public write tools are available only when `SALES_MCP_PUBLIC_WRITE_ENABLED=true`.

stdio requires:

- `SALES_MCP_STDIO_COMPANY_ID`
- `SALES_MCP_STDIO_USER_ID`
- optional `SALES_MCP_STDIO_USER_EMAIL`

stdio write tools are available only when `SALES_MCP_STDIO_WRITE_ENABLED=true`.

## Endpoints

- `POST /mcp/crm` — JSON-RPC MCP endpoint for `initialize`, `ping`, `tools/list`, `tools/call`.
- `GET /mcp/crm/sse` — legacy SSE stream.
- `POST /mcp/crm/messages?session_id=...` — legacy client-to-server message endpoint.

## stdio

`backend/src/cli/crmMcpStdio.js` reads newline-delimited JSON-RPC requests from stdin and writes one JSON-RPC response per line to stdout. Logs go to stderr.

## Supported Methods

- `initialize`
- `notifications/initialized`
- `ping`
- `tools/list`
- `tools/call`

## Out of Scope

- Anonymous public access.
- OAuth handshake.
- Bulk write tools.
- Delete tools.
- New CRM SQL layer.
