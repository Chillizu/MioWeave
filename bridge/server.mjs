import http from "node:http";

const HOST = "127.0.0.1";
const PORT = Number(process.env.WEBMCP_BRIDGE_PORT || 8790);
const MCP_URL = process.env.MIODESK_MCP_URL || "http://127.0.0.1:8787/mcp";
const TOKEN = process.env.WEBMCP_BRIDGE_TOKEN || "";

if (!TOKEN) {
  console.error("WEBMCP_BRIDGE_TOKEN is required.");
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
  if (origin.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
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
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length > 1_000_000) throw new Error("request too large");
  return raw ? JSON.parse(raw) : {};
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
    if (!(req.headers.origin || "").startsWith("chrome-extension://")) {
      return json(res, 403, {ok:false,error:"extension origin required"});
    }
    res.statusCode = 204;
    return res.end();
  }

  if (req.url === "/health" && req.method === "GET") {
    return json(res, 200, {ok:true, bridge:"webmcp-deepseek-lab", mcp:MCP_URL});
  }

  if (req.headers["x-webmcp-token"] !== TOKEN) {
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
      const name = String(body.tool || "");
      if (!allowedTools().has(name)) {
        return json(res, 403, {ok:false,error:`tool not enabled: ${name}`});
      }
      const result = await mcp("tools/call", {
        name,
        arguments: body.arguments && typeof body.arguments === "object" ? body.arguments : {}
      });
      return json(res, 200, {ok:true, result});
    }

    return json(res, 404, {ok:false,error:"not found"});
  } catch (error) {
    return json(res, 500, {ok:false,error:String(error?.message || error)});
  }
});

server.listen(PORT, HOST, () => {
  console.log(`WebMCP DeepSeek bridge: http://${HOST}:${PORT}`);
  console.log(`Allowed tools: ${[...allowedTools()].join(", ")}`);
});
