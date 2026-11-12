const DEFAULTS = {
  bridgeUrl: "http://127.0.0.1:8790",
  bridgeToken: "",
  enabled: true,
  autoRunReadOnly: false,
  autoSendCallbacks: true,
  callbackDelayMs: 1500,
  hideCallbacks: true,
  approvalMode: "ask",
  localToolLabel: "MioDesk"
};

const CONFIG_KEYS = Object.keys(DEFAULTS);

async function config() {
  const value = await chrome.storage.local.get(CONFIG_KEYS);
  return {...DEFAULTS, ...value};
}

async function publicConfig() {
  const value = await config();
  return {
    bridgeUrl: value.bridgeUrl,
    bridgeTokenConfigured: Boolean(value.bridgeToken),
    enabled: value.enabled !== false,
    autoRunReadOnly: Boolean(value.autoRunReadOnly),
    autoSendCallbacks: value.autoSendCallbacks !== false,
    callbackDelayMs: normalizeCallbackDelay(value.callbackDelayMs),
    hideCallbacks: value.hideCallbacks !== false,
    approvalMode: ["ask", "always", "block"].includes(value.approvalMode) ? value.approvalMode : "ask",
    localToolLabel: typeof value.localToolLabel === "string" && value.localToolLabel.trim()
      ? value.localToolLabel.trim().slice(0, 32) : "MioDesk"
  };
}

function normalizeCallbackDelay(value) {
  const delay = Number(value);
  return Number.isFinite(delay) ? Math.max(0, Math.min(10000, Math.round(delay / 100) * 100)) : 1500;
}

async function updateConfig(patch = {}) {
  const next = {};
  if (Object.prototype.hasOwnProperty.call(patch, "callbackDelayMs")) {
    next.callbackDelayMs = normalizeCallbackDelay(patch.callbackDelayMs);
  }
  for (const key of ["bridgeUrl", "enabled", "autoRunReadOnly", "autoSendCallbacks", "hideCallbacks"]) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  if (typeof patch.bridgeToken === "string" && patch.bridgeToken.length > 0) {
    next.bridgeToken = patch.bridgeToken;
  }
  if (typeof patch.localToolLabel === "string") {
    next.localToolLabel = patch.localToolLabel.trim().slice(0, 32) || "MioDesk";
  }
  // Global auto-approval is configured by the extension's own options page,
  // not by DOM-bound messages from a remote chat website.
  if (["ask", "always", "block"].includes(patch.approvalMode)) {
    next.approvalMode = patch.approvalMode;
  }
  await chrome.storage.local.set(next);
  return publicConfig();
}

async function request(path, init = {}) {
  const {bridgeUrl, bridgeToken} = await config();
  if (!bridgeToken) throw new Error("Bridge token is not configured. Open MioWeave settings.");
  const headers = new Headers(init.headers || {});
  headers.set("X-WebMCP-Token", bridgeToken);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(bridgeUrl + path, {...init, headers});
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || `bridge HTTP ${response.status}`);
  return body;
}

async function bridgeCheck() {
  const {bridgeUrl, bridgeToken} = await config();
  let health = null;
  try {
    const response = await fetch(bridgeUrl + "/health");
    health = await response.json();
    if (!response.ok || !health?.ok) throw new Error(health?.error || `bridge HTTP ${response.status}`);
  } catch (error) {
    return {ok:false, connected:false, tokenConfigured:Boolean(bridgeToken), error:String(error?.message || error)};
  }

  if (!bridgeToken) {
    return {ok:true, connected:true, authorized:false, tokenConfigured:false, health, tools:[]};
  }

  try {
    const tools = await request("/tools");
    return {
      ok:true,
      connected:true,
      authorized:true,
      tokenConfigured:true,
      health,
      tools:tools.tools || []
    };
  } catch (error) {
    return {
      ok:false,
      connected:true,
      authorized:false,
      tokenConfigured:true,
      health,
      error:String(error?.message || error),
      tools:[]
    };
  }
}

