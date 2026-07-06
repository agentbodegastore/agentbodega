#!/usr/bin/env node

const VERSION = "0.1.7";
const DEFAULT_BASE_URL = "https://agentbodega.store";
const INSTRUCTIONS =
  "Use this server to discover AgentBodega offerings, inspect accepted inputs and examples, and generate HTTP/x402 call snippets. Do not use it to execute paid calls directly.";

type JsonObject = Record<string, unknown>;

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type DirectoryEndpoint = {
  key?: string;
  title?: string;
  method?: string;
  url?: string;
  price?: { currency?: string; amount?: string };
  description?: string;
  longDescription?: string;
  category?: string;
  department?: string;
  kind?: string;
  tags?: string[];
  inputSchema?: JsonObject;
  inputContract?: JsonObject;
  exampleRequest?: unknown;
  outputSchema?: JsonObject;
  outputExample?: unknown;
  balanceModel?: JsonObject;
  paymentSurfaces?: JsonObject;
};

type Directory = {
  name?: string;
  description?: string;
  directory?: string;
  openapi?: string;
  x402?: string;
  l402?: string;
  llmsTxt?: string;
  settlement?: JsonObject;
  endpoints?: DirectoryEndpoint[];
};

class RpcError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function baseUrl(): string {
  const raw = process.env.AGENTBODEGA_BASE_URL || DEFAULT_BASE_URL;
  try {
    const parsed = new URL(raw);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_BASE_URL;
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `${baseUrl()}${path}`;
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": `agentbodega-mcp/${VERSION}`
    }
  });
  if (!response.ok) {
    throw new Error(`AgentBodega request failed: ${response.status} ${response.statusText} for ${url}`);
  }
  return (await response.json()) as T;
}

async function postJson<T>(path: string, body: JsonObject): Promise<T> {
  const url = path.startsWith("http") ? path : `${baseUrl()}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": `agentbodega-mcp/${VERSION}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`AgentBodega request failed: ${response.status} ${response.statusText} for ${url}`);
  }
  return (await response.json()) as T;
}

async function directory(): Promise<Directory> {
  const json = await fetchJson<Directory>("/api/directory");
  return { ...json, endpoints: Array.isArray(json.endpoints) ? json.endpoints : [] };
}

