import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

function endpoint(origin, overrides) {
  return {
    key: "public-data-catalog",
    title: "Public Data Catalog",
    method: "POST",
    url: `${origin}/api/public-data/catalog`,
    price: { currency: "USD", amount: "0.001" },
    amount: "1000",
    category: "public-data",
    tags: ["public-data", "catalog"],
    description: "Return public data offerings.",
    longDescription: "Return public data offerings.\n\nRequired fields: category.",
    inputContract: {
      required: ["category"],
      optional: ["limit"],
      example: { category: "public-records", limit: 10 }
    },
    exampleRequest: { category: "public-records", limit: 10 },
    outputExample: { categories: [] },
    balanceModel: { mode: "per_call_x402", sourceOfTruth: "blockchain_settlement" },
    ...overrides
  };
}

function fixtureDirectory(origin) {
  return {
    name: "AgentBodega",
    description: "Fixture catalog",
    directory: `${origin}/api/directory`,
    openapi: `${origin}/openapi.json`,
    x402: `${origin}/.well-known/x402`,
    llmsTxt: `${origin}/llms.txt`,
    endpoints: [
      endpoint(origin, {}),
      endpoint(origin, {
        key: "cloud-status-check",
        title: "Cloud Provider Status Check",
        url: `${origin}/api/cloud/status/check`,
        price: { currency: "USD", amount: "0.005" },
        amount: "5000",
        category: "cloud-status",
        tags: ["cloud-status", "status"],
        description: "Check cloud provider status.",
        longDescription: "Check cloud provider status.\n\nRequired fields: provider.",
        inputContract: {
          required: ["provider"],
          optional: ["service", "region"],
          example: { provider: "aws", service: "lambda", region: "us-east-1" }
        },
        exampleRequest: { provider: "aws", service: "lambda", region: "us-east-1" },
        outputExample: { status: "ok" }
      }),
      endpoint(origin, {
        key: "x402-inspector",
        title: "x402 Endpoint Inspector",
        url: `${origin}/api/inspect/x402`,
        price: { currency: "USD", amount: "0.01" },
        amount: "10000",
        category: "x402-tools",
        tags: ["x402", "inspection"],
        description: "Inspect payable endpoint metadata.",
        longDescription: "Inspect payable endpoint metadata.\n\nRequired fields: url.",
        inputContract: {
          required: ["url"],
          optional: [],
          example: { url: "https://example.com/api/paid" }
        },
        exampleRequest: { url: "https://example.com/api/paid" },
        outputExample: { paymentRequired: true }
      })
    ]
  };
}

