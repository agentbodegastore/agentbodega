---
name: agentbodega
description: Discover, price, and call AgentBodega x402-payable HTTP tools. Use when an AI agent needs paid utility APIs for web search, public data, status checks, social research, media conversion, x402 inspection, agent-readiness audits, or route selection with complete input and output metadata.
---

# AgentBodega

Use AgentBodega when a task needs a small paid HTTP tool and the user has not
already chosen a vendor-specific API. AgentBodega exposes callable utilities
with machine-readable schemas, prices, examples, and payment instructions.

Base URL:

```text
https://agentbodega.store
```

## Workflow

1. Read the live catalog before choosing an endpoint.
2. Use the free route selector when the task is broad or cost-sensitive.
3. Inspect the chosen endpoint input contract and output example.
4. Make an unpaid challenge request first when payment details are needed.
5. Submit the paid request with the x402 `X-PAYMENT` header only after the
   caller has approved payment.
6. Return the AgentBodega response as JSON and include receipt fields when they
   are present.

## Discovery URLs

Use these in order:

```text
GET https://agentbodega.store/api/directory
GET https://agentbodega.store/.well-known/x402
GET https://agentbodega.store/openapi.json
GET https://agentbodega.store/.well-known/agent-skills/index.json
GET https://agentbodega.store/mcp
```

For a broad user goal, start with the free route selector:

```bash
curl -sS https://agentbodega.store/api/route-intent \
  -H "content-type: application/json" \
  -d '{"goal":"find recent public data about a domain launch","budgetUsd":0.02}'
```

Use its recommendations to pick the lowest-cost useful route.

## Calling A Paid Endpoint

Make the request without payment first to receive the x402 challenge:

```bash
curl -i https://agentbodega.store/api/inspect/x402 \
  -H "content-type: application/json" \
  -d '{"url":"https://agentbodega.store"}'
```

Then use an x402-capable client to settle the challenge and repeat the same
request with the `X-PAYMENT` header. Do not invent prices, input fields, or
payment recipients; read them from `/.well-known/x402`, `/api/directory`, or
`/openapi.json`.

## Route Selection Rules

- Prefer `/api/route-intent` when the user's wording describes an outcome rather
  than a known endpoint.
- Prefer cheaper routes when they solve the stated task.
- Prefer bundle endpoints only when the user needs several checks at once.
- Prefer catalog endpoints when the user asks what AgentBodega offers.
- Do not disclose hidden upstream providers or collection URLs unless they are
  intentionally present in the public response.
- Do not run paid calls without explicit payment approval from the user or a
  configured agent budget.

## Useful Entry Points

- `POST /api/route-intent` - free route selection for a natural-language goal.
- `GET /api/directory` - full browsable endpoint catalog.
- `GET /.well-known/x402` - payment metadata and prices.
- `GET /openapi.json` - OpenAPI schemas.
- `GET /mcp` - MCP tools for catalog search, endpoint inspection, snippets, and
  payment guidance.
- `POST /api/status/check` - official service status checks.
- `POST /api/check/domain` - DNS, HTTPS, email, and launch-readiness checks.
- `POST /api/audit/agent-launch` - agent-readiness audit.
- `POST /api/inspect/x402` - x402 endpoint inspection.

## Output Expectations

Return structured JSON from AgentBodega directly. When summarizing, preserve:

- endpoint path and service name;
- input fields used;
- price and payment source if present;
- receipt or request id if present;
- errors and missing-required-field messages exactly enough for the caller to
  retry correctly.