function endpointText(endpoint: DirectoryEndpoint): string {
  return [
    endpoint.key,
    endpoint.title,
    endpoint.description,
    endpoint.longDescription,
    endpoint.category,
    endpoint.department,
    endpoint.kind,
    endpoint.url,
    ...(endpoint.tags || [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function matches(endpoint: DirectoryEndpoint, query: string, department: string, maxPriceUsd?: number): boolean {
  if (query && !endpointText(endpoint).includes(query.toLowerCase())) return false;
  if (department) {
    const category = String(endpoint.category || endpoint.department || "").toLowerCase();
    const tags = (endpoint.tags || []).map((tag) => tag.toLowerCase());
    if (category !== department.toLowerCase() && !tags.includes(department.toLowerCase())) return false;
  }
  if (typeof maxPriceUsd === "number") {
    const amount = Number(endpoint.price?.amount ?? "0");
    if (Number.isFinite(amount) && amount > maxPriceUsd) return false;
  }
  return true;
}

function compactEndpoint(endpoint: DirectoryEndpoint): JsonObject {
  return {
    key: endpoint.key,
    title: endpoint.title,
    method: endpoint.method,
    url: endpoint.url,
    price: endpoint.price,
    balanceModel: endpoint.balanceModel,
    paymentSurfaces: endpoint.paymentSurfaces,
    category: endpoint.category || endpoint.department,
    tags: endpoint.tags || [],
    description: endpoint.description,
    requiredInputs: Array.isArray(endpoint.inputContract?.required) ? endpoint.inputContract.required : undefined,
    exampleRequest: endpoint.exampleRequest
  };
}

function safePathname(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return undefined;
  }
}

function findEndpoint(endpoints: DirectoryEndpoint[], identifier: string): DirectoryEndpoint | undefined {
  const needle = identifier.trim().toLowerCase();
  return endpoints.find((endpoint) => {
    const candidates = [
      endpoint.key,
      endpoint.title,
      endpoint.url,
      endpoint.url ? safePathname(endpoint.url) : undefined
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    return candidates.includes(needle);
  });
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toolJson(value: unknown): JsonObject {
  return { content: [{ type: "text", text: jsonText(value) }] };
}

function argObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringArg(args: JsonObject, name: string, fallback = ""): string {
  return typeof args[name] === "string" ? args[name] : fallback;
}

function booleanArg(args: JsonObject, name: string, fallback: boolean): boolean {
  return typeof args[name] === "boolean" ? args[name] : fallback;
}

function numberArg(args: JsonObject, name: string): number | undefined {
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function positiveIntegerArg(args: JsonObject, name: string, fallback: number, min: number, max: number): number {
  const value = numberArg(args, name);
  if (typeof value !== "number") return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function requiredString(args: JsonObject, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new RpcError(-32602, `Missing required string argument: ${name}`);
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function snippets(endpoint: DirectoryEndpoint): JsonObject {
  const method = endpoint.method || "POST";
  const bodyJson = jsonText(endpoint.exampleRequest ?? {});
  const curl =
    `curl -sS -X ${method} ${shellQuote(String(endpoint.url || ""))} \\\n` +
    "  -H 'content-type: application/json' \\\n" +
    "  -H 'X-PAYMENT: <base64url x402 payment payload>' \\\n" +
    `  -d ${shellQuote(bodyJson)}`;
  const javascript = `const response = await fetch(${JSON.stringify(endpoint.url)}, {
  method: ${JSON.stringify(method)},
  headers: {
    "content-type": "application/json",
    "x-payment": "<base64url x402 payment payload>"
  },
  body: JSON.stringify(${bodyJson})
});
const data = await response.json();`;

  return {
    endpoint: compactEndpoint(endpoint),
    payment: {
      mode: "x402",
      surfaces: endpoint.paymentSurfaces,
      balanceModel: endpoint.balanceModel || { mode: "per_call_x402", sourceOfTruth: "blockchain_settlement" },
      note: "Fetch the live 402 challenge from this endpoint before paying. Verify price, network, asset, and payTo in the challenge."
    },
    curl,
    javascript
  };
}

const toolDefinitions = [
  {
    name: "agentbodega_plan_task",
    title: "Plan Cheapest AgentBodega Route",
    description:
      "Use this before search_catalog when you have a plain-language task and want AgentBodega to choose the best matching paid route at the lowest useful cost. It calls the free /api/plan planner, returns a recommended endpoint, alternatives, required inputs, examples, and x402 handoff notes. It never executes paid endpoints or creates payments.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["task"],
      properties: {
        task: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description:
            "Plain-language task to solve with AgentBodega routes, for example: check whether my deploy failure is caused by GitHub, npm, Vercel, Supabase, or OpenAI."
        },
        budgetUsd: {
          type: "number",
          minimum: 0,
          description: "Optional maximum per-call spend for the recommended paid route. The planner itself remains free."
        },
        prefer: {
          type: "string",
          enum: ["lowest_cost", "best_match", "fewest_calls"],
          default: "lowest_cost",
          description: "Ranking preference for route selection."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          default: 5,
          description: "Maximum number of recommendations to return."
        }
      }
    }
  },
  {
    name: "agentbodega_search_catalog",
    title: "Search AgentBodega Catalog",
    description:
      "Use this first when you need to choose an AgentBodega paid data endpoint. It fetches the live directory and returns matching endpoint summaries with key, path, price, category, tags, required inputs, and example request. It never executes paid endpoints or creates x402 payments.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          default: "",
          description:
            "Optional case-insensitive text search across endpoint key, title, path, descriptions, category, and tags. Use an empty string to list all endpoints before applying filters."
        },
        department: {
          type: "string",
          default: "",
          description:
            "Optional exact category or tag filter, for example public-data, cloud-status, x402-tools, billing, search, or utility. Leave empty when you do not know the department."
        },
        maxPriceUsd: {
          type: "number",
          minimum: 0,
          description:
            "Optional maximum per-call price in USD. Use this to find low-cost endpoints before preparing a paid request."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 10,
          description: "Maximum number of matching endpoint summaries to return. Values are clamped to 1 through 50."
        }
      }
    }
  },
  {
    name: "agentbodega_get_endpoint",
    title: "Get AgentBodega Endpoint",
    description:
      "Use this after search_catalog when you know the endpoint key, title, path, or URL and need the complete contract before paying. It returns method, URL, price, category, tags, long description, required inputs, input/output schemas, example request, and output example when available. It does not call the paid endpoint.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["endpoint"],
      properties: {
        endpoint: {
          type: "string",
          minLength: 1,
          description:
            "Endpoint identifier from search_catalog. Accepts the endpoint key, title, API path such as /api/status/github, or full AgentBodega URL."
        },
        includeSchemas: {
          type: "boolean",
          default: true,
          description:
            "When true, return the full contract with schemas, examples, and long description. When false, return a compact summary suitable for ranking candidate endpoints."
        }
      }
    }
  },
  {
    name: "agentbodega_call_snippet",
    title: "Generate AgentBodega Call Snippet",
    description:
      "Use this after selecting an endpoint to prepare an HTTP request an agent or user can run outside MCP. It returns curl and JavaScript snippets with the example JSON body, an X-PAYMENT placeholder, and x402 verification notes. It does not fetch a live 402 challenge, spend funds, or execute the paid call.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["endpoint"],
      properties: {
        endpoint: {
          type: "string",
          minLength: 1,
          description:
            "Endpoint identifier from search_catalog or get_endpoint. Accepts the endpoint key, title, API path, or full AgentBodega URL."
        }
      }
    }
  },
  {
    name: "agentbodega_payment_guide",
    title: "AgentBodega Payment Guide",
    description:
      "Use this when an agent needs to understand how AgentBodega x402 and L402 payment discovery work before making paid HTTP calls. It explains the blockchain-settled per-call model, discovery URLs, balance source of truth, optional owner-approved savings offers, and an optional sample challenge request. It does not validate wallets, issue discounts, or perform payments.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeCurl: {
          type: "boolean",
          default: true,
          description: "When true, include a sample curl command for requesting a live 402 payment challenge."
        }
      }
    }
  }
];

