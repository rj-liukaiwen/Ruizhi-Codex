import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");
const require = createRequire(import.meta.url);
const { startRuizhiResponsesBridge } = require(path.join(projectRoot, "resources", "bridge", "ruizhi-responses-bridge.cjs"));

function bodyText(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("Qwen Responses requests with tools are routed through chat completions", async () => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const text = await bodyText(req);
    upstreamRequests.push({ path: req.url, body: JSON.parse(text) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_test",
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const authHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-bridge-auth-"));
  fs.writeFileSync(path.join(authHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-key" }));

  const bridge = startRuizhiResponsesBridge({
    host: "127.0.0.1",
    port: await freePort(),
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    authHome,
    routes: { "qwen3.6-plus": "responses" },
  });

  try {
    const response = await fetch(`${bridge.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        stream: false,
        input: "Use the browser plugin",
        tools: [{
          type: "function",
          name: "mcp__node_repl__js",
          description: "Run trusted Node REPL JavaScript",
          parameters: { type: "object", properties: {} },
        }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].path, "/v1/chat/completions");
    assert.equal(upstreamRequests[0].body.model, "qwen3.6-plus");
    assert.equal(upstreamRequests[0].body.tools?.[0]?.function?.name, "mcp__node_repl__js");
  } finally {
    await bridge.close();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(authHome, { recursive: true, force: true });
  }
});

test("Responses-native tools round trip through chat without losing patch events", async () => {
  const patch = "*** Begin Patch\n*** Update File: demo.txt\n@@\n-old\n+new\n*** End Patch";
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const text = await bodyText(req);
    upstreamRequests.push({ path: req.url, body: JSON.parse(text) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_patch",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_patch",
            type: "function",
            function: { name: "apply_patch", arguments: JSON.stringify({ input: patch }) },
          }],
        },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const authHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-bridge-auth-"));
  fs.writeFileSync(path.join(authHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-key" }));

  const bridge = startRuizhiResponsesBridge({
    host: "127.0.0.1",
    port: await freePort(),
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    authHome,
    routes: { ray: { protocol: "chat", reasoningEffort: true } },
  });

  const patchTool = {
    type: "custom",
    name: "apply_patch",
    description: "Apply a patch to workspace files",
    format: { type: "text" },
  };
  const shellTool = {
    type: "function",
    name: "shell_command",
    description: "Run a PowerShell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  };

  try {
    const response = await fetch(`${bridge.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "ray", stream: false, input: "edit demo.txt", tools: [patchTool, shellTool] }),
    });

    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].path, "/v1/chat/completions");
    assert.equal(upstreamRequests[0].body.tools?.[0]?.function?.name, "apply_patch");
    assert.equal(upstreamRequests[0].body.tools?.[0]?.function?.parameters?.properties?.input?.type, "string");
    assert.match(upstreamRequests[0].body.tools?.[0]?.function?.description, /mandatory.*only tool.*creating.*editing.*files/i);
    assert.match(upstreamRequests[0].body.tools?.[1]?.function?.description, /never create.*edit.*files.*apply_patch/i);
    assert.deepEqual(result.output, [{
      type: "custom_tool_call",
      call_id: "call_patch",
      name: "apply_patch",
      input: patch,
    }]);
  } finally {
    await bridge.close();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(authHome, { recursive: true, force: true });
  }
});

test("Streaming chat tool calls are restored as custom patch events", async () => {
  const patch = "*** Begin Patch\n*** Add File: demo.txt\n+hello\n*** End Patch";
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write(`data: ${JSON.stringify({
      id: "chatcmpl_patch_stream",
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_patch_stream",
            function: { name: "apply_patch", arguments: JSON.stringify({ input: patch }) },
          }],
        },
      }],
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const authHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-bridge-auth-"));
  fs.writeFileSync(path.join(authHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-key" }));

  const bridge = startRuizhiResponsesBridge({
    host: "127.0.0.1",
    port: await freePort(),
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    authHome,
    routes: { ray: { protocol: "chat", reasoningEffort: true } },
  });

  try {
    const response = await fetch(`${bridge.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        model: "ray",
        stream: true,
        input: "create demo.txt",
        tools: [{ type: "custom", name: "apply_patch", description: "Apply patch", format: { type: "text" } }],
      }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(text, /"type":"custom_tool_call"/);
    assert.match(text, /"name":"apply_patch"/);
    assert.ok(text.includes(JSON.stringify(patch).slice(1, -1)));
    assert.doesNotMatch(text, /response\.function_call_arguments\.done/);
  } finally {
    await bridge.close();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(authHome, { recursive: true, force: true });
  }
});

