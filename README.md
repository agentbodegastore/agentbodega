# AgentBodega MCP

[![smithery badge](https://smithery.ai/badge/agentbodega/agentbodega)](https://smithery.ai/servers/agentbodega/agentbodega)

Give agents a live menu of paid, x402-ready tools from
[AgentBodega](https://agentbodega.store).

This MCP server lets agents discover AgentBodega endpoints, compare prices,
inspect required inputs and response formats, and generate ready-to-run x402
HTTP calls. Agents get the buying instructions for each resource without
guessing schemas or scraping docs.

This public repository contains only the AgentBodega MCP package. The hosted
AgentBodega API runs separately at [agentbodega.store](https://agentbodega.store).

## What Agents Can Find

- Social media lookups and research tools.
- Real-estate listing search.
- Service status and cloud status checks.
- Domain, launch-readiness, and agent-discoverability audits.
- x402 inspection, directory packaging, and hosted artifact utilities.

The MCP server does not execute paid calls. It returns the endpoint contract,
example request, payment requirements, and snippets an agent can run against the
hosted API.

## Install

```bash
npx @agentbodega/mcp
```

Remote MCP clients that support Streamable HTTP can connect directly to:

```text
https://agentbodega.store/mcp
```

SSE endpoint:

```text
https://agentbodega.store/mcp/sse
```

Optional environment:

```bash
AGENTBODEGA_BASE_URL=https://agentbodega.store
```

## Network access

This package intentionally uses outbound HTTPS requests at runtime to read
AgentBodega's live catalog, x402 discovery document, and OpenAPI contract. It
does not run install scripts, spawn shells, bundle dependencies, or execute paid
calls. By default it connects to `https://agentbodega.store`.

## Claude Desktop

```json
{
  "mcpServers": {
    "agentbodega": {
      "command": "npx",
      "args": ["-y", "@agentbodega/mcp"]
    }
  }
}
```

## Tools

- `agentbodega_search_catalog` - use first to find the right paid endpoint. It
  searches the live directory by text, department/category/tag, and maximum
  USD price, then returns endpoint summaries with required inputs and example
  requests. It never executes paid calls.
- `agentbodega_get_endpoint` - use after search when you know an endpoint key,
  path, title, or full URL. It returns the full contract: method, URL, price,
  required inputs, schemas, example request, output example, and long
  description. It does not call the endpoint.
- `agentbodega_call_snippet` - use after selecting an endpoint to generate
  ready-to-edit curl and JavaScript requests with an `X-PAYMENT` placeholder
  and x402 verification notes. It does not fetch a challenge, pay, or execute.
- `agentbodega_payment_guide` - use when an agent needs the AgentBodega payment
  model before making paid HTTP calls. It explains x402 discovery, settlement,
  and optional challenge curl.

## Resources

- `agentbodega://catalog` - compact live catalog.
- `agentbodega://x402` - live x402 discovery document.
- `agentbodega://openapi` - live OpenAPI document.

## Development

```bash
npm install
npm test
```