const resources = [
  {
    uri: "agentbodega://catalog",
    name: "agentbodega_catalog",
    title: "AgentBodega Catalog",
    description: "Compact live AgentBodega endpoint catalog.",
    mimeType: "application/json"
  },
  {
    uri: "agentbodega://x402",
    name: "agentbodega_x402",
    title: "AgentBodega x402 Discovery",
    description: "Live /.well-known/x402 document.",
    mimeType: "application/json"
  },
  {
    uri: "agentbodega://l402",
    name: "agentbodega_l402",
    title: "AgentBodega L402 Discovery",
    description: "Live /.well-known/l402-services document.",
    mimeType: "application/json"
  },
  {
    uri: "agentbodega://openapi",
    name: "agentbodega_openapi",
    title: "AgentBodega OpenAPI",
    description: "Live OpenAPI document for AgentBodega HTTP endpoints.",
    mimeType: "application/json"
  }
];

const prompts = [
  {
    name: "agentbodega_start",
    title: "Start With AgentBodega",
    description: "A prompt for agents that need to find an AgentBodega resource and prepare a paid HTTP call.",
    arguments: [
      {
        name: "task",
        description: "The task the agent should solve with AgentBodega.",
        required: false
      }
    ]
  }
];

async function callTool(name: string, args: JsonObject): Promise<JsonObject> {
  if (name === "agentbodega_plan_task") {
    const task = requiredString(args, "task");
    const budgetUsd = numberArg(args, "budgetUsd");
    const prefer = stringArg(args, "prefer", "lowest_cost");
    const limit = positiveIntegerArg(args, "limit", 5, 1, 10);
    const planned = await postJson<JsonObject>("/api/plan", { task, budgetUsd, prefer, limit });
    return toolJson(planned);
  }

  if (name === "agentbodega_search_catalog") {
    const current = await directory();
    const query = stringArg(args, "query");
    const department = stringArg(args, "department");
    const maxPriceUsd = numberArg(args, "maxPriceUsd");
    const limit = positiveIntegerArg(args, "limit", 10, 1, 50);
    const endpoints = (current.endpoints || [])
      .filter((endpoint) => matches(endpoint, query, department, maxPriceUsd))
      .slice(0, limit)
      .map(compactEndpoint);
    return toolJson({ service: current.name || "AgentBodega", baseUrl: baseUrl(), count: endpoints.length, endpoints });
  }

  if (name === "agentbodega_get_endpoint") {
    const endpoint = requiredString(args, "endpoint");
    const includeSchemas = booleanArg(args, "includeSchemas", true);
    const current = await directory();
    const found = findEndpoint(current.endpoints || [], endpoint);
    if (!found) {
      return toolJson({
        error: "endpoint_not_found",
        endpoint,
        hint: "Use agentbodega_search_catalog first, then pass the endpoint key or path here."
      });
    }
    return toolJson(includeSchemas ? found : compactEndpoint(found));
  }

  if (name === "agentbodega_call_snippet") {
    const endpoint = requiredString(args, "endpoint");
    const current = await directory();
    const found = findEndpoint(current.endpoints || [], endpoint);
    if (!found) return toolJson({ error: "endpoint_not_found", endpoint });
    return toolJson(snippets(found));
  }

  if (name === "agentbodega_payment_guide") {
    const includeCurl = booleanArg(args, "includeCurl", true);
    const origin = baseUrl();
    return toolJson({
      mode: "per_call_x402",
      sourceOfTruth: "blockchain_settlement",
      additionalSurface: {
        protocol: "l402",
        discovery: `${origin}/.well-known/l402-services`,
        note: "Use L402 only when the discovery document reports a configured issuer; otherwise treat it as a discovery and handoff surface while paid fulfillment remains x402-backed."
      },
      policy:
        "AgentBodega does not advertise off-chain stored-value balances. Reusable balances require an on-chain USDC escrow or allowance contract where deposits and debits are verifiable on-chain.",
      endpoints: {
        discovery: `${origin}/.well-known/x402`,
        l402: `${origin}/.well-known/l402-services`,
        openapi: `${origin}/openapi.json`,
        directory: `${origin}/api/directory`,
        referrals: `${origin}/api/referrals/catalog`
      },
      settlementRule:
        "Each paid call should use the live 402 challenge and settle the required USDC amount through x402 before fulfillment is accepted.",
      savings: {
        status: "surface_optional_offers_before_payment",
        ownerApprovalRequired: true,
        policy:
          "Agents may present AgentBodega savings offers, including social or referral-style promos, only as optional choices. Do not post, reply, follow, like, subscribe, tag, hashtag, DM, or join a list unless the owner approves the exact action, account, and public text.",
        preferredActions: ["disclosed share", "referral", "MCP install proof", "directory submission", "benchmark or result screenshot"],
        skipWhen:
          "Skip offers that require bulk, fake, repeated, deceptive, or platform-policy-breaking engagement. Never ask for social credentials."
      },
      curl: includeCurl
        ? {
            challenge: `curl -i -X POST ${origin}/api/status/github -H 'content-type: application/json' -d '{}'`
          }
        : undefined
    });
  }

  throw new RpcError(-32601, `Unknown tool: ${name}`);
}