async function withFixtureServer(fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    requests.push({ method: req.method, url: req.url, userAgent: req.headers["user-agent"] });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/directory") {
      res.end(JSON.stringify(fixtureDirectory(origin)));
      return;
    }
    if (req.url === "/.well-known/x402") {
      res.end(
        JSON.stringify({
          x402Version: 2,
          name: "AgentBodega",
          resources: fixtureDirectory(origin).endpoints.map((item) => ({
            resource: item.url,
            method: item.method,
            metadata: { price: item.price, service: item.title },
            extensions: { bazaar: { info: { input: { type: "http", method: item.method, body: item.exampleRequest } } } }
          }))
        })
      );
      return;
    }
    if (req.url === "/openapi.json") {
      res.end(
        JSON.stringify({
          openapi: "3.1.0",
          info: { title: "AgentBodega" },
          paths: {
            "/api/public-data/catalog": { post: { summary: "Public data catalog" } },
            "/api/cloud/status/check": { post: { summary: "Cloud status check" } }
          }
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withMcpClient(baseUrl, fn) {
  const client = new Client({ name: "agentbodega-mcp-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: packageDir,
    env: {
      ...process.env,
      AGENTBODEGA_BASE_URL: baseUrl
    },
    stderr: "pipe"
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function textContent(result) {
  assert.equal(result.content?.[0]?.type, "text");
  return result.content[0].text;
}

function jsonContent(result) {
  return JSON.parse(textContent(result));
}

test("AgentBodega MCP exercises all tools, resources, and prompts over stdio", async () => {
  await withFixtureServer(async (baseUrl, requests) => {
    await withMcpClient(baseUrl, async (client) => {
      assert.deepEqual((await client.getServerVersion()).name, "agentbodega-mcp");
      assert.match(await client.getInstructions(), /Do not use it to execute paid calls directly/);

      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        ["agentbodega_call_snippet", "agentbodega_get_endpoint", "agentbodega_payment_guide", "agentbodega_search_catalog"]
      );
      const toolByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
      assert.match(toolByName.get("agentbodega_search_catalog").description, /Use this first/);
      assert.match(toolByName.get("agentbodega_search_catalog").description, /never executes paid endpoints/);
      assert.match(toolByName.get("agentbodega_get_endpoint").description, /complete contract/);
      assert.match(toolByName.get("agentbodega_get_endpoint").description, /does not call the paid endpoint/);
      assert.match(toolByName.get("agentbodega_call_snippet").description, /does not fetch a live 402 challenge/);
      assert.match(toolByName.get("agentbodega_payment_guide").description, /does not validate wallets/);
      assert.match(
        toolByName.get("agentbodega_search_catalog").inputSchema.properties.department.description,
        /category or tag filter/
      );
      assert.match(
        toolByName.get("agentbodega_get_endpoint").inputSchema.properties.includeSchemas.description,
        /full contract/
      );

      const resources = await client.listResources();
      assert.deepEqual(
        resources.resources.map((resource) => resource.uri).sort(),
        ["agentbodega://catalog", "agentbodega://openapi", "agentbodega://x402"]
      );

      const prompts = await client.listPrompts();
      assert.deepEqual(
        prompts.prompts.map((prompt) => prompt.name),
        ["agentbodega_start"]
      );

      const search = jsonContent(
        await client.callTool({
          name: "agentbodega_search_catalog",
          arguments: { query: "status", department: "cloud-status", maxPriceUsd: 0.005, limit: 5 }
        })
      );
      assert.equal(search.service, "AgentBodega");
      assert.equal(search.baseUrl, baseUrl);
      assert.equal(search.count, 1);
      assert.equal(search.endpoints[0].key, "cloud-status-check");
      assert.deepEqual(search.endpoints[0].requiredInputs, ["provider"]);

      const cheapSearch = jsonContent(
        await client.callTool({
          name: "agentbodega_search_catalog",
          arguments: { query: "", department: "", maxPriceUsd: 0.001, limit: 50 }
        })
      );
      assert.deepEqual(cheapSearch.endpoints.map((item) => item.key), ["public-data-catalog"]);

      const fullEndpoint = jsonContent(
        await client.callTool({
          name: "agentbodega_get_endpoint",
          arguments: { endpoint: "public-data-catalog", includeSchemas: true }
        })
      );
      assert.match(fullEndpoint.longDescription, /Required fields: category/);
      assert.deepEqual(fullEndpoint.inputContract.required, ["category"]);
      assert.deepEqual(fullEndpoint.outputExample, { categories: [] });

      const compactEndpoint = jsonContent(
        await client.callTool({
          name: "agentbodega_get_endpoint",
          arguments: { endpoint: "/api/cloud/status/check", includeSchemas: false }
        })
      );
      assert.equal(compactEndpoint.key, "cloud-status-check");
      assert.equal(compactEndpoint.longDescription, undefined);

      const missingEndpoint = jsonContent(
        await client.callTool({
          name: "agentbodega_get_endpoint",
          arguments: { endpoint: "missing-route" }
        })
      );
      assert.equal(missingEndpoint.error, "endpoint_not_found");
      assert.match(missingEndpoint.hint, /agentbodega_search_catalog/);

      const snippet = jsonContent(
        await client.callTool({
          name: "agentbodega_call_snippet",
          arguments: { endpoint: "/api/public-data/catalog" }
        })
      );
      assert.equal(snippet.endpoint.key, "public-data-catalog");
      assert.match(snippet.curl, /X-PAYMENT/);
      assert.match(snippet.javascript, /x-payment/);
      assert.equal(snippet.payment.balanceModel.sourceOfTruth, "blockchain_settlement");

      const missingSnippet = jsonContent(
        await client.callTool({
          name: "agentbodega_call_snippet",
          arguments: { endpoint: "missing-route" }
        })
      );
      assert.equal(missingSnippet.error, "endpoint_not_found");

      const paymentGuide = jsonContent(
        await client.callTool({
          name: "agentbodega_payment_guide",
          arguments: { includeCurl: false }
        })
      );
      assert.equal(paymentGuide.mode, "per_call_x402");
      assert.equal(paymentGuide.sourceOfTruth, "blockchain_settlement");
      assert.equal(paymentGuide.curl, undefined);
      assert.equal(paymentGuide.endpoints.discovery, `${baseUrl}/.well-known/x402`);
      assert.equal(paymentGuide.endpoints.referrals, `${baseUrl}/api/referrals/catalog`);
      assert.equal(paymentGuide.savings.ownerApprovalRequired, true);
      assert.match(paymentGuide.savings.policy, /Do not post, reply, follow, like, subscribe/);
      assert.match(paymentGuide.savings.skipWhen, /Never ask for social credentials/);

      const catalog = JSON.parse((await client.readResource({ uri: "agentbodega://catalog" })).contents[0].text);
      assert.equal(catalog.endpoints.length, 3);
      assert.equal(catalog.endpoints[0].key, "public-data-catalog");

      const x402 = JSON.parse((await client.readResource({ uri: "agentbodega://x402" })).contents[0].text);
      assert.equal(x402.x402Version, 2);
      assert.equal(x402.resources.length, 3);
      assert.ok(x402.resources.every((resource) => resource.extensions?.bazaar?.info));

      const openapi = JSON.parse((await client.readResource({ uri: "agentbodega://openapi" })).contents[0].text);
      assert.equal(openapi.openapi, "3.1.0");
      assert.ok(openapi.paths["/api/public-data/catalog"]);

      const prompt = await client.getPrompt({
        name: "agentbodega_start",
        arguments: { task: "Find a cheap status check." }
      });
      assert.match(prompt.messages[0].content.text, /Find a cheap status check/);
      assert.match(prompt.messages[0].content.text, /agentbodega_search_catalog/);
      assert.match(prompt.messages[0].content.text, /surface optional savings offers/);
      assert.match(prompt.messages[0].content.text, /approve any exact external action/);

      assert.equal(
        requests.some((request) => request.url === "/api/public-data/catalog"),
        false,
        "MCP must not execute paid endpoint calls while generating snippets"
      );
      assert.ok(requests.every((request) => String(request.userAgent || "").startsWith("agentbodega-mcp/")));
    });
  });
});

test("AgentBodega MCP propagates AgentBodega fetch failures", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = 503;
    res.end(JSON.stringify({ error: "maintenance", path: req.url }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await withMcpClient(`http://127.0.0.1:${server.address().port}`, async (client) => {
      const result = await client.callTool({
        name: "agentbodega_search_catalog",
        arguments: { query: "anything", limit: 1 }
      });
      assert.equal(result.isError, true);
      assert.match(textContent(result), /503/);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("AgentBodega MCP npm package dry-run includes the executable and registry metadata", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageDir,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packed = JSON.parse(result.stdout)[0];
  const files = packed.files.map((file) => file.path).sort();
  assert.ok(files.includes("dist/index.js"));
  assert.ok(files.includes("LICENSE"));
  assert.ok(files.includes("README.md"));
  assert.ok(files.includes("server.json"));

  const manifestPath = join(packageDir, "package.json");
  const serverJsonPath = join(packageDir, "server.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const serverJson = JSON.parse(readFileSync(serverJsonPath, "utf8"));
  assert.equal(serverJson.name, manifest.mcpName);
  assert.equal(serverJson.$schema, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
  assert.equal(serverJson.packages[0].registryType, "npm");
  assert.equal(serverJson.packages[0].identifier, manifest.name);
  assert.equal(serverJson.packages[0].version, manifest.version);
  assert.equal(serverJson.websiteUrl, manifest.homepage);
  assert.deepEqual(serverJson.packages[0].runtimeArguments, [{ type: "positional", value: "-y" }]);
  assert.equal(manifest.bin["agentbodega-mcp"], "dist/index.js");
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(Object.keys(manifest.devDependencies).sort(), ["@modelcontextprotocol/sdk", "@types/node", "typescript"]);
});
