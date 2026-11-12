#!/usr/bin/env node
// Isolated integration checks: this spawns a bridge and a mock MCP endpoint.
// It never reaches the user's real MioDesk server or performs local tool calls.
import assert from "node:assert/strict";
import {spawn, execFile} from "node:child_process";
import {promisify} from "node:util";
import {createServer, request as httpRequest} from "node:http";
import {once} from "node:events";
import {resolve, join} from "node:path";
import {mkdtemp, writeFile, rename, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {setTimeout as sleep} from "node:timers/promises";

const origin = `chrome-extension://${"a".repeat(32)}`;
const token = "test-only-bridge-token-do-not-use";
const mockCalls = [];
const mockMcp = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ok:true}));
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const rpc = JSON.parse(body);
  mockCalls.push(rpc);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({jsonrpc:"2.0", id:rpc.id,
    result:rpc.method === "tools/list"
      ? {tools:["status","read","exec_command","write"].map(name => ({name}))}
      : {structuredContent:{kind:"test",tool:rpc.params.name}}}));
});
async function availablePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function call(port, path, {method = "GET", headers = {}, body} = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers, body, signal:AbortSignal.timeout(4000)
  });
  const raw = await res.text();
  return {status:res.status,headers:res.headers,data:raw ? JSON.parse(raw) : null};
}
async function withBridge(mode, check, overrides = {}) {
  const port = await availablePort();
  const env = {...process.env, WEBMCP_BRIDGE_PORT:String(port),
    WEBMCP_BRIDGE_TOKEN:token,
    WEBMCP_ALLOW_EXEC:mode === "full" ? "1":"0",
    WEBMCP_ALLOW_WRITE:mode === "full" ? "1":"0",
    MIODESK_MCP_URL:`http://127.0.0.1:${mockMcp.address().port}/mcp`, ...overrides};
  const child = spawn(process.execPath,[resolve("bridge/server.mjs")],{
    env,stdio:["ignore","pipe","pipe"]});
  let logs = "";
  child.stderr.on("data", x=>{logs += x.toString();});
  try {
    let ready = false;
    for (let i=0;i<40;i++) {
      if (child.exitCode !== null) throw new Error(`Bridge died: ${logs}`);
      try {
        const r = await call(port,"/health");
        if (r.status === 200 && r.data?.ok) {ready=true;break;}
      } catch {}
      await sleep(70);
    }
    assert.ok(ready,`bridge startup timed out: ${logs}`);
    await check(port);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child,"exit"),sleep(1200)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
const okHeaders = {"x-webmcp-token":token};
const payload = (tool,args={}) => JSON.stringify({tool,arguments:args});
const execFileAsync = promisify(execFile);
async function chunkedCall(port, size) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({host:"127.0.0.1",port,path:"/call",method:"POST",
      headers:{...okHeaders,"Transfer-Encoding":"chunked"}}, res => {
      const chunks=[];
      res.on("data",chunk=>chunks.push(chunk));
      res.on("end",()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString()}));
    });
    req.on("error",reject);
    // Send multiple chunks so the guard is exercised while streaming data.
    for (let i=0;i<size;i+=16000) req.write("x".repeat(Math.min(16000,size-i)));
    req.end();
  });
}
let passed = 0;
mockMcp.listen(0,"127.0.0.1");
await once(mockMcp,"listening");
try {
  await withBridge("readonly", async port => {
    const health = await call(port,"/health");
    assert.equal(health.status,200);
    assert.equal(health.data.bridge,"mioweave");
    assert.ok(!JSON.stringify(health.data).includes(token),"health leaked a credential");
    assert.equal(health.headers.get("cache-control"),"no-store");
    const preflight = await call(port,"/call",{method:"OPTIONS",headers:{origin}});
    assert.equal(preflight.status,204);
    assert.equal(preflight.headers.get("access-control-allow-origin"),origin);
    const badPreflight = await call(port,"/call",{method:"OPTIONS",headers:{origin:"https://chat.deepseek.com"}});
    assert.equal(badPreflight.status,403);
    const spoofPreflight = await call(port,"/call",{method:"OPTIONS",headers:{origin:"chrome-extension://fake.invalid"}});
    assert.equal(spoofPreflight.status,403);
    const badOrigin = await call(port,"/call",{method:"POST",headers:{...okHeaders,origin:"https://chat.deepseek.com"},body:payload("status")});
    assert.equal(badOrigin.status,403);
    const goodExtension = await call(port,"/tools",{headers:{...okHeaders,origin}});
    assert.equal(goodExtension.status,200);
    assert.equal(goodExtension.headers.get("access-control-allow-origin"),origin);
    assert.deepEqual(goodExtension.data.tools.map(x=>x.name),["status","read"]);
    const noToken = await call(port,"/tools",{headers:{origin}});
    assert.equal(noToken.status,401);
    const cli = await call(port,"/call",{method:"POST",headers:okHeaders,body:payload("status")});
    assert.equal(cli.status,200);
    assert.equal(cli.data.result.structuredContent.tool,"status");
    const denyExec = await call(port,"/call",{method:"POST",headers:okHeaders,body:payload("exec_command")});
    assert.equal(denyExec.status,403);
    for (const body of ["{", "[]", payload("status",[]), payload("status",null),JSON.stringify({tool:17})]) {
      const res = await call(port,"/call",{method:"POST",headers:okHeaders,body});
      assert.equal(res.status,400,`should reject: ${body}`);
    }
    const overBody = JSON.stringify({tool:"status",arguments:{data:"x".repeat(1_000_100)}});
    const tooBig = await call(port,"/call",{method:"POST",headers:okHeaders,body:overBody});
    assert.equal(tooBig.status,413);
    const streamedOversize = await chunkedCall(port,1_005_000);
    assert.equal(streamedOversize.status,413);
    // Request size check must happen before any new invocation of MCP.
    assert.equal(mockCalls.filter(x=>x.method === "tools/call").length,1);
    const doctor = await execFileAsync(process.execPath,[resolve("bridge/doctor.mjs")],{
      env:{...process.env,WEBMCP_BRIDGE_PORT:String(port),WEBMCP_BRIDGE_TOKEN:token,
        MIODESK_MCP_URL:`http://127.0.0.1:${mockMcp.address().port}/mcp`},timeout:8000});
    assert.match(doctor.stdout,/Local connection checks passed/);
    assert.match(doctor.stdout,/Bridge authorization: 2 tools/);
    assert.ok(!doctor.stdout.includes(token),"doctor leaked the token");
    passed += 15;
  });
  await withBridge("full", async port => {
    const tools = await call(port,"/tools",{headers:okHeaders});
    assert.deepEqual(tools.data.tools.map(x=>x.name),["status","read","exec_command","write"]);
    const exec = await call(port,"/call",{method:"POST",headers:{...okHeaders,origin},body:payload("exec_command",{cmd:"not actually executed"})});
    assert.equal(exec.status,200);
    assert.equal(exec.data.result.structuredContent.tool,"exec_command");
    passed += 2;
  });
  const tokenDir = await mkdtemp(join(tmpdir(),"mioweave-token-test-"));
  const tokenFile = join(tokenDir,"bridge-token");
  const rotated = "rotated-test-only-bridge-token";
  try {
    await writeFile(tokenFile, token+"\n", {mode:0o600});
    await withBridge("readonly", async port => {
      assert.equal((await call(port,"/tools",{headers:okHeaders})).status,200);
      await writeFile(tokenFile+".next", rotated+"\n", {mode:0o600});
      await rename(tokenFile+".next",tokenFile);
      assert.equal((await call(port,"/tools",{headers:okHeaders})).status,401,
        "old credential remained authorized after atomic rotation");
      const headers = {"x-webmcp-token":rotated};
      assert.equal((await call(port,"/tools",{headers})).status,200,
        "new credential did not take effect without restart");
      const health = await call(port,"/health");
      assert.equal(health.data.token_source,"file");
      for (const secret of [token,rotated,tokenFile]) {
        assert.ok(!JSON.stringify(health.data).includes(secret),"health disclosed a credential or path");
      }
      const doctor = await execFileAsync(process.execPath,[resolve("bridge/doctor.mjs")],{
        env:{...process.env,WEBMCP_BRIDGE_PORT:String(port),WEBMCP_BRIDGE_TOKEN:"",
          WEBMCP_BRIDGE_TOKEN_FILE:tokenFile,
          MIODESK_MCP_URL:`http://127.0.0.1:${mockMcp.address().port}/mcp`},timeout:8000});
      assert.match(doctor.stdout,/Local connection checks passed/);
      assert.ok(!doctor.stdout.includes(rotated),"file-backed doctor disclosed the token");
      for (const invalid of ["","bad\nmultiline","x".repeat(4100)]) {
        await writeFile(tokenFile,invalid);
        const rejected = await call(port,"/tools",{headers});
        assert.equal(rejected.status,503,"invalid credential file did not fail closed");
        assert.ok(!JSON.stringify(rejected.data).includes(rotated),"error disclosed the credential");
      }
      await rm(tokenFile);
      assert.equal((await call(port,"/tools",{headers})).status,503,
        "removed credential file did not fail closed");
      passed += 8;
    },{WEBMCP_BRIDGE_TOKEN:"",WEBMCP_BRIDGE_TOKEN_FILE:tokenFile});
    await writeFile(tokenFile,rotated+"\n",{mode:0o600});
    await withBridge("readonly",async port => {
      assert.equal((await call(port,"/tools",{headers:okHeaders})).status,200);
      assert.equal((await call(port,"/tools",{headers:{"x-webmcp-token":rotated}})).status,401,
        "file unexpectedly overrode an explicit environment token");
      passed++;
    },{WEBMCP_BRIDGE_TOKEN_FILE:tokenFile});
    await rm(tokenFile);
    await assert.rejects(execFileAsync(process.execPath,[resolve("bridge/server.mjs")],{
      env:{...process.env,WEBMCP_BRIDGE_TOKEN:"",WEBMCP_BRIDGE_TOKEN_FILE:tokenFile},timeout:4000
    }), error => error.code === 2 && !error.stderr.includes(tokenFile),
    "missing startup credential must reject startup without exposing its path");
    passed++;
  } finally {
    await rm(tokenDir,{recursive:true,force:true});
  }
  console.log(`[PASS] Bridge ${passed} security and protocol checks; mock MCP only`);
} finally {
  await new Promise(resolve=>mockMcp.close(resolve));
}