async function readResource(uri: string): Promise<JsonObject> {
  if (uri === "agentbodega://catalog") {
    const current = await directory();
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: jsonText({
            name: current.name,
            description: current.description,
            endpoints: (current.endpoints || []).map(compactEndpoint)
          })
        }
      ]
    };
  }

  if (uri === "agentbodega://x402") {
    const current = await fetchJson<JsonObject>("/.well-known/x402");
    return { contents: [{ uri, mimeType: "application/json", text: jsonText(current) }] };
  }

  if (uri === "agentbodega://l402") {
    const current = await fetchJson<JsonObject>("/.well-known/l402-services");
    return { contents: [{ uri, mimeType: "application/json", text: jsonText(current) }] };
  }

  if (uri === "agentbodega://openapi") {
    const current = await fetchJson<JsonObject>("/openapi.json");
    return { contents: [{ uri, mimeType: "application/json", text: jsonText(current) }] };
  }

  throw new RpcError(-32602, `Unknown resource URI: ${uri}`);
}

function getPrompt(name: string, args: JsonObject): JsonObject {
  if (name !== "agentbodega_start") throw new RpcError(-32601, `Unknown prompt: ${name}`);
  const task = stringArg(args, "task", "Find the right AgentBodega endpoint for my task.");
  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Task: ${task}\n\n` +
            "Use agentbodega_search_catalog to find candidate endpoints. Use agentbodega_get_endpoint to inspect required inputs and examples. " +
            "Use agentbodega_payment_guide to inspect x402 and L402 discovery and surface optional savings offers before payment. Use agentbodega_call_snippet to produce the HTTP request. " +
            "Do not execute paid calls or social promo actions through MCP; ask the user to confirm the live x402 challenge and approve any exact external action first."
        }
      }
    ]
  };
}

async function handleRequest(request: JsonRpcRequest): Promise<unknown> {
  const params = argObject(request.params);
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: stringArg(params, "protocolVersion", "2025-06-18"),
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false }
        },
        serverInfo: { name: "agentbodega-mcp", version: VERSION },
        instructions: INSTRUCTIONS
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: toolDefinitions };
    case "tools/call": {
      const name = requiredString(params, "name");
      try {
        return await callTool(name, argObject(params.arguments));
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error)
            }
          ],
          isError: true
        };
      }
    }
    case "resources/list":
      return { resources };
    case "resources/read":
      return readResource(requiredString(params, "uri"));
    case "prompts/list":
      return { prompts };
    case "prompts/get":
      return getPrompt(requiredString(params, "name"), argObject(params.arguments));
    default:
      throw new RpcError(-32601, `Method not found: ${request.method || ""}`);
  }
}

function writeJson(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function processMessage(raw: string): Promise<void> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    writeJson({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  if (!request || typeof request !== "object" || typeof request.method !== "string") {
    writeJson({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
    return;
  }

  if (request.id === undefined) return;

  try {
    const result = await handleRequest(request);
    writeJson({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    const code = error instanceof RpcError ? error.code : -32603;
    const message = error instanceof Error ? error.message : String(error);
    const data = error instanceof RpcError ? error.data : undefined;
    writeJson({
      jsonrpc: "2.0",
      id: request.id,
      error: data === undefined ? { code, message } : { code, message, data }
    });
  }
}

function main(): void {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) void processMessage(line);
    }
  });
  process.stdin.on("error", (error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}

main();