test("Responses-native function_call variants are normalized into custom patch events", async () => {
  const patch = "*** Begin Patch\n*** Add File: demo.txt\n+hello\n*** End Patch";
  const upstream = http.createServer((_req, res) => {
    const functionCall = {
      id: "fc_patch_native",
      type: "function_call",
      call_id: "call_patch_native",
      name: "apply_patch",
      arguments: JSON.stringify({ input: patch }),
      status: "completed",
    };
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write(`event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...functionCall, arguments: "", status: "in_progress" },
    })}\n\n`);
    res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.delta",
      item_id: functionCall.id,
      output_index: 0,
      delta: functionCall.arguments,
    })}\n\n`);
    res.write(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.done",
      item_id: functionCall.id,
      output_index: 0,
      arguments: functionCall.arguments,
    })}\n\n`);
    res.write(`event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: functionCall,
    })}\n\n`);
    res.write(`event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_patch_native",
        status: "completed",
        model: "gpt-5.6-luna",
        output: [functionCall],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    })}\n\n`);
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const authHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-bridge-auth-"));
  fs.writeFileSync(path.join(authHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-key" }));
  const bridge = startRuizhiResponsesBridge({
    host: "127.0.0.1",
    port: await freePort(),
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    authHome,
    routes: { "gpt-5.6-luna": "responses" },
  });

  try {
    const response = await fetch(`${bridge.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        stream: true,
        input: "create demo.txt",
        tools: [{ type: "custom", name: "apply_patch", description: "Apply patch", format: { type: "text" } }],
      }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(text, /"type":"custom_tool_call"/);
    assert.match(text, /"name":"apply_patch"/);
    assert.ok(text.includes(JSON.stringify(patch).slice(1, -1)));
    assert.doesNotMatch(text, /response\.function_call_arguments/);
    assert.doesNotMatch(text, /"type":"function_call"/);
  } finally {
    await bridge.close();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(authHome, { recursive: true, force: true });
  }
});

test("Responses bridge requests identity encoding and preserves completed SSE", async () => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    upstreamRequests.push({ path: req.url, acceptEncoding: req.headers["accept-encoding"] || "" });
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_tail", status: "in_progress", model: "gpt-5.6-luna" } })}\n\n`);
    res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`);
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_tail", status: "completed", model: "gpt-5.6-luna", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`);
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const authHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-bridge-auth-"));
  fs.writeFileSync(path.join(authHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-key" }));

  const bridge = startRuizhiResponsesBridge({
    host: "127.0.0.1",
    port: await freePort(),
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    authHome,
    routes: { "gpt-5.6-luna": "responses" },
  });

  try {
    const response = await fetch(`${bridge.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ model: "gpt-5.6-luna", stream: true, input: "hello" }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(upstreamRequests[0].acceptEncoding, /identity/);
    assert.match(text, /response\.completed/);
    assert.doesNotMatch(text, /response\.failed/);
    assert.doesNotMatch(text, /error decoding response body/);
  } finally {
    await bridge.close();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(authHome, { recursive: true, force: true });
  }
});

test("Responses bridge omits stale encrypted reasoning when resuming old conversations", async () => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const text = await bodyText(req);
    upstreamRequests.push({ path: req.url, body: JSON.parse(text) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "resp_resumed",
      status: "completed",
      model: "gpt-5.6-luna",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "continued" }] }],
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const authHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-bridge-auth-"));
  fs.writeFileSync(path.join(authHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-key" }));

  const bridge = startRuizhiResponsesBridge({
    host: "127.0.0.1",
    port: await freePort(),
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    authHome,
    routes: { "gpt-5.6-luna": "responses" },
  });

  try {
    const response = await fetch(`${bridge.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        stream: false,
        metadata: { conversation: "legacy-thread" },
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "old question" }] },
          { type: "reasoning", id: "rs_old", summary: [], encrypted_content: "gAAAAA-old-upstream-ciphertext" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "old answer" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].path, "/v1/responses");
    assert.equal(upstreamRequests[0].body.metadata.conversation, "legacy-thread");
    assert.deepEqual(
      upstreamRequests[0].body.input.map((item) => [item.type, item.role, item.id]),
      [
        ["message", "user", undefined],
        ["message", "assistant", undefined],
        ["message", "user", undefined],
      ],
    );
    assert.doesNotMatch(JSON.stringify(upstreamRequests[0].body), /encrypted_content|gAAAAA/);
  } finally {
    await bridge.close();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(authHome, { recursive: true, force: true });
  }
});
