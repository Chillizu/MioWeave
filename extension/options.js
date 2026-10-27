const el = id => document.getElementById(id);
const message = (id, value, error = false) => {
  const node = el(id);
  node.textContent = value;
  node.classList.toggle("error", error);
};
const send = async value => chrome.runtime.sendMessage(value);
const version = chrome.runtime.getManifest().version;
el("version").textContent = "Version " + version;
let currentMode = "ask";

async function reloadConfig() {
  const result = await send({type:"WEBMCP_CONFIG_GET"});
  if (!result?.ok) throw new Error(result?.error || "Could not read settings");
  const c = result.config;
  currentMode = c.approvalMode || "ask";
  const radio = document.querySelector('input[name="policy"][value="' + currentMode + '"]');
  if (radio) radio.checked = true;
  el("bridge-url").value = c.bridgeUrl || "http://127.0.0.1:8790";
  el("tool-label").value = c.localToolLabel || "MioDesk";
  el("token-state").textContent = c.bridgeTokenConfigured
    ? "Token configured. Leave this field empty to keep it; the stored secret is never displayed here."
    : "No token configured. The bridge requires a token to authorize local tools.";
  el("enabled").checked = c.enabled !== false;
  el("auto-read").checked = Boolean(c.autoRunReadOnly);
  el("auto-send").checked = c.autoSendCallbacks !== false;
  el("hide-callbacks").checked = c.hideCallbacks !== false;
  const delay = String(c.callbackDelayMs ?? 1500);
  el("callback-delay").value = [...el("callback-delay").options].some(o=>o.value===delay) ? delay : "1500";
  updatePolicy();
}

function updatePolicy() {
  const chosen = document.querySelector('input[name="policy"]:checked')?.value || currentMode;
  el("policy-risk").hidden = chosen !== "always" || currentMode === "always";
  el("policy-status").textContent =
    currentMode === "always" ? "Auto-approve" :
      currentMode === "block" ? "Blocked" : "Ask each time";
  el("policy-detail").textContent =
    currentMode === "always" ? "All authorized chats · persistent" :
      currentMode === "block" ? "Privileged tools unavailable" : "Confirm or grant per-chat access";
}
for (const radio of document.querySelectorAll('input[name="policy"]')) {
  radio.addEventListener("change", updatePolicy);
}

el("save-policy").addEventListener("click", async event => {
  if (!event.isTrusted) return;
  const mode = document.querySelector('input[name="policy"]:checked')?.value;
  if (mode === "always" && currentMode !== "always" &&
      el("policy-confirm").value.trim() !== "ENABLE") {
    message("policy-message", "Type ENABLE to explicitly authorize global automatic local tool execution.", true);
    return;
  }
  const response = await send({type:"WEBMCP_GLOBAL_POLICY_SET",mode});
  if (!response?.ok) {
    message("policy-message", response?.error || "Could not save global policy", true);
    return;
  }
  currentMode = mode;
  el("policy-confirm").value = "";
  updatePolicy();
  message("policy-message", mode === "always"
    ? "Global auto-approval is active. Review this choice regularly."
    : "Global policy saved.");
});

el("save-connection").addEventListener("click", async () => {
  const address = el("bridge-url").value.trim();
  if (!/^http:\/\/127\.0\.0\.1(?::\d+)?\/?$/.test(address) &&
      !/^http:\/\/localhost(?::\d+)?\/?$/.test(address)) {
    message("connection-message", "Use a loopback HTTP address such as http://127.0.0.1:8790.", true);
    return;
  }
  const patch = {
    bridgeUrl:address.replace(/\/$/,""),
    localToolLabel:el("tool-label").value.trim() || "MioDesk"
  };
  if (el("bridge-token").value) patch.bridgeToken = el("bridge-token").value;
  const response = await send({type:"WEBMCP_CONFIG_SET",config:patch});
  if (!response?.ok) {
    message("connection-message", response?.error || "Connection settings could not be saved", true);
    return;
  }
  el("bridge-token").value = "";
  message("connection-message", "Connection settings saved.");
  await refreshHealth();
});

el("save-behavior").addEventListener("click", async () => {
  const response = await send({type:"WEBMCP_CONFIG_SET",config:{
    enabled:el("enabled").checked,
    autoRunReadOnly:el("auto-read").checked,
    autoSendCallbacks:el("auto-send").checked,
    hideCallbacks:el("hide-callbacks").checked,
    callbackDelayMs:Number(el("callback-delay").value)
  }});
  message("behavior-message", response?.ok ? "Behavior settings saved." :
    (response?.error || "Unable to save behavior settings."), !response?.ok);
});

async function refreshHealth() {
  const r = await send({type:"WEBMCP_BRIDGE_CHECK"});
  const okay = Boolean(r?.authorized);
  el("connection-status").textContent = okay ? "Connected" : r?.connected ? "Needs authorization" : "Offline";
  el("connection-detail").textContent = okay ? "Local companion authorized" :
    r?.error || (r?.tokenConfigured ? "Token rejected" : "Bridge token not configured");
  const tools = Array.isArray(r?.tools) ? r.tools : [];
  el("tool-count").textContent = String(tools.length);
  el("tool-detail").textContent = "Exposed by the local bridge";
  const list = el("tools-list");
  list.replaceChildren();
  if (!tools.length) {
    const empty = document.createElement("p");
    empty.className = "support";
    empty.textContent = "No tool schemas available. Connect the bridge and refresh.";
    list.append(empty);
  }
  for (const tool of tools) {
    const node = document.createElement("details");
    node.className = "tool";
    const title = document.createElement("summary");
    const strong = document.createElement("strong");
    strong.textContent = tool.name || "unknown";
    const access = document.createElement("small");
    access.textContent = ["status","list","read","search"].includes(tool.name) ? "Read only" : "Privileged";
    title.append(strong,access);
    const desc = document.createElement("p");
    desc.textContent = tool.description || "No description supplied";
    const schema = document.createElement("pre");
    schema.textContent = JSON.stringify(tool.inputSchema || {},null,2);
    node.append(title,desc,schema);
    list.append(node);
  }
  const summary = {
    bridge:r?.health?.bridge || "MioWeave local bridge",
    endpoint:r?.health?.mcp || "(not reachable)",
    connected:Boolean(r?.connected),
    authorized:okay,
    tokenConfigured:Boolean(r?.tokenConfigured),
    exposedTools:tools.map(t=>t.name),
    error:r?.error || null
  };
  el("diagnostics-text").textContent = JSON.stringify(summary,null,2);
}
el("refresh").addEventListener("click", refreshHealth);
el("test-bridge").addEventListener("click", refreshHealth);
Promise.all([reloadConfig(),refreshHealth()]).catch(error => {
  el("diagnostics-text").textContent = String(error?.message || error);
});