// Session-only recovery journal. Never persist raw tool outputs in local
// storage. Records are bounded, scoped to one saved DeepSeek chat and expire.
const RECOVERY_PREFIX = "mioweave-recovery-v1:";
const RECOVERY_TTL_MS = 4 * 60 * 60 * 1000;
let recoveryWrites = Promise.resolve();
function allowedRecoverySender(sender) {
  return sender?.id === chrome.runtime.id &&
    /^https:\/\/chat\.deepseek\.com\//.test(sender.url || "");
}
function recoveryKey(chatId) {
  return typeof chatId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(chatId)
    ? RECOVERY_PREFIX + chatId : null;
}
async function loadRecovery(chatId) {
  const key = recoveryKey(chatId);
  if (!key || !chrome.storage.session) return {};
  const entries = (await chrome.storage.session.get(key))[key] || {};
  const now = Date.now();
  return Object.fromEntries(Object.entries(entries).filter(([,entry]) =>
    entry && typeof entry === "object" &&
    Number.isFinite(entry.at) && now - entry.at >= 0 && now - entry.at < RECOVERY_TTL_MS));
}
async function saveRecovery(chatId, callId, record) {
  const key = recoveryKey(chatId);
  if (!key || !/^[a-zA-Z0-9_:-]{1,150}$/.test(String(callId)) ||
      !record || !["running", "result-ready", "continuing", "submitted", "sent"].includes(record.phase) ||
      !chrome.storage.session || JSON.stringify(record).length > 27000) return false;
  // Serialize read/modify/write to prevent concurrent tool completions from
  // overwriting each other's journal entries in the service worker.
  const existing = await loadRecovery(chatId);
  existing[callId] = {...record,at:Date.now()};
  const ids = Object.keys(existing);
  if (ids.length > 64) {
    ids.sort((a,b) => existing[a].at - existing[b].at);
    for (const id of ids.slice(0, ids.length - 64)) delete existing[id];
  }
  await chrome.storage.session.set({[key]:existing});
  return true;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "WEBMCP_RECOVERY_LOAD") {
    if (!allowedRecoverySender(_sender)) {
      sendResponse({ok:false,error:"Recovery journal requires the trusted chat content script."});
      return false;
    }
    recoveryWrites.then(() => loadRecovery(message.chatId))
      .then(records => sendResponse({ok:true,records}),
        error => sendResponse({ok:false,error:String(error?.message || error)}));
    return true;
  }
  if (message?.type === "WEBMCP_RECOVERY_SAVE") {
    if (!allowedRecoverySender(_sender)) {
      sendResponse({ok:false,error:"Recovery journal requires the trusted chat content script."});
      return false;
    }
    const write = recoveryWrites.then(() => saveRecovery(message.chatId, message.callId, message.record));
    recoveryWrites = write.catch(() => {});
    write.then(saved => sendResponse({ok:saved}),
      error => sendResponse({ok:false,error:String(error?.message || error)}));
    return true;
  }
  if (message?.type === "WEBMCP_CALL") {
    (async () => {
      const c = await publicConfig();
      if (c.approvalMode === "block" &&
          !["status", "list", "read", "search"].includes(message.tool)) {
        return {ok:false,error:"Privileged tools blocked by MioWeave global policy."};
      }
      return request("/call", {
        method:"POST",
        body:JSON.stringify({tool:message.tool,arguments:message.arguments || {}})
      });
    })().then(sendResponse, error =>
      sendResponse({ok:false,error:String(error?.message || error)}));
    return true;
  }

  if (message?.type === "WEBMCP_TOOLS") {
    request("/tools").then(sendResponse, error => sendResponse({ok:false,error:String(error?.message || error)}));
    return true;
  }

  if (message?.type === "WEBMCP_CONFIG_GET") {
    publicConfig().then(value => sendResponse({ok:true, config:value}), error => {
      sendResponse({ok:false,error:String(error?.message || error)});
    });
    return true;
  }

  if (message?.type === "WEBMCP_CONFIG_SET") {
    const patch = {...(message.config || {})};
    // The content script does not get to persist a global permission change.
    delete patch.approvalMode;
    updateConfig(patch).then(value => sendResponse({ok:true, config:value}), error => {
      sendResponse({ok:false,error:String(error?.message || error)});
    });
    return true;
  }

  if (message?.type === "WEBMCP_GLOBAL_POLICY_SET") {
    // A fragment stays in the same options document; a query or other path does not.
    const allowedSender = _sender.id === chrome.runtime.id &&
      _sender.url?.split("#", 1)[0] === chrome.runtime.getURL("options.html");
    if (!allowedSender || !["ask", "always", "block"].includes(message.mode)) {
      sendResponse({ok:false,error:"Global policy can only be changed in MioWeave extension settings."});
      return false;
    }
    updateConfig({approvalMode:message.mode})
      .then(value => sendResponse({ok:true,config:value}),
        error => sendResponse({ok:false,error:String(error?.message || error)}));
    return true;
  }

  if (message?.type === "WEBMCP_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage().then(() => sendResponse({ok:true}), error =>
      sendResponse({ok:false,error:String(error?.message || error)}));
    return true;
  }

  if (message?.type === "WEBMCP_BRIDGE_CHECK") {
    bridgeCheck().then(sendResponse, error => sendResponse({ok:false,error:String(error?.message || error)}));
    return true;
  }
});
