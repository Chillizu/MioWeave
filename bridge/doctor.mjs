#!/usr/bin/env node
// Read-only, local-only diagnostics. Never prints or transmits the Bridge token
// except as the authentication header to the configured local Bridge.
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridgePort = Number(process.env.WEBMCP_BRIDGE_PORT || 8790);
const mcpUrl = process.env.MIODESK_MCP_URL || "http://127.0.0.1:8787/mcp";
let errors = 0;
function report(ok, subject, detail = "") {
  console.log(`${ok ? "[OK]" : "[FAIL]"} ${subject}${detail ? ": " + detail : ""}`);
  if (!ok) errors++;
}
async function check(url, headers = {}) {
  const response = await fetch(url,{headers,signal:AbortSignal.timeout(2500)});
  let result = null;
  try {result = await response.json();} catch {}
  return {response,result};
}

if (Number(process.versions.node.split(".")[0]) < 20) {
  report(false,"Node.js", "version 20+ required");
} else {
  report(true,"Node.js", `v${process.versions.node}`);
}

let token = process.env.WEBMCP_BRIDGE_TOKEN || "";
if (!token) {
  try {
    const tokenFile = process.env.WEBMCP_BRIDGE_TOKEN_FILE || resolve(root,"artifacts/dev-token.txt");
    token = (await readFile(tokenFile,"utf8")).trim();
    if (!token || Buffer.byteLength(token) > 4096 || /\s/.test(token)) token = "";
  }
  catch {}
}
report(Boolean(token), "Bridge token", token ? "configured (value not shown)" :
  "missing; see the README's token-generation step");

try {
  const url = new URL(mcpUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid URL");
  const {response,result} = await check(new URL("/healthz",url));
  report(response.ok && result?.ok !== false,"MioDesk Core", response.ok ? "reachable" : `HTTP ${response.status}`);
} catch {
  report(false,"MioDesk Core", "not reachable; check your miodesk service and MCP URL");
}

if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) {
  report(false,"Bridge", "invalid WEBMCP_BRIDGE_PORT");
} else {
  const base = `http://127.0.0.1:${bridgePort}`;
  try {
    const {response,result} = await check(base + "/health");
    report(response.ok && result?.ok === true,"Bridge", response.ok ? "reachable" : `HTTP ${response.status}`);
  } catch {
    report(false,"Bridge", "not running; start bridge/start-readonly.sh (or full mode)");
  }
  if (token) {
    try {
      const {response,result} = await check(base + "/tools",{"X-WebMCP-Token":token});
      report(response.ok && result?.ok === true,"Bridge authorization",
        response.ok ? `${result.tools?.length || 0} tools available` :
          response.status === 401 ? "token mismatch; check extension settings and Bridge" : `HTTP ${response.status}`);
    } catch {
      report(false,"Bridge authorization", "could not contact local Bridge");
    }
  }
}

console.log(errors ? `\n${errors} check(s) need attention.` : "\nLocal connection checks passed.");
if (errors) process.exitCode = 1;
