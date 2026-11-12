import http from "node:http";
import {open} from "node:fs/promises";
import {constants} from "node:fs";
import {resolve} from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.WEBMCP_BRIDGE_PORT || 8790);
const MCP_URL = process.env.MIODESK_MCP_URL || "http://127.0.0.1:8787/mcp";
const TOKEN = process.env.WEBMCP_BRIDGE_TOKEN || "";
const TOKEN_FILE = process.env.WEBMCP_BRIDGE_TOKEN_FILE
  ? resolve(process.env.WEBMCP_BRIDGE_TOKEN_FILE) : "";
const TOKEN_SOURCE = TOKEN ? "environment" : "file";
const MAX_TOKEN_BYTES = 4098; // 4096 token bytes plus an optional CRLF.
const MAX_REQUEST_BYTES = 1_000_000;

class ClientError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function extensionOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "chrome-extension:" &&
      /^[a-p]{32}$/.test(url.hostname) && (url.pathname === "/" || !url.pathname) &&
      !url.username && !url.password && !url.port && !url.search && !url.hash;
  } catch {
    return false;
  }
}

// File-backed credentials are read again for each privileged request. Atomic
// replacements by the local panel take effect without restarting this bridge.
async function currentToken() {
  if (TOKEN) {
    if (Buffer.byteLength(TOKEN) > 4096 || /\s/.test(TOKEN)) throw new Error("invalid token");
    return TOKEN;
  }
  if (!TOKEN_FILE) throw new Error("missing token file");
  const file = await open(TOKEN_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_TOKEN_BYTES) throw new Error("invalid token file");
    const buffer = Buffer.alloc(MAX_TOKEN_BYTES + 1);
    const {bytesRead} = await file.read(buffer, 0, buffer.length, 0);
    const value = buffer.toString("utf8", 0, bytesRead).trim();
    if (bytesRead > MAX_TOKEN_BYTES || !value || Buffer.byteLength(value) > 4096 || /\s/.test(value)) {
      throw new Error("invalid token file");
    }
    return value;
  } finally {
    await file.close();
  }
}

try {
  await currentToken();
} catch {
  console.error("Configure a nonempty WEBMCP_BRIDGE_TOKEN or a readable private WEBMCP_BRIDGE_TOKEN_FILE.");
  process.exit(2);
}

const READ_ONLY = new Set(["status", "list", "read", "search"]);
const EXEC = new Set(["exec_command", "write_stdin"]);
const WRITE = new Set(["write", "edit", "delete", "context"]);

function allowedTools() {
  const tools = new Set(READ_ONLY);
  if (process.env.WEBMCP_ALLOW_EXEC === "1") for (const name of EXEC) tools.add(name);
  if (process.env.WEBMCP_ALLOW_WRITE === "1") for (const name of WRITE) tools.add(name);
  return tools;
}

function cors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");
  if (extensionOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-webmcp-token");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const declaredSize = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_REQUEST_BYTES) {
    throw new ClientError(413, "request too large");
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    // Enforce the bound during streaming, not after buffering untrusted data.
    if (bytes > MAX_REQUEST_BYTES) throw new ClientError(413, "request too large");
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ClientError(400, "invalid JSON request");
  }
}

let rpcId = 0;
async function mcp(method, params = {}) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({jsonrpc: "2.0", id: ++rpcId, method, params})
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`MioDesk HTTP ${response.status}`);
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    if (!extensionOrigin(req.headers.origin)) {
      return json(res, 403, {ok:false,error:"trusted extension origin required"});
    }
    res.statusCode = 204;
    return res.end();
  }

  // Native CLI clients send no Origin. Browsers always send Origin for
  // cross-origin privileged requests: only installed Chromium extensions may
  // use browser CORS. The token is mandatory in both cases.
  if (req.headers.origin && !extensionOrigin(req.headers.origin)) {
    return json(res, 403, {ok:false,error:"untrusted origin"});
  }

  if (req.url === "/health" && req.method === "GET") {
    // Health is intentionally unauthenticated for connectivity diagnostics.
    // Never expose the configured upstream MCP URL (it may contain secrets).
    return json(res, 200, {ok:true, bridge:"mioweave", token_source:TOKEN_SOURCE});
  }

  let expected;
  try {
    expected = await currentToken();
  } catch {
    return json(res, 503, {ok:false,error:"bridge token file is unavailable or invalid"});
  }
  if (req.headers["x-webmcp-token"] !== expected) {
    return json(res, 401, {ok:false,error:"invalid bridge token"});
  }

  try {
    if (req.url === "/tools" && req.method === "GET") {
      const result = await mcp("tools/list", {});
      const allow = allowedTools();
      const tools = (result.tools || []).filter(tool => allow.has(tool.name));
      return json(res, 200, {ok:true, tools});
    }

    if (req.url === "/call" && req.method === "POST") {
      const body = await readJson(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          typeof body.tool !== "string" || !body.tool) {
        throw new ClientError(400, "tool must be a nonempty string");
      }
      const name = body.tool;
      if (!allowedTools().has(name)) {
        return json(res, 403, {ok:false,error:`tool not enabled: ${name}`});
      }
      const args = body.arguments === undefined ? {} : body.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new ClientError(400, "tool arguments must be a JSON object");
      }
      const result = await mcp("tools/call", {name, arguments:args});
      return json(res, 200, {ok:true, result});
    }

    return json(res, 404, {ok:false,error:"not found"});
  } catch (error) {
    return json(res, error instanceof ClientError ? error.status : 500,
      {ok:false,error:String(error?.message || error)});
  }
});

server.listen(PORT, HOST, () => {
  console.log(`WebMCP DeepSeek bridge: http://${HOST}:${PORT}`);
  console.log(`Allowed tools: ${[...allowedTools()].join(", ")}`);
});
