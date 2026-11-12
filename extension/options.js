const el = id => document.getElementById(id);
const message = (id, value, error = false) => {
  const node = el(id);
  node.textContent = value;
  node.classList.toggle("error", error);
};
const send = async value => chrome.runtime.sendMessage(value);
const version = chrome.runtime.getManifest().version;
el("version").textContent = "v" + version;
let currentMode = "ask";

const themeSelect = el("settings-theme");
try {
  const saved = localStorage.getItem("mioweave-options-theme");
  if (["system", "light", "dark"].includes(saved)) themeSelect.value = saved;
} catch { /* Theme storage is optional. */ }
function applyTheme() {
  document.documentElement.style.colorScheme = themeSelect.value === "system" ? "light dark" : themeSelect.value;
}
applyTheme();
themeSelect.addEventListener("change", () => {
  applyTheme();
  try { localStorage.setItem("mioweave-options-theme", themeSelect.value); } catch { /* This page only. */ }
});

function revealSection() {
  const id = location.hash.slice(1) || "overview";
  const target = el(id);
  if (target instanceof HTMLDetailsElement) target.open = true;
  for (const link of document.querySelectorAll(".sidebar nav a")) {
    if (link.hash === "#" + id) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
window.addEventListener("hashchange", revealSection);
revealSection();

async function reloadConfig() {
  const result = await send({type:"WEBMCP_CONFIG_GET"});
  if (!result?.ok) throw new Error(result?.error || "无法读取扩展设置");
  const c = result.config;
  currentMode = c.approvalMode || "ask";
  const radio = document.querySelector('input[name="policy"][value="' + currentMode + '"]');
  if (radio) radio.checked = true;
  el("bridge-url").value = c.bridgeUrl || "http://127.0.0.1:8790";
  el("tool-label").value = c.localToolLabel || "MioDesk";
  el("token-state").textContent = c.bridgeTokenConfigured
    ? "已配置，留空不修改；不会回显已保存的值。"
    : "尚未配置，请填写与 Bridge 一致的 Token。";
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
    currentMode === "always" ? "自动批准" :
      currentMode === "block" ? "禁止高权限" : "逐次确认";
  el("policy-detail").textContent =
    currentMode === "always" ? "所有已授权聊天 · 持续保存" :
      currentMode === "block" ? "仅允许只读工具" : "可临时允许当前聊天";
}
for (const radio of document.querySelectorAll('input[name="policy"]')) {
  radio.addEventListener("change", updatePolicy);
}

el("save-policy").addEventListener("click", async event => {
  if (!event.isTrusted) return;
  const mode = document.querySelector('input[name="policy"]:checked')?.value;
  if (mode === "always" && currentMode !== "always" &&
      el("policy-confirm").value.trim() !== "ENABLE") {
    message("policy-message", "输入 ENABLE 后才能启用全局自动批准。", true);
    return;
  }
  const response = await send({type:"WEBMCP_GLOBAL_POLICY_SET",mode});
  if (!response?.ok) {
    message("policy-message", response?.error || "授权规则保存失败", true);
    return;
  }
  currentMode = mode;
  el("policy-confirm").value = "";
  updatePolicy();
  message("policy-message", mode === "always"
    ? "全局自动批准已启用。"
    : "授权规则已保存。");
});

el("save-connection").addEventListener("click", async () => {
  const address = el("bridge-url").value.trim();
  if (!/^http:\/\/127\.0\.0\.1(?::\d+)?\/?$/.test(address) &&
      !/^http:\/\/localhost(?::\d+)?\/?$/.test(address)) {
    message("connection-message", "请输入本机 HTTP 地址，例如 http://127.0.0.1:8790。", true);
    return;
  }
  const patch = {
    bridgeUrl:address.replace(/\/$/,""),
    localToolLabel:el("tool-label").value.trim() || "MioDesk"
  };
  if (el("bridge-token").value) patch.bridgeToken = el("bridge-token").value;
  const response = await send({type:"WEBMCP_CONFIG_SET",config:patch});
  if (!response?.ok) {
    message("connection-message", response?.error || "连接设置保存失败", true);
    return;
  }
  el("bridge-token").value = "";
  message("connection-message", "连接已保存。");
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
  message("behavior-message", response?.ok ? "行为设置已保存。" :
    (response?.error || "行为设置保存失败。"), !response?.ok);
});

async function refreshHealth() {
  const r = await send({type:"WEBMCP_BRIDGE_CHECK"});
  const okay = Boolean(r?.authorized);
  el("connection-status").textContent = okay ? "已连接" : r?.connected ? "待授权" : "未连接";
  el("connection-detail").textContent = okay ? "Bridge 授权正常" :
    !r?.connected ? "检查 Bridge 是否启动" : r?.tokenConfigured ? "检查 Token 是否一致" : "请配置 Bridge Token";
  const tools = Array.isArray(r?.tools) ? r.tools : [];
  el("tool-count").textContent = String(tools.length);
  el("tool-detail").textContent = "由 Bridge 提供";
  const list = el("tools-list");
  list.replaceChildren();
  if (!tools.length) {
    const empty = document.createElement("p");
    empty.className = "support";
    empty.textContent = "暂无可用工具，请连接 Bridge 后刷新。";
    list.append(empty);
  }
  for (const tool of tools) {
    const node = document.createElement("details");
    node.className = "tool";
    const title = document.createElement("summary");
    const strong = document.createElement("strong");
    strong.textContent = tool.name || "unknown";
    const access = document.createElement("small");
    access.textContent = ["status","list","read","search"].includes(tool.name) ? "只读" : "需授权";
    title.append(strong,access);
    const desc = document.createElement("p");
    desc.textContent = tool.description || "未提供说明";
    const schema = document.createElement("pre");
    schema.textContent = JSON.stringify(tool.inputSchema || {},null,2);
    node.append(title,desc,schema);
    list.append(node);
  }
  const summary = {
    bridge:r?.health?.bridge || "MioWeave local bridge",
    endpoint:r?.health?.mcp || "(不可用)",
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
