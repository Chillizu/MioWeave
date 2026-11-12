const CALL_OPEN = "[[WEBMCP_CALL]]";
const CALL_CLOSE = "[[/WEBMCP_CALL]]";
const RESULT_OPEN = "[[WEBMCP_RESULT]]";
const RESULT_CLOSE = "[[/WEBMCP_RESULT]]";
const INIT_OPEN = "[[WEBMCP_INIT]]";
const INIT_CLOSE = "[[/WEBMCP_INIT]]";
const INIT_STORAGE_KEY = "webmcpDeepSeekInitializedChatsV1";
const BOOTSTRAP_REVISION = "fenced-json-diagnostics-1";
const NEW_CHAT_APPROVAL_SCOPE = "__new_chat__";

const callStates = new Map();
const callMetas = new Map();
const activeToolCalls = new Map();

const state = {
  enabled: true,
  autoRunReadOnly: false,
  // Ephemeral, chat-scoped: never persisted to extension storage.
  autoApproveAny: false,
  approvalMode: "ask",
  localToolLabel: "MioDesk",
  autoApproveChatId: "",
  autoApproveDraftSendPending: false,
  approvalNotice: "",
  autoSendCallbacks: true,
  callbackDelayMs: 1500,
  hideCallbacks: true,
  connected: false,
  authorized: false,
  tokenConfigured: false,
  tools: [],
  panelOpen: false,
  chatReady: false,
  pendingInitFingerprint: "",
  lastHref: location.href,
  lastChatId: currentChatId(),
  bypassNextSend: false,
  contextInvalidated: false,
  recoveryReady: false
};

let runtimeObserver = null;
const hostThemeAncestors = new Set([document.documentElement, document.body]);

function extensionContextAlive() {
  try {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function isContextInvalidatedError(error) {
  const message = String(error?.message || error || "");
  return /Extension context invalidated|context invalidated/i.test(message);
}

function renderInvalidatedControls() {
  document.querySelector(".webmcp-panel")?.remove();
  state.panelOpen = false;

  const current = document.querySelector(".webmcp-controls");
  if (!current) return;

  const stale = document.createElement("div");
  stale.className = "webmcp-controls webmcp-controls--invalidated";

  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "webmcp-reload-page";
  reload.title = "The extension was reloaded. Refresh DeepSeek to reconnect WebMCP.";
  reload.innerHTML = '<span class="webmcp-toggle__status webmcp-toggle__status--warn"></span><span>WebMCP · Reload page</span>';
  reload.addEventListener("click", () => location.reload());

  stale.appendChild(reload);
  current.replaceWith(stale);
}

function invalidateExtensionContext(error) {
  if (state.contextInvalidated) return;
  state.contextInvalidated = true;
  state.connected = false;
  state.authorized = false;
  state.chatReady = false;

  if (mutationFlushTimer) {
    clearTimeout(mutationFlushTimer);
    mutationFlushTimer = 0;
  }
  pendingMutationNodes.clear();
  runtimeObserver?.disconnect();
  runtimeObserver = null;

  document.removeEventListener("pointerdown", onDocumentPointer, true);
  document.removeEventListener("click", interceptSend, true);
  document.removeEventListener("keydown", interceptSend, true);
  window.removeEventListener("resize", onWindowResize);

  renderInvalidatedControls();
  console.info("[WebMCP] Extension was reloaded; refresh this DeepSeek tab to reconnect.", error || "");
}

async function runtimeMessage(message) {
  if (state.contextInvalidated) return null;
  if (!extensionContextAlive()) {
    invalidateExtensionContext(new Error("Extension context invalidated."));
    return null;
  }

  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (isContextInvalidatedError(error) || !extensionContextAlive()) {
      invalidateExtensionContext(error);
      return null;
    }
    return {ok:false, error:String(error?.message || error)};
  }
}

async function storageGet(keys) {
  if (state.contextInvalidated) return null;
  if (!extensionContextAlive()) {
    invalidateExtensionContext(new Error("Extension context invalidated."));
    return null;
  }

  try {
    return await chrome.storage.local.get(keys);
  } catch (error) {
    if (isContextInvalidatedError(error) || !extensionContextAlive()) {
      invalidateExtensionContext(error);
      return null;
    }
    console.warn("[WebMCP] storage read failed:", error);
    return null;
  }
}

async function storageSet(patch) {
  if (state.contextInvalidated) return false;
  if (!extensionContextAlive()) {
    invalidateExtensionContext(new Error("Extension context invalidated."));
    return false;
  }

  try {
    await chrome.storage.local.set(patch);
    return true;
  } catch (error) {
    if (isContextInvalidatedError(error) || !extensionContextAlive()) {
      invalidateExtensionContext(error);
      return false;
    }
    console.warn("[WebMCP] storage write failed:", error);
    return false;
  }
}

function composer() {
  return document.querySelector('textarea[placeholder="Message DeepSeek"]');
}

function setComposerText(text) {
  const textarea = composer();
  if (!textarea) throw new Error("DeepSeek composer not found");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("textarea value setter unavailable");
  setter.call(textarea, text);
  textarea.dispatchEvent(new Event("input", {bubbles:true}));
  textarea.focus();
}

function currentChatId() {
  return location.pathname.match(/\/a\/chat\/s\/([^/?#]+)/)?.[1] || "";
}

function approvalScope() {
  return currentChatId() || NEW_CHAT_APPROVAL_SCOPE;
}

function hashText(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function toolFingerprint() {
  const normalized = [...state.tools]
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map(tool => ({
      name: tool.name,
      inputSchema: tool.inputSchema || {},
      readOnly: Boolean(tool.annotations?.readOnlyHint)
    }));
  return hashText(BOOTSTRAP_REVISION + JSON.stringify(normalized));
}

async function initializedChats() {
  const stored = await storageGet(INIT_STORAGE_KEY);
  if (!stored) return {};
  return stored[INIT_STORAGE_KEY] && typeof stored[INIT_STORAGE_KEY] === "object"
    ? stored[INIT_STORAGE_KEY]
    : {};
}

async function saveChatInitialized(chatId, fingerprint = toolFingerprint()) {
  if (!chatId || !fingerprint) return;
  const chats = await initializedChats();
  chats[chatId] = fingerprint;
  const ids = Object.keys(chats);
  if (ids.length > 100) {
    for (const id of ids.slice(0, ids.length - 100)) delete chats[id];
  }
  await storageSet({[INIT_STORAGE_KEY]: chats});
}

async function clearChatInitialized(chatId = currentChatId()) {
  if (chatId) {
    const chats = await initializedChats();
    delete chats[chatId];
    await storageSet({[INIT_STORAGE_KEY]: chats});
  }
  state.chatReady = false;
  state.pendingInitFingerprint = "";
  refreshUi();
}

async function refreshChatReady() {
  if (!state.enabled || !state.authorized || !state.tools.length) {
    state.chatReady = false;
    refreshUi();
    return false;
  }
  const chatId = currentChatId();
  if (!chatId) {
    state.chatReady = Boolean(state.pendingInitFingerprint);
    refreshUi();
    return state.chatReady;
  }
  const chats = await initializedChats();
  state.chatReady = chats[chatId] === toolFingerprint();
  refreshUi();
  return state.chatReady;
}

function parseBlock(text, open, close, from = 0) {
  const start = text.indexOf(open, from);
  if (start < 0) return null;

  let cursor = start + open.length;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  const jsonStart = cursor;

  const opener = text[cursor];
  if (opener !== "{" && opener !== "[") return null;

  const stack = [];
  let inString = false;
  let escaped = false;
  let jsonEnd = -1;

  for (; cursor < text.length; cursor += 1) {
    const ch = text[cursor];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }

    if (ch === "}" || ch === "]") {
      const expected = ch === "}" ? "{" : "[";
      if (stack.pop() !== expected) return null;
      if (!stack.length) {
        jsonEnd = cursor + 1;
        break;
      }
    }
  }

  if (jsonEnd < 0 || inString || stack.length) return null;

  let closeStart = jsonEnd;
  while (closeStart < text.length && /\s/.test(text[closeStart])) closeStart += 1;
  if (!text.startsWith(close, closeStart)) return null;

  try {
    return {
      value:JSON.parse(text.slice(jsonStart, jsonEnd)),
      start,
      end:closeStart + close.length
    };
  } catch {
    return null;
  }
}

function explainMalformedCall(text) {
  const start = text.indexOf(CALL_OPEN);
  if (start < 0) return "Tool call marker is missing.";
  const end = text.indexOf(CALL_CLOSE, start + CALL_OPEN.length);
  if (end < 0) return "Tool call is incomplete; closing marker missing.";
  const raw = text.slice(start + CALL_OPEN.length, end).trim();
  if (!raw) return "Tool call JSON is empty.";
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "Tool request must be a JSON object.";
    }
    if (typeof parsed.id !== "string" || !parsed.id ||
        typeof parsed.tool !== "string" || !parsed.tool) {
      return 'Missing or invalid "id" or "tool" field.';
    }
    if (parsed.arguments != null &&
        (typeof parsed.arguments !== "object" || Array.isArray(parsed.arguments))) {
      return '"arguments" must be a JSON object.';
    }
    return "Invalid WebMCP tool request; verify call markers and unique id.";
  } catch (error) {
    if (/"chars"\s*:\s*"[^"\n]*"[^,}\s\n]/.test(raw)) {
      return 'Invalid JSON in "chars": inner double quotes must be escaped as \\". Consider using shell single quotes inside JSON.';
    }
    const message = String(error?.message || error)
      .replace(/^SyntaxError:\s*/i, "")
      .replace(/\s+/g, " ")
      .slice(0, 180);
    return `Invalid JSON: ${message}`;
  }
}

function parseCalls(text) {
  const calls = [];
  const ids = new Set();
  let cursor = 0;
  while (text.indexOf(CALL_OPEN, cursor) >= 0) {
    if (calls.length >= 12) return {error:"Maximum 12 tool calls per assistant reply."};
    const parsed = parseBlock(text, CALL_OPEN, CALL_CLOSE, cursor);
    const call = parsed?.value;
    if (!parsed || !call || Array.isArray(call) || typeof call !== "object" ||
        typeof call.id !== "string" || !call.id ||
        typeof call.tool !== "string" || !call.tool ||
        (call.arguments != null && (typeof call.arguments !== "object" || Array.isArray(call.arguments)))) {
      return {error:explainMalformedCall(text.slice(cursor))};
    }
    if (ids.has(call.id)) return {error:`Duplicate tool call ID ${call.id}.`};
    ids.add(call.id);
    calls.push({...parsed, call});
    cursor = parsed.end;
  }
  return {calls};
}

function parseCall(text) {
  const parsed = parseCalls(text);
  return parsed.calls?.[0] || null;
}

function markerBlockFromTextNode(node, open, close) {
  if (!(node instanceof Text) || !node.nodeValue?.includes(open)) return null;

  let element = node.parentElement;
  if (!element || element.closest(".ds-think-content, .ds-markdown")) return null;

  const virtualList = element.closest(".ds-virtual-list-visible-items");
  for (let depth = 0;
       element && element !== document.body && element !== virtualList && depth < 10;
       depth += 1, element = element.parentElement) {
    const text = element.textContent || "";
    if (text.includes(open) && text.includes(close)) return element;

    // Never join an open marker in one message with a close marker from a later
    // message. This is especially important because the init bootstrap mentions
    // RESULT_OPEN as documentation.
    if (element.matches(".ds-message, [data-virtual-list-item-key]")) break;
  }
  return null;
}

function markerElements(open, close) {
  if (!document.body) return [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const found = new Set();
  let node;

  while ((node = walker.nextNode())) {
    const element = markerBlockFromTextNode(node, open, close);
    if (element) found.add(element);
  }

  return [...found];
}

// Browser callbacks must have a substantially smaller budget than local MCP
// output. MioDesk can correctly capture a full 1 MiB, but DeepSeek's ordinary
// composer is not a bulk-data transport. All sizes are in JS code units.
const SINGLE_CALLBACK_BUDGET = 8 * 1024;
const BATCH_CALLBACK_BUDGET = 24 * 1024;

function compactResult(value, budget = SINGLE_CALLBACK_BUDGET) {
  const serialized = JSON.stringify(value) ?? "null";
  if (serialized.length <= budget) return value;
  const data = value?.structuredContent ?? value;
  const metadata = {};
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const key of ["kind", "path", "exit_code", "session_id", "wall_time_seconds",
      "applied", "truncated", "diff_truncated", "isError"]) {
      if (typeof data[key] === "number" || typeof data[key] === "boolean" ||
          (typeof data[key] === "string" && data[key].length <= 180)) {
        metadata[key] = data[key];
      }
    }
  }
  const cap = Math.max(80, budget - JSON.stringify(metadata).length - 300);
  return {
    mioweave_truncated:true,
    original_chars:serialized.length,
    preview:serialized.slice(0, cap),
    metadata,
    note:"Output shortened for the DeepSeek chat. The full local tool response is not included here; request a narrower read/search or smaller command output if details are needed."
  };
}

function callbackEnvelope(call, response) {
  if (response?.ok === false) {
    return {id:call.id, tool:call.tool, ok:false,
      error:String(response.error || "tool failed").slice(0, SINGLE_CALLBACK_BUDGET)};
  }
  if (call.tool === "webmcp.batch" && Array.isArray(response?.result?.calls)) {
    const original = response.result.calls;
    let perCall = Math.min(SINGLE_CALLBACK_BUDGET,
      Math.max(512, Math.floor((BATCH_CALLBACK_BUDGET - 2200) / original.length)));
    let envelope;
    do {
      const calls = original.map(entry => ({id:entry.id, tool:entry.tool,
        ok:entry.ok !== false,
        ...(entry.ok === false
          ? {error:compactResult(String(entry.error || "tool failed"), perCall)}
          : {result:compactResult(entry.result, perCall)})}));
      envelope = {id:call.id,tool:call.tool,ok:true,
        result:{calls,allOk:calls.every(entry => entry.ok)}};
      if (JSON.stringify(envelope).length <= BATCH_CALLBACK_BUDGET || perCall <= 256) break;
      perCall = Math.max(256, Math.floor(perCall * .7));
    } while (true);
    return envelope;
  }
  return {id:call.id,tool:call.tool,ok:true,
    result:compactResult(response?.result ?? response)};
}

function resultText(call, response) {
  const payload = callbackEnvelope(call, response);
  return [RESULT_OPEN, JSON.stringify(payload), RESULT_CLOSE, "",
    "Continue the previous task using this tool result."].join("\n");
}

function toolMeta(name) {
  return state.tools.find(tool => tool.name === name);
}

function isReadOnlyTool(name) {
  // Never infer privilege from untrusted model-supplied metadata or tool names
  // not present in the hard-coded readonly allowlist.
  return ["status", "list", "read", "search"].includes(name) &&
    toolMeta(name)?.annotations?.readOnlyHint !== false;
}

function autoApproveActive() {
  if (!state.enabled || !state.authorized || state.approvalMode === "block") return false;
  if (state.approvalMode === "always") return true;
  return Boolean(state.autoApproveAny && state.autoApproveChatId &&
    state.autoApproveChatId === approvalScope());
}

function revokeAutoApprove() {
  state.autoApproveAny = false;
  state.autoApproveChatId = "";
  state.autoApproveDraftSendPending = false;
  refreshAutoApproveUi();
}

function refreshAutoApproveUi() {
  const panel = document.querySelector(".webmcp-panel");
  const control = panel?.querySelector(".webmcp-auto-approve-any");
  if (!control) return;
  const active = autoApproveActive();
  control.classList.toggle("webmcp-auto-approve-any--active", active);
  const button = control.querySelector(".webmcp-auto-approve-button");
  const globalMode = state.approvalMode === "always";
  const blocked = state.approvalMode === "block";
  const title = control.querySelector(".webmcp-access-title");
  const description = control.querySelector(".webmcp-access-detail");
  const status = control.querySelector(".webmcp-access-status");
  if (title) title.textContent = blocked ? "高权限工具已禁止" :
    globalMode ? "全局自动批准" :
      active ? "已临时允许当前聊天" : "高权限操作逐次确认";
  if (description) description.textContent = blocked
    ? "命令执行、文件修改与删除已禁止。"
    : globalMode
      ? "已授权聊天可直接执行命令、修改或删除文件。"
      : state.approvalNotice && !active
        ? state.approvalNotice
        : active
          ? "命令执行、文件修改和删除无需逐次确认。"
          : "执行命令、修改或删除文件前需确认。";
  control.classList.toggle("webmcp-access-error", Boolean(state.approvalNotice && !active));
  if (status) status.textContent = blocked ? "全局" : globalMode ? "全局" : active ? "临时" : "默认";
  const scope = control.querySelector(".webmcp-access-footer small");
  if (scope) scope.textContent = blocked ? "只读工具不受影响" :
    globalMode ? "所有聊天 · 持续保存" : active ? "切换聊天或刷新后失效" : "可临时允许当前聊天";
  if (button) {
    button.textContent = blocked || globalMode ? "管理授权" : active ? "撤销授权" : "临时允许";
    button.classList.toggle("webmcp-access-disable", active);
    if (blocked || globalMode) button.removeAttribute("aria-pressed");
    else button.setAttribute("aria-pressed", String(active));
    button.disabled = false;
  }
}

function summarizeResult(response) {
  if (response?.ok === false) return response.error || "Tool call failed";
  const value = response?.result?.structuredContent ?? response?.result ?? response;
  if (value && typeof value === "object") {
    if (value.kind === "status") {
      return [value.name, value.version, value.platform].filter(Boolean).join(" · ");
    }
    if (value.path && typeof value.content === "string") {
      return `${value.path} · ${value.content.length} chars`;
    }
    if (Array.isArray(value.entries)) return `${value.entries.length} entries`;
    if (Array.isArray(value.results)) return `${value.results.length} results`;
  }
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const text = typeof serialized === "string" ? serialized : "No result data";
  return text.length > 180 ? text.slice(0, 177) + "…" : text;
}

function formatArguments(args = {}) {
  const entries = Object.entries(args);
  if (!entries.length) return "";
  return entries.map(([key, value]) => {
    const encoded = JSON.stringify(value);
    return `${key}: ${encoded === undefined ? String(value) : encoded}`;
  }).join(" · ");
}

function findCards(callId) {
  const id = String(callId);
  return [...document.querySelectorAll(".webmcp-card")]
    .filter(card => card.dataset.webmcpId === id);
}

function findCard(callId) {
  return findCards(callId)[0] || null;
}

function callViewFromCard(card) {
  const view = card?.closest(".webmcp-call-view");
  return view instanceof HTMLElement ? view : null;
}

function callOwnerFromCard(card) {
  return callViewFromCard(card)?.previousElementSibling || card?.previousElementSibling || null;
}

function removeCallCard(card) {
  const row = card?.closest(".ds-message")?.parentElement;
  row?.classList.remove("webmcp-tool-only-row", "webmcp-tool-action-row");
  const view = callViewFromCard(card);
  if (view?.classList.contains("webmcp-batch-view")) {
    card?.remove();
    if (!view.querySelector(".webmcp-card")) view.remove();
  } else if (view) view.remove();
  else card?.remove();
}

function removeDuplicateCards(callId, keep = null) {
  for (const card of findCards(callId)) {
    if (card !== keep) removeCallCard(card);
  }
}

// Journal only a bounded projection of tool results, never the full local
// output. It lasts for this browser session, not across browser restarts.
function savedPayload(payload) {
  if (!payload) return null;
  if (payload.ok === false) return {ok:false,error:String(payload.error || "Tool error").slice(0, SINGLE_CALLBACK_BUDGET)};
  return {ok:true,result:compactResult(payload.result ?? payload, SINGLE_CALLBACK_BUDGET)};
}

function registerCallMeta(call) {
  const id = String(call.id);
  const incoming = {tool:call.tool,
    argsHash:hashText(JSON.stringify(call.arguments || {}))};
  const previous = callMetas.get(id);
  // Call IDs are single-use within one conversation. Silently changing a
  // previous ID's tool/arguments breaks idempotency and could mix results.
  if (previous && (previous.tool !== incoming.tool ||
                   previous.argsHash !== incoming.argsHash)) return false;
  if (!previous) callMetas.set(id,incoming);
  return true;
}

function markCallIdConflict(card) {
  if (!card) return;
  card.dataset.webmcpPhase = "collision";
  const label = card.querySelector(".webmcp-state");
  if (label) label.textContent = "Call ID reused · different request";
  const run = card.querySelector(".webmcp-run");
  if (run) {
    run.disabled = true;
    run.textContent = "Blocked";
  }
}

// Memory updates are immediate for UI state. For privileged tools, the
// initial "running" record MUST be durably acknowledged before dispatching
// to the local bridge; otherwise a refresh can forget an already-started edit.
function rememberCallState(callId, phase, payload = null, {requireAck = false} = {}) {
  const id = String(callId);
  const previous = callStates.get(id);
  if (previous?.phase === "sent" && phase !== "sent") return Promise.resolve(!requireAck);
  const meta = callMetas.get(id);
  const record = {phase,payload,...(meta || {})};
  callStates.set(id, record);
  const chatId = currentChatId();
  if (!chatId || !meta || state.contextInvalidated) {
    if (requireAck && callStates.get(id) === record) callStates.delete(id);
    return Promise.resolve(!requireAck);
  }
  const save = runtimeMessage({type:"WEBMCP_RECOVERY_SAVE",chatId,callId:id,
    record:{...meta,phase,payload:savedPayload(payload)}})
    .then(response => Boolean(response?.ok), () => false);
  if (!requireAck) return save;
  return save.then(ok => {
    if (!ok && callStates.get(id) === record) callStates.delete(id);
    return ok;
  });
}

async function loadRecoveryState(chatId = currentChatId()) {
  if (!chatId) return;
  const result = await runtimeMessage({type:"WEBMCP_RECOVERY_LOAD",chatId});
  if (currentChatId() !== chatId || !result?.ok) return;
  for (const [id,record] of Object.entries(result.records || {})) {
    if (!record || !["running","result-ready","continuing","submitted","sent"].includes(record.phase)) continue;
    if (typeof record.tool !== "string" || typeof record.argsHash !== "string") continue;
    callStates.set(id,{phase:record.phase,payload:record.payload,
      tool:record.tool,argsHash:record.argsHash});
  }
}

function restoreCardState(card, callId) {
  const remembered = callStates.get(String(callId));
  if (!remembered) return false;
  const meta = callMetas.get(String(callId));
  if (remembered.argsHash && (!meta || meta.argsHash !== remembered.argsHash ||
      remembered.tool !== meta.tool)) {
    markCallIdConflict(card);
    return true;
  }

  card.dataset.webmcpPhase = remembered.phase;
  card._webmcpPayload = remembered.payload;
  if (remembered.payload) {
    applyResultToCard(card, remembered.payload, {sent:remembered.phase === "sent"});
    if (remembered.phase === "submitted" || remembered.phase === "continuing") {
      // The composer may have been consumed immediately before a crash.
      // Reconcile a receipt, but never automatically send this callback twice.
      markSubmitted(card);
      if (remembered.phase === "continuing") {
        card.querySelector(".webmcp-state").textContent = "Callback uncertain · check receipt";
      }
    }
  } else if (remembered.phase === "running") {
    // The old page may have disappeared while a side-effecting tool was
    // running. We do not know whether it completed; never silently rerun it.
    card.dataset.webmcpPhase = "unknown";
    card.querySelector(".webmcp-state").textContent = "Execution uncertain · inspect manually";
    card.querySelector(".webmcp-run").disabled = true;
  }
  return true;
}

function reconcileToolOnlyActionRow(card) {
  const row = card?.closest(".ds-message")?.parentElement;
  if (!row) return;
  // The native copy/retry/reaction strip sits in a 50px flex row even for
  // tool results. Keep it accessible on hover, but out of normal layout so
  // the next Thought follows the card/prose naturally.
  row.classList.toggle("webmcp-tool-action-row",
    card.dataset.webmcpPhase === "sent");
  row.classList.remove("webmcp-tool-only-row");
}

function applyResultToCard(card, payload, {sent = false} = {}) {
  if (!card) return;
  const ok = payload?.ok !== false;
  const stateEl = card.querySelector(".webmcp-state");
  const resultEl = card.querySelector(".webmcp-result");
  const actions = card.querySelector(".webmcp-actions");

  card.classList.toggle("webmcp-card--failed", !ok);
  card.classList.toggle("webmcp-card--done", ok);
  card.classList.toggle("webmcp-card--sent", Boolean(sent));
  if (stateEl) stateEl.textContent = sent ? (ok ? "Sent" : "Error sent") : (ok ? "Done" : "Failed");
  if (resultEl) {
    resultEl.textContent = summarizeResult(payload);
    resultEl.hidden = false;
  }
  if (actions && sent) actions.hidden = true;
  if (sent) card.dataset.webmcpPhase = "sent";
  reconcileToolOnlyActionRow(card);
}

// "Sent" means a matching result is present in the rendered chat, not
// merely that DeepSeek cleared the input. A cleared input can still precede
// server rejection, route changes or a UI race on very large messages.
// A fallback .ds-message can include native Copy/Edit action text *after* the
// actual callback. Only the message body participates in protocol parsing.
// Do not remove those buttons or rewrite React-owned source DOM.
function callbackSurfaceText(body) {
  if (!(body instanceof Element)) return "";
  // The native user-bubble Copy/Edit controls are sometimes siblings of the
  // text, but occasionally sit inside the same wrapper. Neither is protocol.
  if (!body.querySelector("button, [role=button], .webmcp-call-view, .webmcp-card")) {
    return (body.textContent || "").trim();
  }
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const chunks = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest("button, [role=button], .webmcp-call-view, .webmcp-card")) continue;
    chunks.push(node.nodeValue || "");
  }
  return chunks.join("").trim();
}

// DeepSeek sometimes renders user bubbles as Markdown instead of the older
// .ds-collapsible-text component. Identify callback-bearing message bodies in
// either layout, never by matching arbitrary protocol text elsewhere on page.
function callbackBodies(root = document) {
  const nodes = [];
  if (root instanceof Element && root.matches(".ds-message, .ds-collapsible-text, .ds-markdown")) nodes.push(root);
  if (root.querySelectorAll) {
    nodes.push(...root.querySelectorAll(".ds-message .ds-collapsible-text, .ds-message .ds-markdown, .ds-message"));
  }
  const found = new Set();
  for (const node of nodes) {
    const msg = node.matches(".ds-message") ? node : node.closest(".ds-message");
    if (!msg || msg.closest(".ds-think-content, .webmcp-call-view, .webmcp-panel")) continue;
    // Prefer the deepest callback-bearing body. A parent message can also
    // contain copy/edit buttons, tool cards, or surrounding discussion.
    const text = callbackSurfaceText(node);
    if (!text.startsWith(RESULT_OPEN)) continue;
    if (node !== msg && node.parentElement?.closest(".ds-markdown") &&
        !node.matches(".ds-markdown")) continue;
    if (node === msg && [...msg.querySelectorAll(".ds-collapsible-text, .ds-markdown")]
        .some(inner => (inner.textContent || "").trim().startsWith(RESULT_OPEN))) continue;
    found.add(node);
  }

  // Marker-anchored fallback for DeepSeek releases that no longer use any of
  // the ds-message/ds-collapsible-text classes. Find the smallest self-contained
  // callback envelope, bounded by a virtual-list item or message container.
  // Every unknown-layout match must also correspond to a registered call.
  const scope = root instanceof Document ? root.body : root;
  if (scope) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (!textNode.nodeValue?.includes(RESULT_OPEN)) continue;
      const first = textNode.parentElement;
      if (!first || first.closest(".ds-think-content, .webmcp-call-view, .webmcp-card, .webmcp-panel, pre, code, textarea")) continue;
      // Prefer the native known-layout body when present. Processing its
      // parent as a second callback can hide an unrelated sibling toolbar.
      if ([...found].some(candidate => candidate.contains(first) || first.contains(candidate))) continue;
      const boundary = first.closest("[data-virtual-list-item-key], [data-message-id], .ds-message");
      let element = first;
      let best = null;
      let firstMatchDepth = -1;
      for (let depth = 0; element && element !== document.body && depth < 11; depth++, element = element.parentElement) {
        if (element.matches("main, article, [role=main], #messages, #conversation")) break;
        // Without a known message/virtual-list boundary, only promote one
        // wrapper beyond the matching content. Otherwise a one-message chat
        // could accidentally have its entire transcript root hidden.
        if (!boundary && firstMatchDepth >= 0 && depth > firstMatchDepth + 1) break;
        const value = callbackSurfaceText(element);
        if (!value.startsWith(RESULT_OPEN)) break;
        if (callbackMatch(element) || ownedCollapsedCallback(value)) {
          if (firstMatchDepth < 0) firstMatchDepth = depth;
          best = element;
        }
        if (element === boundary) break;
      }
      if (best) found.add(best);
    }
  }
  return [...found];
}

function callbackMatch(body) {
  const text = callbackSurfaceText(body);
  if (!text.startsWith(RESULT_OPEN)) return null;
  const parsed = parseBlock(text, RESULT_OPEN, RESULT_CLOSE);
  const suffix = parsed ? text.slice(parsed.end).trim() : null;
  if (!parsed || (suffix !== "" && suffix !== "Continue the previous task using this tool result.")) return null;
  const result = parsed.value;
  if (!result || Array.isArray(result) || typeof result !== "object" ||
      typeof result.id !== "string" || typeof result.tool !== "string" ||
      typeof result.ok !== "boolean") return null;
  const known = callMetas.get(result.id);
  // Markdown and unrecognized wrappers are also used for assistant
  // responses. Only process them when this call ID/tool was registered here.
  if (!body.matches(".ds-collapsible-text") &&
      (!known || known.tool !== result.tool)) return null;
  return {text, result};
}

function visibleCallbackReceipt(call) {
  for (const body of callbackBodies()) {
    const match = callbackMatch(body);
    if (!match || match.result.id !== call.id || match.result.tool !== call.tool) continue;
    processCallbackLeaf(body);
    return true;
  }
  return callStates.get(String(call.id))?.phase === "sent";
}

async function awaitCallbackReceipt(call, ms = 6000) {
  for (let i = 0; i < Math.ceil(ms / 160); i += 1) {
    if (visibleCallbackReceipt(call)) return true;
    await waitForCallback(160);
  }
  return visibleCallbackReceipt(call);
}

function markSubmitted(card) {
  card.dataset.webmcpPhase = "submitted";
  card.classList.remove("webmcp-card--continuing");
  const status = card.querySelector(".webmcp-state");
  if (status) status.textContent = "Submitted · receipt unverified";
  const actions = card.querySelector(".webmcp-actions");
  if (actions && !card.closest(".webmcp-batch-view")) actions.hidden = false;
  const button = card.querySelector(".webmcp-run");
  if (button) {
    button.disabled = false;
    button.textContent = "Check receipt";
  }
  const group = card.closest(".webmcp-batch-view");
  if (group) {
    const controls = group.querySelector(".webmcp-batch-actions");
    if (controls) controls.hidden = false;
    const control = controls?.querySelector("button");
    if (control) {control.disabled = false;control.textContent = "Check receipt";}
  }
}

async function checkCallbackReceipt(call, card) {
  if (visibleCallbackReceipt(call)) return true;
  const status = card?.querySelector(".webmcp-state");
  if (status) status.textContent = "Unverified · check chat before resending";
  return false;
}

let callbackSendChain = Promise.resolve();
let lastCallbackSentAt = 0;

function waitForCallback(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function queueAutoCallback(call, card, payload, extraCards = []) {
  const origin = approvalScope();
  const process = async () => {
    if (!card.isConnected || !state.enabled || state.contextInvalidated ||
        approvalScope() !== origin) return false;

    const interval = Math.max(0, Math.min(10000, Number(state.callbackDelayMs) || 0));
    const wait = Math.max(interval, lastCallbackSentAt + interval - Date.now());
    if (wait) await waitForCallback(wait);
    if (!card.isConnected || state.contextInvalidated || !state.enabled ||
        approvalScope() !== origin) return false;

    // Never automatically retry a callback that may have been accepted.
    if (["continuing", "submitted"].includes(callStates.get(String(call.id))?.phase)) {
      return checkCallbackReceipt(call, card);
    }
    const textarea = composer();
    const expected = resultText(call, payload);
    if (!textarea || (textarea.value.trim() && textarea.value.trim() !== expected.trim())) {
      const stateEl = card.querySelector(".webmcp-state");
      if (stateEl) stateEl.textContent = "Draft in use · Continue manually";
      const actions = card.querySelector(".webmcp-actions");
      if (actions) actions.hidden = false;
      const button = card.querySelector(".webmcp-run");
      if (button) {
        button.disabled = false;
        button.textContent = "Continue";
      }
      return false;
    }

    if (!textarea.value.trim()) setComposerText(expected);
    const sent = await sendPreparedCallback(call, card, payload);
    if (sent) {
      lastCallbackSentAt = Date.now();
      for (const {call:one, card:other, onePayload} of extraCards) {
        if (!other?.isConnected) continue;
        try {
          rememberCallState(one.id, "sent", onePayload);
          applyResultToCard(other, onePayload, {sent:true});
        } catch (error) {
          // Callback transport already succeeded. A cosmetic card-render
          // failure must not misreport delivery or invite duplicate sends.
          console.warn("[MioWeave] Callback sent; tool card update failed.", error);
        }
      }
    }
    return sent;
  };
  const task = callbackSendChain.then(process).catch(error => {
    console.warn("[WebMCP] Callback not sent; manual retry available.", error);
    const stateEl = card.querySelector(".webmcp-state");
    if (stateEl) stateEl.textContent = "Callback paused · Continue manually";
    const actions = card.querySelector(".webmcp-actions");
    if (actions) actions.hidden = false;
    const run = card.querySelector(".webmcp-run");
    if (run) {
      run.disabled = false;
      run.textContent = "Continue";
    }
    return false;
  });
  callbackSendChain = task.then(() => {});
  return task;
}

async function sendPreparedCallback(call, card, payload) {
  const textarea = composer();
  const stateEl = card.querySelector(".webmcp-state");
  const actions = card.querySelector(".webmcp-actions");
  const run = card.querySelector(".webmcp-run");

  const exposeManualContinue = () => {
    if (stateEl) stateEl.textContent = "Result ready";
    if (actions) actions.hidden = false;
    if (run) {
      run.disabled = false;
      run.textContent = payload?.ok === false ? "Send error" : "Continue";
      run.classList.toggle("webmcp-run--prepared", payload?.ok !== false);
    }
  };

  const expectedText = resultText(call, payload);
  if (textarea && !textarea.value.trim()) setComposerText(expectedText);
  if (!textarea || textarea.value.trim() !== expectedText.trim()) {
    exposeManualContinue();
    return false;
  }

  if (stateEl) stateEl.textContent = "Continuing…";
  card.classList.add("webmcp-card--continuing");
  const initialScope = approvalScope();
  const recorded = await rememberCallState(call.id, "continuing", payload, {requireAck:true});
  // The journal ack is asynchronous. A user may have typed in the composer
  // or navigated to another chat while we waited. Never click Send for a
  // different draft or a different conversation.
  const draftChanged = composer() !== textarea ||
    textarea.value.trim() !== expectedText.trim();
  const sameChat = approvalScope() === initialScope;
  if (!recorded || !card.isConnected || state.contextInvalidated ||
      !sameChat || draftChanged) {
    if (recorded && sameChat && !state.contextInvalidated) {
      // We know no Send click occurred. Only offer a fresh Continue after a
      // durable rollback; otherwise remain conservative on a future reload.
      await rememberCallState(call.id, "result-ready", payload, {requireAck:true});
    }
    card.classList.remove("webmcp-card--continuing");
    if (stateEl) stateEl.textContent = draftChanged
      ? "Draft changed · callback not sent"
      : "Callback paused · recovery unavailable";
    if (actions) actions.hidden = false;
    if (run) {
      run.disabled = false;
      run.textContent = "Continue";
    }
    return false;
  }

  const expected = textarea.value;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const currentComposer = composer();
    if (currentComposer && currentComposer.value !== expected) {
      if (currentComposer.value.trim()) {
        card.classList.remove("webmcp-card--continuing");
        exposeManualContinue();
        return false;
      }
      rememberCallState(call.id, "submitted", payload);
      markSubmitted(card);
      const confirmed = await awaitCallbackReceipt(call);
      if (confirmed) {
        rememberCallState(call.id, "sent", payload);
        applyResultToCard(card, payload, {sent:true});
      }
      return confirmed;
    }

    const button = visibleSendButton();
    const enabled = button
      && !button.matches(":disabled")
      && button.getAttribute("aria-disabled") !== "true";

    if (enabled) {
      button.click();
      // DeepSeek may still be switching its primary circle from Stop to Send.
      // Do not call this sent until the composer actually consumes the callback.
      await new Promise(resolve => setTimeout(resolve, 120));
      const afterClick = composer();
      if (afterClick && !afterClick.value.trim()) {
        rememberCallState(call.id, "submitted", payload);
        markSubmitted(card);
        const confirmed = await awaitCallbackReceipt(call);
        if (confirmed) {
          rememberCallState(call.id, "sent", payload);
          applyResultToCard(card, payload, {sent:true});
        }
        return confirmed;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  card.classList.remove("webmcp-card--continuing");
  exposeManualContinue();
  return false;
}

function approvalPrompt(call) {
  return new Promise(resolve => {
    const layer = document.createElement("div");
    layer.className = "webmcp-approval-layer";
    applyHostTheme();
    layer.setAttribute("role", "presentation");
    const dialog = document.createElement("div");
    dialog.className = "webmcp-approval-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Approve local tool");
    const heading = document.createElement("h3");
    heading.textContent = "Allow local tool?";
    const subtitle = document.createElement("p");
    subtitle.textContent = `DeepSeek requests ${call.tool}. This may modify files or run commands on your computer.`;
    const details = document.createElement("pre");
    details.textContent = JSON.stringify(call.arguments || {}, null, 2);
    const footer = document.createElement("div");
    footer.className = "webmcp-approval-actions";
    const deny = document.createElement("button");
    deny.type = "button";
    deny.textContent = "Cancel";
    const allow = document.createElement("button");
    allow.type = "button";
    allow.className = "webmcp-approval-allow";
    allow.textContent = "Allow once";
    footer.append(deny, allow);
    dialog.append(heading, subtitle, details, footer);
    layer.append(dialog);
    document.body.append(layer);
    let settled = false;
    const done = accepted => {
      if (settled) return;
      settled = true;
      layer.remove();
      resolve(accepted);
    };
    deny.addEventListener("click", () => done(false));
    // A model-controlled page can manufacture DOM events. Only a physical
    // (browser-trusted) user click may approve a privileged local operation.
    allow.addEventListener("click", event => {
      if (event.isTrusted) done(true);
    });
    layer.addEventListener("click", event => {
      if (event.target === layer) done(false);
    });
    layer.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        done(false);
      }
    });
    deny.focus();
  });
}

async function executeCall(call, card, options = {}) {
  if (card.dataset.webmcpPhase === "collision" || !registerCallMeta(call)) {
    markCallIdConflict(card);
    return null;
  }
  const key = approvalScope() + ":" + String(call.id);
  const existing = activeToolCalls.get(key);
  if (existing) {
    // React can remount the same message while a local request is pending.
    // The new card must join that request, not execute the side effect again.
    const response = await existing;
    if (response && card.isConnected) {
      card._webmcpPayload = response;
      restoreCardState(card, call.id);
    }
    return response;
  }
  const request = executeCallImpl(call, card, options);
  activeToolCalls.set(key, request);
  try {
    return await request;
  } finally {
    if (activeToolCalls.get(key) === request) activeToolCalls.delete(key);
  }
}

async function executeCallImpl(call, card, {deferCallback = false} = {}) {
  if (card.dataset.webmcpRunning === "1" ||
      ["sent","collision"].includes(card.dataset.webmcpPhase)) return null;
  card.dataset.webmcpRunning = "1";
  const run = card.querySelector(".webmcp-run");
  const stateEl = card.querySelector(".webmcp-state");
  const actions = card.querySelector(".webmcp-actions");
  if (!isReadOnlyTool(call.tool) && state.approvalMode === "block") {
    delete card.dataset.webmcpRunning;
    const payload = {ok:false,error:"Privileged local tools are blocked by MioWeave global policy."};
    rememberCallState(call.id, "result-ready", payload);
    card.dataset.webmcpPhase = "result-ready";
    card._webmcpPayload = payload;
    applyResultToCard(card, payload);
    return payload;
  }
  if (!isReadOnlyTool(call.tool) && call.tool !== "webmcp.ping" && !autoApproveActive()) {
    if (run) run.disabled = true;
    if (stateEl) stateEl.textContent = "Approval required";
    const approved = await approvalPrompt(call);
    if (!card.isConnected || state.contextInvalidated) {
      delete card.dataset.webmcpRunning;
      return null;
    }
    if (!approved) {
      delete card.dataset.webmcpRunning;
      if (stateEl) stateEl.textContent = "Cancelled";
      if (run) run.disabled = false;
      return null;
    }
  }

  const privileged = !isReadOnlyTool(call.tool) && call.tool !== "webmcp.ping";
  if (run) run.disabled = true;
  if (stateEl) stateEl.textContent = privileged ? "Recording execution…" : "Running…";
  const executionScope = approvalScope();
  const recorded = await rememberCallState(call.id, "running", null, {requireAck:privileged});
  if (!recorded || !card.isConnected || state.contextInvalidated ||
      approvalScope() !== executionScope) {
    // Fail closed: execution has NOT been dispatched. A missing journal entry
    // must never be interpreted as permission to re-run a potentially
    // destructive operation after browser navigation.
    delete card.dataset.webmcpRunning;
    if (stateEl) stateEl.textContent = recorded
      ? "Execution paused · page changed" : "Recovery unavailable · not executed";
    if (run) {
      run.disabled = false;
      run.textContent = "Retry setup";
    }
    return null;
  }
  if (stateEl) stateEl.textContent = "Running…";
  card.classList.add("webmcp-card--running");

  let response;
  try {
    if (call.tool === "webmcp.ping") {
      response = {ok:true,result:{pong:true,source:"content-script dev stub"}};
    } else {
      response = await runtimeMessage({
        type:"WEBMCP_CALL",
        tool:call.tool,
        arguments:call.arguments || {}
      });
      if (!response && state.contextInvalidated) {
        card.classList.remove("webmcp-card--running");
        delete card.dataset.webmcpRunning;
        return;
      }
    }
  } catch (error) {
    response = {ok:false,error:String(error?.message || error)};
  }

  if (response?.result?.isError === true ||
      response?.result?.structuredContent?.isError === true) {
    const content = response.result.content || response.result.structuredContent?.content;
    const message = Array.isArray(content)
      ? content.filter(x => x?.type === "text").map(x => x.text).join("\n")
      : "";
    response = {...response, ok:false,
      error:message.slice(0, 8000) || "MCP tool returned an error"};
  }
  const ok = response?.ok !== false;
  card.dataset.webmcpPhase = "result-ready";
  card._webmcpPayload = response;
  rememberCallState(call.id, "result-ready", response);
  card.classList.remove("webmcp-card--running");
  applyResultToCard(card, response);

  if (deferCallback) {
    delete card.dataset.webmcpRunning;
    return response;
  }

  // Only one callback may occupy the DeepSeek composer at a time.
  // No callback ever overwrites the user's in-progress draft.
  if (state.autoSendCallbacks) {
    if (actions) actions.hidden = true;
    await queueAutoCallback(call, card, response);
  } else if (run) {
    if (!composer()?.value.trim()) setComposerText(resultText(call, response));
    run.disabled = false;
    run.textContent = ok ? "Continue" : "Send error";
    run.classList.toggle("webmcp-run--prepared", ok);
  }

  delete card.dataset.webmcpRunning;
  return response;
}

function sourceSurfaceVisible(source) {
  const surface = source.closest(".ds-message, [data-virtual-list-item-key]") || source.parentElement;
  return surface instanceof HTMLElement && surface.offsetParent !== null;
}

// Clone only the rendered Markdown outside the JSON envelope. The live
// DeepSeek/React node stays untouched, so a streamed update can replace it
// without losing content or fighting mutations in React-owned text nodes.
function pruneEmptyCodeChrome(fragment) {
  // DeepSeek's code fence has its own "text / Copy / Download" chrome.
  // When the protocol body is replaced with tool cards, an otherwise empty
  // code-fence shell must not survive as a visible second UI.
  const wrappers = [...fragment.querySelectorAll(
    '[class*="code-block"], [class*="codeBlock"], [class*="CodeBlock"], [data-testid*="code-block"]'
  )].reverse();
  for (const wrapper of wrappers) {
    // The cloned fragment can retain DeepSeek's language/header toolbar even
    // though its entire fenced protocol code has already become tool cards.
    // Header copy varies by provider version and locale ("text", "Copy",
    // "Download", icons, aria labels, etc.). A partial Range clone may
    // contain only the toolbar and no <pre>/<code> node at all.
    // Remove that shell, but retain wrappers containing real code.
    const code = wrapper.querySelector("pre, code");
    if (!code || !(code.textContent || "").trim()) wrapper.remove();
  }
  // A newer DeepSeek fence can put Copy/Download buttons in a header with
  // no stable code-block class. Range.cloneContents() retains the toolbar
  // after the entire tool-call code was extracted. Only remove a toolbar if
  // its enclosing block has no actual surviving code or meaningful prose.
  const actions = [...fragment.querySelectorAll("button, [role=button]")];
  for (const action of actions) {
    if (!/\bcopy\b|复制/i.test([action.textContent,action.getAttribute("aria-label"),action.title].join(" "))) continue;
    const header = action.parentElement;
    if (!header || ![...header.querySelectorAll("button, [role=button]")]
        .some(node => /\bdownload\b|下载/i.test([node.textContent,node.getAttribute("aria-label"),node.title].join(" ")))) continue;
    const holder = header.parentElement;
    const hasCode = holder && [...holder.querySelectorAll("pre, code")]
      .some(node => node.textContent.trim());
    if (hasCode) continue;
    const chromeOnly = text => /^(?:(?:plain\s*)?text|copy|download|复制|下载|已复制|\.txt|\s|[·.:/()_-])*$/i
      .test((text || "").trim());
    if (holder && holder !== fragment && chromeOnly(holder.textContent)) holder.remove();
    else if (chromeOnly(header.textContent)) header.remove();
  }
  for (const pre of [...fragment.querySelectorAll("pre")]) {
    if (!pre.textContent.trim()) pre.remove();
  }
  return fragment;
}

function cloneCallProse(source, from, to) {
  if (from >= to || !(source.textContent || "").slice(from, to).trim()) return null;

  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  const parts = [];
  let current;
  let offset = 0;
  while ((current = walker.nextNode())) {
    const end = offset + current.nodeValue.length;
    parts.push({node:current, start:offset, end});
    offset = end;
  }
  if (!parts.length) return null;

  function boundary(position) {
    for (const part of parts) {
      if (position <= part.end) {
        return {node:part.node, offset:Math.max(0, position - part.start)};
      }
    }
    const last = parts.at(-1);
    return {node:last.node, offset:last.node.nodeValue.length};
  }

  const a = boundary(from);
  const b = boundary(to);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);

  const el = document.createElement("div");
  el.className = "ds-markdown webmcp-call-prose";
  el.appendChild(range.cloneContents());
  // Some streamed DeepSeek fences yield a stray closing marker outside the
  // code shell after the batch ranges are cloned. Strip only this protocol
  // token from already-recognized tool-call prose, never unrelated Markdown.
  const texts = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let textNode;
  while ((textNode = texts.nextNode())) {
    if (textNode.nodeValue.includes(CALL_CLOSE)) {
      textNode.nodeValue = textNode.nodeValue.replaceAll(CALL_CLOSE, "");
    }
  }
  pruneEmptyCodeChrome(el);
  return el.textContent.trim() ? el : null;
}

function syncCallProse(source, view, parsed) {
  if (!parsed || !(view instanceof HTMLElement)) return;
  const text = source.textContent || "";
  const fingerprint = hashText(text) + ":" + text.length;
  if (view.dataset.webmcpSourceHash === fingerprint) return;
  view.dataset.webmcpSourceHash = fingerprint;

  const before = cloneCallProse(source, 0, parsed.start);
  const after = cloneCallProse(source, parsed.end, text.length);
  view.querySelectorAll(":scope > .webmcp-call-prose").forEach(node => node.remove());
  const card = view.querySelector(":scope > .webmcp-card");
  if (before) view.insertBefore(before, card);
  if (after) view.appendChild(after);
  reconcileToolOnlyActionRow(card);
}

function createToolCard(call, {batch = false} = {}) {
  const card = document.createElement("div");
  card.className = "webmcp-card";
  card.dataset.webmcpId = String(call.id);
  card.innerHTML = [
    '<div class="webmcp-card__head">',
    '<span class="webmcp-tool-icon" aria-hidden="true">' + brandIcon() + '</span>',
    '<span class="webmcp-tool-copy"><strong class="webmcp-tool"></strong><small class="webmcp-tool-provider"></small></span>',
    '<span class="webmcp-state">Ready</span>',
    "</div>",
    '<div class="webmcp-args" hidden></div>',
    '<div class="webmcp-result" hidden></div>',
    '<div class="webmcp-actions">',
    '<button type="button" class="webmcp-run">Run</button>',
    "</div>"
  ].join("");

  card._webmcpCall = call;
  const uniqueId = registerCallMeta(call);
  card.querySelector(".webmcp-tool").textContent = call.tool;
  card.querySelector(".webmcp-tool-provider").textContent = state.localToolLabel || "MioDesk";
  const args = card.querySelector(".webmcp-args");
  const compactArgs = formatArguments(call.arguments || {});
  if (compactArgs) {
    args.textContent = compactArgs;
    args.title = JSON.stringify(call.arguments || {}, null, 2);
    args.hidden = false;
  }
  const actions = card.querySelector(".webmcp-actions");
  if (batch) actions.hidden = true;
  if (!uniqueId) markCallIdConflict(card);
  else if (!batch) card.querySelector(".webmcp-run").addEventListener("click", () => {
    if (card.dataset.webmcpPhase === "submitted") {
      void checkCallbackReceipt(call, card);
    } else if (card._webmcpPayload &&
               ["result-ready", "continuing"].includes(card.dataset.webmcpPhase)) {
      void queueAutoCallback(call, card, card._webmcpPayload);
    } else if (card.dataset.webmcpPhase !== "unknown" &&
               card.dataset.webmcpPhase !== "sent") {
      void executeCall(call, card);
    }
  });
  return card;
}

function makeCard(call, source, {allowAutoRun = true, parsed = null} = {}) {
  const id = String(call.id);
  source.classList.add("webmcp-source");
  source.dataset.webmcpCallId = id;

  const adjacent = source.nextElementSibling;
  const adjacentCard = adjacent?.classList.contains("webmcp-call-view")
    ? adjacent.querySelector(":scope > .webmcp-card")
    : adjacent?.classList.contains("webmcp-card") ? adjacent : null;
  if (adjacentCard?.dataset.webmcpId === id) {
    removeDuplicateCards(id, adjacentCard);
    syncCallProse(source, callViewFromCard(adjacentCard), parsed);
    restoreCardState(adjacentCard, id);
    return adjacentCard;
  }

  const existing = findCard(id);
  if (existing) {
    const owner = callOwnerFromCard(existing);
    const ownerMatches = owner?.classList.contains("webmcp-source") &&
      owner.dataset.webmcpCallId === id;
    const ownerVisible = owner instanceof HTMLElement && sourceSurfaceVisible(owner);
    const sourceVisible = sourceSurfaceVisible(source);

    if (ownerMatches && (ownerVisible || !sourceVisible)) {
      removeDuplicateCards(id, existing);
      restoreCardState(existing, id);
      return existing;
    }

    removeCallCard(existing);
  }
  removeDuplicateCards(id);

  const card = createToolCard(call);

  const view = document.createElement("div");
  view.className = "webmcp-call-view";
  view.dataset.webmcpCallId = id;
  view.appendChild(card);
  source.after(view);
  syncCallProse(source, view, parsed);
  card._webmcpCall = call;

  const restored = restoreCardState(card, call.id);
  if (!restored && allowAutoRun && state.recoveryReady &&
      (autoApproveActive() || (state.autoRunReadOnly && isReadOnlyTool(call.tool)))) {
    window.setTimeout(() => {
      if (card.isConnected && !card.dataset.webmcpPhase &&
          source.nextElementSibling === view && !state.contextInvalidated) {
        void executeCall(call, card);
      }
    }, 700);
  }
  return card;
}

function makeBatchCards(parsedCalls, source, {allowAutoRun = true} = {}) {
  const text = source.textContent || "";
  const ids = parsedCalls.map(p => p.call.id);
  const fingerprint = hashText(text) + ":" + text.length;
  const existing = source.nextElementSibling;
  if (existing?.classList.contains("webmcp-batch-view") &&
      existing.dataset.webmcpSourceHash === fingerprint) return;

  if (existing?.classList.contains("webmcp-call-view")) existing.remove();

  // Do not leave duplicate tool cards behind from provider virtual-list
  // recycling. A call ID belongs to one visible owner.
  for (const id of ids) removeDuplicateCards(id);

  const batchId = "batch_" + hashText(ids.join("|"));
  const view = document.createElement("div");
  view.className = "webmcp-call-view webmcp-batch-view";
  view.dataset.webmcpCallId = ids[0];
  view.dataset.webmcpSourceHash = fingerprint;
  view.dataset.webmcpBatchId = batchId;
  source.classList.add("webmcp-source");
  source.dataset.webmcpCallId = ids[0];

  const items = [];
  let previousEnd = 0;
  for (const parsed of parsedCalls) {
    const prose = cloneCallProse(source, previousEnd, parsed.start);
    if (prose) view.append(prose);
    const card = createToolCard(parsed.call, {batch:true});
    view.append(card);
    items.push({call:parsed.call, card});
    previousEnd = parsed.end;
  }
  const after = cloneCallProse(source, previousEnd, text.length);
  if (after) view.append(after);

  const controls = document.createElement("div");
  controls.className = "webmcp-batch-actions";
  const description = document.createElement("span");
  description.textContent = `${items.length} tools · sequential · 1 callback`;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Run sequence";
  controls.append(description, button);
  view.append(controls);
  source.after(view);

  for (const item of items) restoreCardState(item.card, item.call.id);
  const interrupted = items.some(item =>
    ["unknown", "collision"].includes(item.card.dataset.webmcpPhase));
  if (interrupted) {
    button.textContent = items.some(item => item.card.dataset.webmcpPhase === "collision")
      ? "Call ID conflict · new IDs required" : "Inspect interrupted tool";
    button.disabled = true;
  }
  if (["continuing", "submitted"].includes(callStates.get(batchId)?.phase) && items[0]?.card) {
    markSubmitted(items[0].card);
  }

  const batchCall = {id:batchId, tool:"webmcp.batch", arguments:{}};
  registerCallMeta(batchCall);
  const groupResult = () => {
    const calls = items.map(({call, card}) => ({
      id:String(call.id), tool:call.tool,
      ok:card._webmcpPayload?.ok !== false,
      ...(card._webmcpPayload?.ok === false
        ? {error:card._webmcpPayload?.error || "Tool failed"}
        : {result:card._webmcpPayload?.result ?? card._webmcpPayload})
    }));
    // The transport succeeded even if individual tools failed. Preserve
    // each tool's structured error in the single batch callback.
    return {ok:true,result:{calls,allOk:calls.every(x=>x.ok)}};
  };

  const continueBatch = async () => {
    if (["continuing", "submitted"].includes(callStates.get(batchId)?.phase) ||
        items.some(item => item.card.dataset.webmcpPhase === "submitted")) {
      const confirmed = visibleCallbackReceipt(batchCall);
      if (!confirmed) {
        button.textContent = "Unverified · check chat";
        return false;
      }
      controls.hidden = true;
      return true;
    }
    if (!items.every(x => x.card.dataset.webmcpPhase === "result-ready" ||
      x.card.dataset.webmcpPhase === "sent")) return false;
    const payload = groupResult();
    const extraCards = items.slice(1).map(item=>({
      ...item, payload:item.card._webmcpPayload
    })).map(({call,card,payload})=>({call,card,onePayload:payload}));
    button.textContent = "Waiting for DeepSeek…";
    button.disabled = true;
    let sent = false;
    try {
      sent = await queueAutoCallback(batchCall, items[0].card, payload, extraCards);
      // DeepSeek may show the next assistant turn before its composer/send
      // promise settles. A matching rendered batch callback is authoritative.
      sent = sent || callStates.get(batchId)?.phase === "sent";
      if (sent) {
        button.textContent = "Sent";
        controls.hidden = true;
        rememberCallState(items[0].call.id, "sent", items[0].card._webmcpPayload);
        applyResultToCard(items[0].card, items[0].card._webmcpPayload, {sent:true});
      } else {
        button.textContent = ["continuing", "submitted"].includes(callStates.get(batchId)?.phase)
          ? "Check receipt" : "Continue batch";
      }
      return sent;
    } finally {
      if (!sent) button.textContent = ["continuing", "submitted"].includes(callStates.get(batchId)?.phase)
        ? "Check receipt" : "Continue batch";
      button.disabled = false;
    }
  };

  const runBatch = async () => {
    // A page reload may interrupt a local command whose completion is
    // unknown. Never run the batch again as if it were a fresh request.
    if (items.some(item =>
        ["unknown", "collision"].includes(item.card.dataset.webmcpPhase))) return;
    if (view.dataset.webmcpBatchRunning === "1") return;
    view.dataset.webmcpBatchRunning = "1";
    button.disabled = true;
    for (const {call,card} of items) {
      if (!view.isConnected || state.contextInvalidated ||
          !state.enabled || view.dataset.webmcpBatchRunning !== "1") break;
      if (card._webmcpPayload) continue;
      button.textContent = `Running ${call.tool}…`;
      const payload = await executeCall(call, card, {deferCallback:true});
      if (!payload) break; // User cancelled consent: stop the sequence.
    }
    delete view.dataset.webmcpBatchRunning;
    button.disabled = false;

    if (items.every(x=>Boolean(x.card._webmcpPayload))) {
      button.textContent = "Continue batch";
      if (state.autoSendCallbacks) await continueBatch();
    } else {
      button.textContent = "Resume sequence";
    }
  };
  button.addEventListener("click", () => {
    if (items.every(x=>Boolean(x.card._webmcpPayload))) void continueBatch();
    else void runBatch();
  });

  const allCompleted = items.every(x=>x.card.dataset.webmcpPhase === "sent");
  if (allCompleted) controls.hidden = true;
  else if (interrupted) {button.textContent = "Inspect interrupted tool";button.disabled = true;}
  else if (items.every(x=>Boolean(x.card._webmcpPayload))) {
    button.textContent = ["continuing", "submitted"].includes(callStates.get(batchId)?.phase)
      ? "Check receipt" : "Continue batch";
  } else if (allowAutoRun && state.recoveryReady && !interrupted && items.every(x => autoApproveActive() ||
             (state.autoRunReadOnly && isReadOnlyTool(x.call.tool)))) {
    window.setTimeout(() => {
      if (view.isConnected && source.nextElementSibling === view &&
          !view.dataset.webmcpBatchRunning && !state.contextInvalidated) {
        void runBatch();
      }
    }, 700);
  }
}

function clearCallProjection(el) {
  const callId = el.dataset.webmcpCallId;
  el.classList.remove("webmcp-source");
  delete el.dataset.webmcpCallId;
  if (callId) {
    const adjacent = el.nextElementSibling;
    if (adjacent?.classList.contains("webmcp-call-view") &&
        adjacent.dataset.webmcpCallId === callId) {
      adjacent.remove();
    } else if (adjacent?.classList.contains("webmcp-card") &&
               adjacent.dataset.webmcpId === callId) {
      removeCallCard(adjacent);
    }
  }
}

function isAssistantCallSurface(el) {
  if (!(el instanceof HTMLElement) || !el.matches(".ds-markdown")) return false;
  const message = el.closest(".ds-message");
  if (!message || !message.contains(el)) return false;
  // A markdown wrapper may be nested one or more levels below the message.
  // Exclude DeepThink and nested markdown/code artifacts to avoid treating
  // quoted examples in reasoning as executable calls.
  if (el.closest(".ds-think-content, .webmcp-call-view, .webmcp-panel")) return false;
  if (el.parentElement?.closest(".ds-markdown")) return false;
  return true;
}

function clearCallWarning(el) {
  const sibling = el.nextElementSibling;
  if (sibling?.classList.contains("webmcp-call-warning")) sibling.remove();
}

function showCallWarning(el, message = "Invalid tool request.") {
  let warning = el.nextElementSibling;
  if (!warning?.classList.contains("webmcp-call-warning")) {
    warning = document.createElement("div");
    warning.className = "webmcp-call-warning";
    warning.setAttribute("role", "status");
    const detail = document.createElement("span");
    detail.className = "webmcp-call-warning__detail";
    const action = document.createElement("button");
    action.type = "button";
    action.className = "webmcp-call-warning__repair";
    action.textContent = "Prepare correction";
    action.addEventListener("click", event => {
      if (!event.isTrusted) return;
      const textarea = composer();
      if (!textarea || textarea.value.trim()) {
        detail.textContent = "Composer contains a draft. Clear or send it before preparing a correction.";
        return;
      }
      setComposerText([
        "The last WebMCP call could not be parsed.",
        "Regenerate the tool call with valid JSON, not an explanation.",
        "Wrap the complete [[WEBMCP_CALL]] / [[/WEBMCP_CALL]] envelope in a fenced text code block to preserve JSON backslash escapes.",
        'Within JSON strings, escape literal quotes as \\", and line breaks as \\n.',
        "Keep the intended operation but check the exact tool schema. write_stdin.session_id is an integer (for example 1773, not \"1773\"). Do not issue additional unrelated commands."
      ].join("\n"));
      action.textContent = "Prepared · send to DeepSeek";
    });
    warning.append(detail, action);
    el.after(warning);
  }
  warning.querySelector(".webmcp-call-warning__detail").textContent =
    `WebMCP · ${message}`;
}

function processCallElement(el, {allowAutoRun = true} = {}) {
  if (!state.enabled || !isAssistantCallSurface(el) || el.closest(".webmcp-card")) return;
  const text = el.textContent || "";

  if (!text.includes(CALL_OPEN) || !text.includes(CALL_CLOSE)) {
    clearCallWarning(el);
    if (el.classList.contains("webmcp-source")) clearCallProjection(el);
    return;
  }

  const parsed = parseCalls(text);
  if (parsed.error) {
    if (el.classList.contains("webmcp-source")) clearCallProjection(el);
    showCallWarning(el, parsed.error);
    return;
  }
  clearCallWarning(el);
  if (parsed.calls.length > 1) {
    makeBatchCards(parsed.calls, el, {allowAutoRun});
  } else if (parsed.calls.length === 1) {
    makeCard(parsed.calls[0].call, el, {allowAutoRun, parsed:parsed.calls[0]});
  }
}

function scanCalls() {
  if (!state.enabled) return;

  // Full scan is only used at startup/history restore. Live streaming uses
  // mutation-local processing below.
  for (const el of document.querySelectorAll(".ds-message .ds-markdown")) {
    if (isAssistantCallSurface(el)) processCallElement(el, {allowAutoRun:false});
  }
}

function projectText(element, className, text) {
  if (!(element instanceof HTMLElement)) return;

  // This is a *repeated* reconcile operation. Once projected, the real body
  // has font-size:0/color:transparent. Re-reading those computed styles on
  // every history mutation used to overwrite the ::after display font with
  // 0px, making the user's message disappear after a refresh or scroll.
  const alreadyProjected = element.classList.contains("webmcp-text-projection");
  const oldSize = element.style.getPropertyValue("--webmcp-projection-font-size").trim();
  const oldColor = element.style.getPropertyValue("--webmcp-projection-color").trim();
  const oldLineHeight = element.style.getPropertyValue("--webmcp-projection-line-height").trim();
  const invalidSize = !(parseFloat(oldSize) >= 5);
  const invalidLineHeight = !oldLineHeight || parseFloat(oldLineHeight) === 0;
  const invalidColor = !oldColor || oldColor === "transparent" ||
    /^rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(oldColor);

  if (!alreadyProjected || invalidSize || invalidColor || invalidLineHeight) {
    const style = getComputedStyle(alreadyProjected ? element.parentElement || element : element);
    if (!alreadyProjected || invalidSize) {
      const size = parseFloat(style.fontSize) >= 5 ? style.fontSize : "14px";
      element.style.setProperty("--webmcp-projection-font-size", size);
    }
    if (!alreadyProjected || invalidLineHeight) {
      element.style.setProperty("--webmcp-projection-line-height",
        style.lineHeight === "normal" || parseFloat(style.lineHeight) === 0 ? "1.5" : style.lineHeight);
    }
    if (!alreadyProjected || invalidColor) {
      const color = style.color !== "transparent" && style.color !== "rgba(0, 0, 0, 0)"
        ? style.color : "currentColor";
      element.style.setProperty("--webmcp-projection-color", color);
    }
  }

  if (element.dataset.webmcpDisplay !== text) element.dataset.webmcpDisplay = text;
  element.classList.add("webmcp-text-projection", className);
}

function clearTextProjection(element, className) {
  if (!(element instanceof HTMLElement)) return;
  element.classList.remove(className, "webmcp-text-projection", "webmcp-projection-duplicate");
  delete element.dataset.webmcpDisplay;
  element.style.removeProperty("--webmcp-projection-font-size");
  element.style.removeProperty("--webmcp-projection-line-height");
  element.style.removeProperty("--webmcp-projection-color");
}

function reconcileProjectionDuplicates(selector, datasetKey, value) {
  const nodes = [...document.querySelectorAll(selector)]
    .filter(node => node.dataset[datasetKey] === value);
  if (nodes.length <= 1) {
    nodes[0]?.classList.remove("webmcp-projection-duplicate");
    return;
  }

  const visible = nodes.filter(node => node instanceof HTMLElement && node.offsetParent !== null);
  const keep = visible.at(-1) || nodes.at(-1);
  for (const node of nodes) {
    node.classList.toggle("webmcp-projection-duplicate", node !== keep);
  }
}

// DeepSeek can render a long user callback as a shortened, collapsible
// preview: [[WEBMCP_RESULT]] + the first part of the JSON, but no closing
// marker. Only hide this incomplete DOM preview when it is attributable to a
// callback this extension actually submitted (or has restored in this chat).
// Do not turn a preview into a receipt: only a complete envelope can do that.
function ownedCollapsedCallback(text) {
  if (!state.hideCallbacks || !text.startsWith(RESULT_OPEN) || text.includes(RESULT_CLOSE)) return null;
  const head = text.slice(RESULT_OPEN.length).trimStart();
  const match = /^\{\s*"id"\s*:\s*"([^"\\]{1,150})"\s*,\s*"tool"\s*:\s*"([^"\\]{1,128})"\s*,\s*"ok"\s*:\s*(?:true|false)\b/.exec(head);
  if (!match) return null;
  const [,id,tool] = match;
  const remembered = callStates.get(id);
  const meta = callMetas.get(id);
  if (!remembered || !meta || meta.tool !== tool ||
      !["submitted", "sent", "continuing"].includes(remembered.phase)) return null;
  return {id,tool,phase:remembered.phase};
}

function processCollapsedCallbackPreview(body) {
  if (!(body instanceof HTMLElement)) return false;
  const owned = ownedCollapsedCallback(callbackSurfaceText(body));
  if (!owned) return false;
  const card = findCard(owned.id);
  const item = body.closest(".ds-message") || body;
  const row = item.closest("[data-virtual-list-item-key]");
  body.dataset.webmcpResultId = owned.id;
  projectText(body, "webmcp-callback-projection", `Tool result · ${owned.tool} · Preview hidden`);
  item.classList.toggle("webmcp-callback-hidden", Boolean(card));
  if (row) {
    const dedicated = row.querySelectorAll(".ds-message").length === 1 ||
      (row.querySelectorAll(".ds-message").length === 0 &&
       ownedCollapsedCallback(callbackSurfaceText(row))?.id === owned.id);
    row.classList.toggle("webmcp-callback-row-hidden", Boolean(card && dedicated));
  }
  reconcileProjectionDuplicates(
    ".webmcp-callback-projection[data-webmcp-result-id]",
    "webmcpResultId", owned.id
  );
  return true;
}

function processCallbackLeaf(leaf) {
  if (!(leaf instanceof Element)) return;

  const body = leaf;
  const matched = callbackMatch(body);
  if (!matched) return;
  const {text} = matched;
  const result = body._webmcpResultCache?.text === text
    ? body._webmcpResultCache.result
    : matched.result;
  body._webmcpResultCache = {text, result};

  const payload = {ok:result.ok !== false, result:result.result, error:result.error};
  rememberCallState(result.id, "sent", payload);

  const item = body.closest(".ds-message") || body;
  const row = item.closest("[data-virtual-list-item-key]");
  body.dataset.webmcpResultId = String(result.id);
  const card = findCard(result.id);

  if (result.tool === "webmcp.batch" && Array.isArray(result.result?.calls)) {
    const batchCards = [];
    for (const entry of result.result.calls) {
      const childCard = findCard(entry.id);
      if (!childCard) continue;
      const onePayload = entry.ok === false
        ? {ok:false,error:entry.error}
        : {ok:true,result:entry.result};
      rememberCallState(entry.id, "sent", onePayload);
      childCard._webmcpPayload = onePayload;
      applyResultToCard(childCard, onePayload, {sent:true});
      batchCards.push(childCard);
    }
    document.querySelectorAll(".webmcp-batch-view").forEach(view => {
      if (view.dataset.webmcpBatchId === result.id) {
        const controls = view.querySelector(".webmcp-batch-actions");
        if (controls) {
          controls.hidden = true;
          const button = controls.querySelector("button");
          if (button) {
            button.textContent = "Sent";
            button.disabled = false;
          }
        }
      }
    });
    body._webmcpBatchCards = batchCards;
  } else if (card) {
    card.dataset.webmcpPhase = "sent";
    card._webmcpPayload = payload;
    applyResultToCard(card, payload, {sent:true});
  }

  if (!state.hideCallbacks) {
    row?.classList.remove("webmcp-callback-row-hidden");
    item.classList.remove("webmcp-callback-hidden", "webmcp-projection-duplicate");
    clearTextProjection(body, "webmcp-callback-projection");
    return;
  }

  // Always keep a projection on the message body, even while the whole user
  // message is hidden behind a matching tool card. DeepSeek may recycle the
  // surrounding virtual-list item later; retaining the body projection means
  // a lost wrapper class can never expose raw protocol text.
  const status = result.ok === false ? "Failed" : "Sent";
  projectText(body, "webmcp-callback-projection", `Tool result · ${result.tool} · ${status}`);
  item.classList.toggle("webmcp-callback-hidden",
    Boolean(card || body._webmcpBatchCards?.length));
  // DeepSeek's outer virtual-list row otherwise retains ~50px of blank space.
  // Collapse it only if this row contains no other message besides the callback.
  if (row) {
    const dedicated = row.querySelectorAll(".ds-message").length === 1 ||
      (row.querySelectorAll(".ds-message").length === 0 &&
       callbackMatch(row)?.result?.id === result.id);
    row.classList.toggle("webmcp-callback-row-hidden",
      Boolean((card || body._webmcpBatchCards?.length) && dedicated));
  }

  reconcileProjectionDuplicates(
    ".webmcp-callback-projection[data-webmcp-result-id]",
    "webmcpResultId",
    String(result.id)
  );
}

function scanCallbacks() {
  if (!state.hideCallbacks) {
    document.querySelectorAll(".webmcp-callback-row-hidden").forEach(row => row.classList.remove("webmcp-callback-row-hidden"));
    document.querySelectorAll(".webmcp-callback-hidden").forEach(item => item.classList.remove("webmcp-callback-hidden"));
    document.querySelectorAll(".webmcp-callback-projection").forEach(item => {
      clearTextProjection(item, "webmcp-callback-projection");
    });
  }

  for (const body of callbackBodies()) {
    if (callbackMatch(body)) processCallbackLeaf(body);
    else processCollapsedCallbackPreview(body);
  }
}

function initPayloadText(text) {
  if (!text.startsWith(INIT_OPEN) || !text.includes(INIT_CLOSE)) return null;
  const end = text.indexOf(INIT_CLOSE);
  const initText = text.slice(INIT_OPEN.length, end).trim();
  const userText = text.slice(end + INIT_CLOSE.length).trimStart();
  const fingerprint = initText.match(/schema=([0-9a-f]{8})/i)?.[1] || "";
  return {initText, userText, fingerprint};
}

function processInitLeaf(leaf) {
  if (!(leaf instanceof Element)) return;
  const text = (leaf.textContent || "").trim();
  const parsed = initPayloadText(text);
  if (!parsed) return;

  const body = leaf.closest(".ds-collapsible-text") || leaf;
  const initKey = hashText(text);
  body.dataset.webmcpInitKey = initKey;
  projectText(body, "webmcp-init-projection", parsed.userText);
  // Never suppress a user turn based on a matching payload hash. DeepSeek's
  // virtual list can temporarily mount both copies; the previous global
  // de-duper sometimes hid the copy belonging to the visible message, leaving
  // the user's first prompt as an empty bubble after a later send.
  body.classList.remove("webmcp-projection-duplicate");

  const chatId = currentChatId();
  if (chatId && parsed.fingerprint && parsed.fingerprint === toolFingerprint() && !state.chatReady) {
    state.chatReady = true;
    saveChatInitialized(chatId, parsed.fingerprint).then(() => refreshUi());
  }
}

function scanInitMessages() {
  for (const leaf of markerElements(INIT_OPEN, INIT_CLOSE)) {
    processInitLeaf(leaf);
  }
}

function reconcileVisibleUserProtocols(root = document) {
  // Reconcile old releases that hid a user turn as a supposed duplicate.
  document.querySelectorAll(".webmcp-init-projection.webmcp-projection-duplicate")
    .forEach(body => body.classList.remove("webmcp-projection-duplicate"));

  // The original assistant action strip is removed from flow only for a
  // completed tool call. Restore normal layout on recycled message rows.
  document.querySelectorAll(".webmcp-tool-action-row, .webmcp-tool-only-row").forEach(row => {
    if (!row.querySelector(".webmcp-card--sent")) {
      row.classList.remove("webmcp-tool-action-row", "webmcp-tool-only-row");
    }
  });

  // DeepSeek can recycle an existing virtual-list node for unrelated content.
  // Clear our previous presentation before processing the new message.
  document.querySelectorAll(".webmcp-callback-projection, .webmcp-init-projection").forEach(body => {
    const text = (body.textContent || "").trim();
    if (body.classList.contains("webmcp-callback-projection") &&
        !callbackMatch(body) && !ownedCollapsedCallback(text)) {
      // The fallback may project the row or an unclassed user bubble itself,
      // not only a .ds-message. Unhide the exact old container on React reuse.
      (body.closest(".webmcp-callback-hidden") || body).classList.remove("webmcp-callback-hidden");
      body.closest("[data-virtual-list-item-key]")?.classList.remove("webmcp-callback-row-hidden");
      clearTextProjection(body, "webmcp-callback-projection");
      delete body.dataset.webmcpResultId;
      delete body._webmcpResultCache;
    } else if (body.classList.contains("webmcp-init-projection") &&
               !(text.startsWith(INIT_OPEN) && text.includes(INIT_CLOSE))) {
      clearTextProjection(body, "webmcp-init-projection");
      delete body.dataset.webmcpInitKey;
    }
  });

  document.querySelectorAll(".webmcp-callback-row-hidden").forEach(row => {
    const body = row.matches(".webmcp-callback-projection")
      ? row : row.querySelector(".webmcp-callback-projection");
    const text = (body?.textContent || "").trim();
    const dedicated = row.querySelectorAll(".ds-message").length === 1 ||
      (row.querySelectorAll(".ds-message").length === 0 &&
       (Boolean(callbackMatch(row)) || Boolean(ownedCollapsedCallback(callbackSurfaceText(row)))));
    if (!row.querySelector(".webmcp-callback-hidden") ||
        !dedicated ||
        (!body || (!callbackMatch(body) && !ownedCollapsedCallback(text)))) {
      row.classList.remove("webmcp-callback-row-hidden");
    }
  });

  for (const body of callbackBodies(root)) {
    if (callbackMatch(body)) processCallbackLeaf(body);
    else processCollapsedCallbackPreview(body);
  }

  const initBodies = [];
  if (root instanceof Element && root.matches(".ds-collapsible-text")) initBodies.push(root);
  if (root.querySelectorAll) initBodies.push(...root.querySelectorAll(".ds-collapsible-text"));
  for (const body of initBodies) {
    const text = (body.textContent || "").trim();
    if (text.startsWith(INIT_OPEN) && text.includes(INIT_CLOSE)) processInitLeaf(body);
  }
}

function visibleSendButton() {
  const buttons = [...document.querySelectorAll('[role="button"].ds-button--primary.ds-button--circle')]
    .filter(button => button instanceof HTMLElement && button.offsetParent !== null);
  return buttons.at(-1) || null;
}

function shouldAutoInitialize() {
  const textarea = composer();
  const text = textarea?.value?.trim() || "";
  return Boolean(
    state.enabled &&
    state.authorized &&
    state.tools.length &&
    !state.chatReady &&
    text &&
    !text.startsWith(INIT_OPEN) &&
    !text.startsWith(RESULT_OPEN)
  );
}

function prepareInitialization() {
  if (!shouldAutoInitialize()) return false;
  const textarea = composer();
  const original = textarea.value.trim();
  const fingerprint = toolFingerprint();
  const payload = [
    INIT_OPEN,
    buildBootstrap(fingerprint),
    INIT_CLOSE,
    "",
    original
  ].join("\n");

  state.pendingInitFingerprint = fingerprint;
  state.chatReady = true;
  setComposerText(payload);
  refreshUi();
  return true;
}

function resendAfterInitialization() {
  const button = visibleSendButton();
  if (!button) return;
  state.bypassNextSend = true;
  button.click();
}

function noteUserDraftSend(event) {
  // A new conversation gains its saved ID on the first successful send.
  // Transfer only a draft permission explicitly associated with a real user
  // send, not when a user browses from the new-chat screen to an old chat.
  if (event.isTrusted && state.autoApproveAny &&
      state.autoApproveChatId === NEW_CHAT_APPROVAL_SCOPE &&
      !currentChatId() && composer()?.value?.trim()) {
    state.autoApproveDraftSendPending = true;
  }
}

function interceptSend(event) {
  if (state.bypassNextSend) {
    state.bypassNextSend = false;
    return;
  }

  if (event.type === "keydown") {
    const textarea = composer();
    const isEnter = textarea
      && event.target === textarea
      && event.key === "Enter"
      && !event.shiftKey
      && !event.isComposing;
    if (!isEnter) return;
    noteUserDraftSend(event);
    if (!prepareInitialization()) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    setTimeout(resendAfterInitialization, 0);
    return;
  }

  if (event.type === "click") {
    const clickedButton = event.target instanceof Element
      ? event.target.closest('[role="button"].ds-button--primary.ds-button--circle')
      : null;
    if (!clickedButton || clickedButton.offsetParent === null) return;
    noteUserDraftSend(event);
    if (!prepareInitialization()) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    setTimeout(resendAfterInitialization, 0);
  }
}

async function syncChatIdentity() {
  const hrefChanged = state.lastHref !== location.href;
  if (!hrefChanged && !state.pendingInitFingerprint) return;

  const previousChatId = state.lastChatId;
  const chatId = currentChatId();

  if (hrefChanged) {
    const previousPath = new URL(state.lastHref, location.href).pathname;
    state.lastHref = location.href;
    state.lastChatId = chatId;
    // The draft scope is for one *new chat* route, not arbitrary SPA pages.
    if (state.autoApproveAny &&
        state.autoApproveChatId === NEW_CHAT_APPROVAL_SCOPE &&
        !chatId && previousPath !== location.pathname) {
      revokeAutoApprove();
    }
    if (state.autoApproveAny && state.autoApproveChatId !== approvalScope()) {
      // First send may transition from new-chat to a saved conversation ID.
      // Every other chat switch must immediately revoke the elevated grant.
      if (state.autoApproveChatId === NEW_CHAT_APPROVAL_SCOPE &&
          !previousChatId && chatId && state.autoApproveDraftSendPending) {
        state.autoApproveChatId = chatId;
        state.autoApproveDraftSendPending = false;
      } else {
        revokeAutoApprove();
      }
    }

    const leftExistingChat = previousChatId && previousChatId !== chatId;
    const switchedChats = previousChatId && chatId && previousChatId !== chatId;
    if (leftExistingChat || switchedChats) {
      callStates.clear();
      callMetas.clear();
      state.recoveryReady = false;
      await loadRecoveryState(chatId);
      state.recoveryReady = true;
      document.querySelectorAll(".webmcp-card").forEach(card => removeCallCard(card));
      document.querySelectorAll(".webmcp-source").forEach(source => clearCallProjection(source));
      closeSettingsPanel();
    }
    addControls();
  }

  if (chatId && state.pendingInitFingerprint) {
    await saveChatInitialized(chatId, state.pendingInitFingerprint);
    state.pendingInitFingerprint = "";
    state.chatReady = true;
    refreshUi();
    return;
  }

  if (hrefChanged) await refreshChatReady();
}

function markerElementFromNode(node, open, close) {
  const root = node?.nodeType === Node.TEXT_NODE
    ? node.parentElement
    : node instanceof Element ? node : null;
  if (!root || root.closest(".webmcp-card, .webmcp-panel, .webmcp-controls")) return null;

  if (node?.nodeType === Node.TEXT_NODE) {
    return markerBlockFromTextNode(node, open, close);
  }

  const localText = root.textContent || "";
  if (!localText.includes(open) || !localText.includes(close)) return null;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textNode;
  while ((textNode = walker.nextNode())) {
    const block = markerBlockFromTextNode(textNode, open, close);
    if (block) return block;
  }
  return null;
}

const callCandidates = new WeakSet();

function callElementsFromNode(node) {
  const root = node?.nodeType === Node.TEXT_NODE
    ? node.parentElement
    : node instanceof Element ? node : null;
  if (!root || root.closest(".webmcp-call-view, .webmcp-panel, .webmcp-controls")) return [];

  const found = new Set();
  const localText = node?.nodeType === Node.TEXT_NODE
    ? (node.nodeValue || "")
    : (root.textContent || "");

  const consider = el => {
    if (!isAssistantCallSurface(el)) return;
    if (callCandidates.has(el) || el.classList.contains("webmcp-source") ||
        localText.includes("WEBMCP")) {
      callCandidates.add(el);
      found.add(el);
    }
  };

  const closest = root.closest?.(".ds-markdown");
  if (closest) consider(closest);
  if (root.matches?.(".ds-markdown")) consider(root);

  // Catch message subtrees inserted in one React batch, even when DeepSeek
  // adds intermediate layout wrappers between .ds-message and .ds-markdown.
  if (node instanceof Element) {
    for (const el of node.querySelectorAll?.(".ds-message .ds-markdown, .ds-markdown") || []) {
      if (isAssistantCallSurface(el) && (el.textContent || "").includes("WEBMCP")) {
        callCandidates.add(el);
        found.add(el);
      }
    }
  }
  return [...found];
}

const pendingMutationNodes = new Set();
const orphanedCallIds = new Set();
const removedInitKeys = new Set();
const removedResultIds = new Set();
let mutationFlushTimer = 0;
let identitySyncQueued = false;
let controlsCheckNeeded = false;
let userProtocolReconcileNeeded = false;

function queueIdentitySync() {
  if (identitySyncQueued) return;
  if (state.lastHref === location.href && !state.pendingInitFingerprint) return;
  identitySyncQueued = true;
  queueMicrotask(async () => {
    try {
      await syncChatIdentity();
    } finally {
      identitySyncQueued = false;
    }
  });
}

function reconcileRemovedArtifacts() {
  for (const id of orphanedCallIds) {
    if (findCard(id)) continue;
    const sources = [...document.querySelectorAll(".webmcp-source")]
      .filter(source => source.dataset.webmcpCallId === id);
    const candidate = sources.find(sourceSurfaceVisible) || sources.at(-1);
    if (candidate) processCallElement(candidate, {allowAutoRun:false});
  }
  orphanedCallIds.clear();

  removedInitKeys.clear();

  for (const id of removedResultIds) {
    reconcileProjectionDuplicates(
      ".webmcp-callback-projection[data-webmcp-result-id]",
      "webmcpResultId",
      id
    );
  }
  removedResultIds.clear();
}

function collectRemovedArtifacts(node) {
  if (!(node instanceof Element)) return;

  const cards = node.matches(".webmcp-card")
    ? [node]
    : [...node.querySelectorAll(".webmcp-card")];
  for (const card of cards) {
    if (card.dataset.webmcpId) orphanedCallIds.add(card.dataset.webmcpId);
  }

  const sources = node.matches(".webmcp-source")
    ? [node]
    : [...node.querySelectorAll(".webmcp-source")];
  for (const source of sources) {
    if (source.dataset.webmcpCallId) orphanedCallIds.add(source.dataset.webmcpCallId);
  }

  const inits = node.matches(".webmcp-init-projection")
    ? [node]
    : [...node.querySelectorAll(".webmcp-init-projection")];
  for (const init of inits) {
    if (init.dataset.webmcpInitKey) removedInitKeys.add(init.dataset.webmcpInitKey);
  }

  const results = node.matches(".webmcp-callback-projection")
    ? [node]
    : [...node.querySelectorAll(".webmcp-callback-projection")];
  for (const result of results) {
    if (result.dataset.webmcpResultId) removedResultIds.add(result.dataset.webmcpResultId);
  }
}

function flushMutationNodes() {
  mutationFlushTimer = 0;
  const nodes = [...pendingMutationNodes];
  pendingMutationNodes.clear();

  const calls = new Set();
  const callbacks = new Set();
  const inits = new Set();

  for (const node of nodes) {
    for (const el of callElementsFromNode(node)) calls.add(el);

    const callback = markerElementFromNode(node, RESULT_OPEN, RESULT_CLOSE);
    if (callback) callbacks.add(callback);

    const init = markerElementFromNode(node, INIT_OPEN, INIT_CLOSE);
    if (init) inits.add(init);
  }

  for (const el of calls) processCallElement(el);
  for (const leaf of callbacks) processCallbackLeaf(leaf);
  for (const leaf of inits) processInitLeaf(leaf);
  reconcileRemovedArtifacts();

  if (userProtocolReconcileNeeded) {
    userProtocolReconcileNeeded = false;
    reconcileVisibleUserProtocols();
  }

  if (controlsCheckNeeded || !document.querySelector(".webmcp-controls")) {
    controlsCheckNeeded = false;
    addControls();
  }
  queueIdentitySync();
}

function scheduleMutationFlush() {
  if (mutationFlushTimer) return;
  // DeepSeek streams many tiny DOM mutations. A short batch window keeps tool
  // detection responsive without running extension logic once per token.
  mutationFlushTimer = window.setTimeout(flushMutationNodes, 40);
}

function cleanupLegacyArtifacts() {
  document.querySelectorAll(".webmcp-init-clean, .webmcp-callback-summary").forEach(node => node.remove());
  document.querySelectorAll(".webmcp-init-raw").forEach(node => node.classList.remove("webmcp-init-raw"));
  document.querySelectorAll(".webmcp-callback-item").forEach(node => node.classList.remove("webmcp-callback-item"));
}

function installObserver() {
  cleanupLegacyArtifacts();
  runtimeObserver?.disconnect();
  runtimeObserver = new MutationObserver(records => {
    if (!extensionContextAlive()) {
      invalidateExtensionContext(new Error("Extension context invalidated."));
      return;
    }

    let hostThemeChanged = false;
    for (const record of records) {
      if (record.type === "attributes") {
        if (hostThemeAncestors.has(record.target)) hostThemeChanged = true;
        continue;
      }
      if (record.type === "characterData") {
        pendingMutationNodes.add(record.target);
        const parent = record.target.parentElement;
        const message = parent?.closest(".ds-message");
        if (parent?.closest(".ds-collapsible-text") ||
            record.target.nodeValue?.includes(RESULT_OPEN) ||
            (message && (message.textContent || "").trim().startsWith(RESULT_OPEN))) {
          userProtocolReconcileNeeded = true;
        }
        continue;
      }

      if (record.type === "childList") {
        for (const node of record.addedNodes) {
          pendingMutationNodes.add(node);
          if (node instanceof Element &&
              (node.matches?.(".ds-toggle-button") || node.querySelector?.(".ds-toggle-button"))) {
            controlsCheckNeeded = true;
          }
          if (node instanceof Element &&
              (node.matches?.(".ds-collapsible-text, [data-virtual-list-item-key], .ds-virtual-list-visible-items") ||
               node.querySelector?.(".ds-collapsible-text, [data-virtual-list-item-key], .ds-virtual-list-visible-items"))) {
            userProtocolReconcileNeeded = true;
          }
          // Only new user-protocol Markdown should cause an additional full
          // user-message reconcile. Ordinary assistant token streaming must
          // stay on the cheap mutation-local path.
          if ((node.textContent || "").includes(RESULT_OPEN) ||
              (node instanceof Text && node.nodeValue?.includes(RESULT_OPEN))) {
            userProtocolReconcileNeeded = true;
          }
        }
        if (record.removedNodes.length) {
          controlsCheckNeeded = true;
          userProtocolReconcileNeeded = true;
          for (const node of record.removedNodes) collectRemovedArtifacts(node);
        }
      }
    }

    // Apply host palette changes in this microtask, before the next paint.
    if (hostThemeChanged) applyHostTheme();
    if (pendingMutationNodes.size || controlsCheckNeeded) scheduleMutationFlush();
    queueIdentitySync();
  });

  runtimeObserver.observe(document.documentElement, {
    subtree:true,
    childList:true,
    characterData:true,
    attributes:true,
    attributeFilter:["class", "style", "data-theme", "data-color-mode"]
  });

  // Initial restore plus a few delayed reconciles cover DeepSeek's staged
  // history hydration. Live virtual-list changes set userProtocolReconcileNeeded
  // and are handled in the normal batched mutation flush.
  applyHostTheme();
  scanCalls();
  scanCallbacks();
  scanInitMessages();
  reconcileVisibleUserProtocols();
  addControls();

  for (const delay of [120, 500, 1400]) {
    window.setTimeout(() => {
      if (!state.contextInvalidated) reconcileVisibleUserProtocols();
    }, delay);
  }
}

// Browser-facing MioWeave identity uses the compact moon-cat mark.
// Outside an installed extension (e.g. static UI fixtures), retain the tiny
// inline SVG fallback rather than relying on chrome.runtime.
function brandIcon() {
  const url = globalThis.chrome?.runtime?.getURL?.("icons/mioweave-small-48.png");
  return url ? '<img src="' + url + '" alt="" draggable="false" decoding="async">' : svgTool();
}

function svgTool() {
  return '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none"><path d="M2 3.6 4.4 12 8 5.8 11.6 12 14 3.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 12.4 4.4 4 8 10.2 11.6 4 14 12.4" stroke="currentColor" stroke-opacity=".48" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function svgGear() {
  return '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none"><path d="M6.95 1.45h2.1l.28 1.34c.39.14.75.35 1.08.62l1.31-.42 1.05 1.82-1.03.92c.07.41.07.83 0 1.24l1.03.92-1.05 1.82-1.31-.42c-.33.27-.69.48-1.08.62l-.28 1.34h-2.1l-.28-1.34a4.5 4.5 0 0 1-1.08-.62l-1.31.42-1.05-1.82 1.03-.92a3.7 3.7 0 0 1 0-1.24l-1.03-.92 1.05-1.82 1.31.42c.33-.27.69-.48 1.08-.62l.28-1.34Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="6.35" r="1.7" stroke="currentColor" stroke-width="1.2"/></svg>';
}

function setToggleVisual(button) {
  button.setAttribute("aria-pressed", String(state.enabled));
  button.classList.toggle("ds-toggle-button--selected", state.enabled);
  button.classList.toggle("webmcp-toggle--off", !state.enabled);
}

async function persistConfig(patch) {
  const response = await runtimeMessage({type:"WEBMCP_CONFIG_SET", config:patch});
  if (response?.ok && response.config) {
    Object.assign(state, response.config);
    refreshUi();
  }
  return response;
}

function currentToolbarParent() {
  if (!composer()) return null;
  const toggles = [...document.querySelectorAll(".ds-toggle-button")]
    .filter(el => (el.innerText || "").trim() === "Search");

  const visible = toggles.find(el => el instanceof HTMLElement && el.offsetParent !== null);
  return (visible || toggles.at(-1))?.parentElement || null;
}

function createControls() {
  const controls = document.createElement("div");
  controls.className = "webmcp-controls";

  const button = document.createElement("div");
  button.className = "f79352dc ds-toggle-button ds-toggle-button--m webmcp-toggle";
  button.tabIndex = 0;
  button.setAttribute("role", "button");
  button.innerHTML = '<span class="webmcp-toggle__icon">' + brandIcon() + '</span><span>MioWeave</span><span class="webmcp-toggle__status"></span>';
  setToggleVisual(button);

  button.addEventListener("click", async () => {
    state.enabled = !state.enabled;
    if (!state.enabled) revokeAutoApprove();
    setToggleVisual(button);
    await persistConfig({enabled:state.enabled});
    if (state.enabled) scanCalls();
  });

  const settings = document.createElement("button");
  settings.type = "button";
  settings.className = "webmcp-settings-trigger";
  settings.setAttribute("aria-label", "MioWeave 快捷设置");
  settings.title = "MioWeave 快捷设置";
  settings.innerHTML = svgGear();
  settings.addEventListener("click", event => {
    event.stopPropagation();
    toggleSettingsPanel(settings);
  });

  controls.append(button, settings);
  return controls;
}

function addControls() {
  const parent = currentToolbarParent();
  if (!parent) return;

  const all = [...document.querySelectorAll(".webmcp-controls")];
  let current = all.find(control => control.parentElement === parent) || null;

  for (const control of all) {
    if (control !== current) control.remove();
  }

  if (!current) {
    current = createControls();
    parent.appendChild(current);
  }

  applyHostTheme();
  refreshUi();
}

function statusLabel() {
  if (!state.connected) return "未连接";
  if (!state.tokenConfigured) return "待配置 Token";
  if (!state.authorized) return "待授权";
  return `${state.tools.length} 个工具`;
}

function refreshUi() {
  const toggle = document.querySelector(".webmcp-toggle");
  if (toggle) {
    setToggleVisual(toggle);
    const dot = toggle.querySelector(".webmcp-toggle__status");
    if (dot) {
      dot.className = "webmcp-toggle__status";
      if (autoApproveActive()) dot.classList.add("webmcp-toggle__status--warn");
      else if (state.authorized && state.chatReady) dot.classList.add("webmcp-toggle__status--ok");
      else if (state.authorized) dot.classList.add("webmcp-toggle__status--armed");
      else if (state.connected) dot.classList.add("webmcp-toggle__status--warn");
    }
    toggle.title = autoApproveActive()
      ? `MioWeave · 自动批准（${state.approvalMode === "always" ? "全局" : "当前聊天"}）`
      : !state.authorized
        ? statusLabel()
        : state.chatReady
          ? `MioWeave 已就绪 · ${state.tools.length} 个工具`
          : `MioWeave 已连接 · 下次发送消息时载入工具`;
  }
  renderPanelState();
}

async function refreshBridge() {
  const result = await runtimeMessage({type:"WEBMCP_BRIDGE_CHECK"});
  if (!result && state.contextInvalidated) return null;
  if (!result?.authorized) revokeAutoApprove();
  state.connected = Boolean(result?.connected);
  state.authorized = Boolean(result?.authorized);
  state.tokenConfigured = Boolean(result?.tokenConfigured);
  state.tools = Array.isArray(result?.tools) ? result.tools : [];
  state.bridgeError = result?.error || "";
  await refreshChatReady();
  refreshUi();
  return result;
}

function field(label, input) {
  const wrap = document.createElement("label");
  wrap.className = "webmcp-field";
  const name = document.createElement("span");
  name.className = "webmcp-field__label";
  name.textContent = label;
  wrap.append(name, input);
  return wrap;
}

function autoApproveAnyPrompt(chatId) {
  return new Promise(resolve => {
    const layer = document.createElement("div");
    layer.className = "webmcp-approval-layer";
    applyHostTheme();
    const dialog = document.createElement("div");
    dialog.className = "webmcp-approval-dialog webmcp-auto-approval-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "临时允许本地工具");

    const heading = document.createElement("h3");
    heading.textContent = "临时允许当前聊天？";
    const warning = document.createElement("p");
    warning.textContent = "DeepSeek 将能直接执行命令，读取、修改或删除本地文件，不再逐次确认。仅对可信聊天启用；Bridge 不提供操作系统隔离。";
    const scope = document.createElement("p");
    scope.className = "webmcp-approval-scope";
    scope.textContent = "仅当前聊天有效，切换聊天或刷新页面后失效。";
    const actions = document.createElement("div");
    actions.className = "webmcp-approval-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "保持逐次确认";
    const enable = document.createElement("button");
    enable.type = "button";
    enable.className = "webmcp-approval-allow";
    enable.textContent = "允许当前聊天";
    actions.append(cancel, enable);
    dialog.append(heading, warning, scope, actions);
    layer.appendChild(dialog);
    document.body.append(layer);

    let settled = false;
    const done = accepted => {
      if (settled) return;
      settled = true;
      layer.remove();
      resolve(Boolean(accepted && approvalScope() === chatId));
    };
    cancel.addEventListener("click", () => done(false));
    enable.addEventListener("click", event => {
      if (event.isTrusted) done(true);
    });
    layer.addEventListener("click", event => {
      if (event.target === layer) done(false);
    });
    layer.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        done(false);
      }
    });
    cancel.focus();
  });
}

function autoApproveAnyRow() {
  const row = document.createElement("section");
  row.className = "webmcp-auto-approve-any";
  row.innerHTML = [
    '<div class="webmcp-access-heading">',
    '<span class="webmcp-access-indicator" aria-hidden="true"></span>',
    '<strong class="webmcp-access-title">高权限操作逐次确认</strong>',
    '<span class="webmcp-access-status">默认</span>',
    '</div>',
    '<p class="webmcp-access-detail" role="status" aria-live="polite">执行命令、修改或删除文件前需确认。</p>',
    '<div class="webmcp-access-footer">',
    '<small>可临时允许当前聊天</small>',
    '<button class="webmcp-auto-approve-button" type="button" aria-pressed="false">临时允许</button>',
    '</div>'
  ].join("");
  const button = row.querySelector("button");
  button.addEventListener("click", async event => {
    if (!event.isTrusted || button.disabled) return;
    if (state.approvalMode === "always" || state.approvalMode === "block") {
      await runtimeMessage({type:"WEBMCP_OPEN_OPTIONS"});
      return;
    }
    if (autoApproveActive()) {
      revokeAutoApprove();
      refreshUi();
      return;
    }
    state.approvalNotice = "";
    const scope = approvalScope();
    if (!state.enabled || !state.authorized) {
      state.approvalNotice = !state.enabled
        ? "请先在扩展设置中启用本地工具。"
        : "Bridge 尚未授权，请检查连接设置或刷新状态。";
      refreshAutoApproveUi();
      return;
    }

    button.disabled = true;
    const accepted = await autoApproveAnyPrompt(scope);
    const valid = accepted && state.enabled && state.authorized &&
      approvalScope() === scope && !state.contextInvalidated;
    state.autoApproveAny = Boolean(valid);
    state.autoApproveChatId = valid ? scope : "";
    state.autoApproveDraftSendPending = false;
    state.approvalNotice = !accepted
      ? "Not enabled — confirmation was cancelled."
      : !valid
        ? "Not enabled — the chat or bridge changed during confirmation."
        : "";
    button.disabled = false;
    refreshUi();
  });
  return row;
}

function callbackDelayRow() {
  const row = document.createElement("label");
  row.className = "webmcp-setting-row webmcp-delay-setting";
  const copy = document.createElement("span");
  copy.className = "webmcp-setting-copy";
  const title = document.createElement("strong");
  title.textContent = "回传间隔";
  const details = document.createElement("small");
  details.textContent = "多工具共用一次结果回传";
  copy.append(title, details);
  const select = document.createElement("select");
  select.className = "webmcp-delay-select";
  select.setAttribute("aria-label", "最小回传间隔");
  for (const [ms, label] of [[0,"立即"],[500,"0.5 秒"],[1000,"1 秒"],[1500,"1.5 秒"],[3000,"3 秒"],[5000,"5 秒"],[10000,"10 秒"]]) {
    const option = document.createElement("option");
    option.value = String(ms);
    option.textContent = label;
    select.append(option);
  }
  const values = [...select.options].map(o=>Number(o.value));
  const configured = Number(state.callbackDelayMs);
  select.value = String(values.includes(configured) ? configured : 1500);
  select.addEventListener("change", async () => {
    const next = Number(select.value);
    if (!Number.isFinite(next)) return;
    state.callbackDelayMs = next;
    await persistConfig({callbackDelayMs:next});
  });
  row.append(copy, select);
  return row;
}

function switchRow(title, description, key) {
  const row = document.createElement("label");
  row.className = "webmcp-setting-row";
  row.innerHTML = '<span class="webmcp-setting-copy"><strong></strong><small></small></span><span class="webmcp-switch"><input type="checkbox"><span></span></span>';
  row.querySelector("strong").textContent = title;
  row.querySelector("small").textContent = description;
  const input = row.querySelector("input");
  input.name = key;
  input.checked = Boolean(state[key]);
  input.addEventListener("change", async () => {
    state[key] = input.checked;
    await persistConfig({[key]:input.checked});
    if (key === "hideCallbacks") scanCallbacks();
  });
  return row;
}

// Keep the complete *shape* of nested array items, required keys and strict
// additionalProperties flags. Only collapse descriptions/unrelated metadata.
function bootstrapSchema(schema = {}, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 14) return schema;
  if (Array.isArray(schema)) return schema.map(x => bootstrapSchema(x, depth + 1));
  const keep = ["type", "properties", "required", "items", "additionalProperties",
    "enum", "const", "oneOf", "anyOf", "allOf", "$ref", "$defs", "minimum",
    "maximum", "minItems", "maxItems", "pattern"];
  const result = {};
  for (const key of keep) {
    if (schema[key] === undefined) continue;
    if (key === "properties" || key === "$defs") {
      result[key] = Object.fromEntries(
        Object.entries(schema[key] || {}).map(([name, definition]) => [
          name, bootstrapSchema(definition, depth + 1)
        ])
      );
    } else {
      result[key] = bootstrapSchema(schema[key], depth + 1);
    }
  }
  if (typeof schema.description === "string") {
    result.description = schema.description.trim().slice(0, 180);
  }
  return result;
}

function buildBootstrap(fingerprint = toolFingerprint()) {
  const tools = state.tools.map(tool => {
    const description = (tool.description || "").replace(/\s+/g, " ").trim().slice(0, 260);
    return `### ${tool.name}\n${description}\narguments_schema=${JSON.stringify(bootstrapSchema(tool.inputSchema || {}))}`;
  }).join("\n");

  return [
    `WebMCP local tools are attached to this chat. schema=${fingerprint}`,
    "Use them when helpful. All tool names and argument structures below are exact JSON Schemas. Respect required fields, nested array item fields, and additionalProperties:false. Never guess or substitute key names.",
    "When calling tools, emit one or more complete blocks in your FINAL ANSWER (not DeepThink), each with unique id and strict JSON. Wrap each complete call block in a fenced plain-text code block (three backticks followed by text). The fence prevents Markdown from stripping JSON backslash escapes. WebMCP runs multiple calls in order and sends a single combined callback. Avoid batching when later arguments depend on earlier results:",
    "Required tool call format example:",
    "```text",
    CALL_OPEN,
    '{"id":"call_<unique>","tool":"<tool_name>","arguments":{}}',
    CALL_CLOSE,
    "```",
    "Example for write_stdin.chars: " + JSON.stringify({
      id:"call_2", tool:"write_stdin",
      arguments:{session_id:123,chars:"echo 'hello'\n",yield_time_ms:1500}
    }),
    "Within JSON string values, encode literal double quotes as \\\" and newline characters as \\n; never insert unescaped quotes or physical newlines into string values. Use the real numeric session_id returned by exec_command, not a quoted string.",
    "Place the marker lines and JSON inside the same fenced code block. Never use Markdown emphasis or inline code inside the JSON.",
    "For edit: arguments={\"operations\":[{\"path\":\"relative/file.txt\",\"old\":\"previous text\",\"new\":\"replacement text\"}]}. Use only old/new (not old_text/new_text or find/replace).",
    "For write: arguments={\"path\":\"relative/file.txt\",\"content\":\"new file contents\",\"create_dirs\":true}.",
    "Do not put executable tool calls only in DeepThink. A batch callback has tool=webmcp.batch and result.calls with one item per tool. After a " + RESULT_OPEN + " callback, continue the user's original request normally; call more tools only when needed.",
    "Tools and exact argument schemas:",
    tools || "- none"
  ].join("\n");
}

// Non-sensitive, on-demand presentation check. Never copies chat content,
// tool arguments, callback JSON, token values or conversation identifiers.
function callbackDisplayDiagnostics() {
  const candidates = callbackBodies();
  let confirmed = 0;
  let clipped = 0;
  let visibleRaw = 0;
  for (const body of candidates) {
    const matched = callbackMatch(body);
    const preview = matched ? null : ownedCollapsedCallback(callbackSurfaceText(body));
    if (!matched && !preview) continue;
    if (matched) confirmed++;
    else clipped++;
    const message = body.closest(".ds-message") || body;
    const row = message.closest("[data-virtual-list-item-key]");
    const hidden = message.classList.contains("webmcp-callback-hidden") ||
      row?.classList.contains("webmcp-callback-row-hidden") ||
      body.classList.contains("webmcp-callback-projection");
    if (state.hideCallbacks && !hidden && body.isConnected &&
        body.getClientRects().length) visibleRaw++;
  }
  return {version:chrome.runtime?.getManifest?.().version || "local",
    enabled:state.enabled, hideCallbacks:state.hideCallbacks,
    bridgeAuthorized:state.authorized, confirmed, clipped, visibleRaw};
}

function callbackDiagnosticsRow() {
  const row = document.createElement("div");
  row.className = "webmcp-diagnostics-row";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "检测回传显示";
  const status = document.createElement("span");
  status.className = "webmcp-diagnostics-status";
  status.setAttribute("role", "status");
  button.addEventListener("click", () => {
    // This is a display-only rescan; it does not rerun a tool or resend results.
    scanCallbacks();
    const report = callbackDisplayDiagnostics();
    status.textContent = !report.hideCallbacks
      ? "当前设置为显示原始回传"
      : report.visibleRaw
        ? `仍有 ${report.visibleRaw} 条原始回传可见，请尝试刷新页面`
        : report.confirmed + report.clipped === 0
          ? "当前聊天没有可识别的回传"
          : `${report.confirmed} 条完整回传 · ${report.clipped} 条预览 · 未检测到泄露`;
    status.title = `v${report.version} · bridge authorized: ${report.bridgeAuthorized}`;
  });
  row.append(button,status);
  return row;
}

function applyHostTheme() {
  // Scope the whole extension, including inline cards, to the host rather
  // than the OS. A namespaced variable never changes DeepSeek's own scheme.
  const trigger = document.querySelector(".webmcp-settings-trigger");
  hostThemeAncestors.clear();
  hostThemeAncestors.add(document.documentElement);
  hostThemeAncestors.add(document.body);
  let scheme = "";
  const origin = trigger?.parentElement || composer()?.parentElement || document.body;
  for (let parent = origin; parent; parent = parent.parentElement) {
    hostThemeAncestors.add(parent);
    if (scheme) continue;
    const background = getComputedStyle(parent).backgroundColor;
    if (!/^rgba?\(/.test(background)) continue;
    const channels = background.match(/[\d.]+/g)?.map(Number);
    if (!channels || channels.length < 3 || (channels.length > 3 && channels[3] < .9)) continue;
    const brightness = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    scheme = brightness < 128 ? "dark" : "light";
  }
  scheme ||= "light dark";
  if (document.documentElement.style.getPropertyValue("--webmcp-host-scheme") !== scheme) {
    document.documentElement.style.setProperty("--webmcp-host-scheme", scheme);
  }
}

function makePanel(trigger) {
  const panel = document.createElement("div");
  panel.className = "webmcp-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "MioWeave 设置");
  panel.innerHTML = [
    '<div class="webmcp-panel__header">',
    '<div class="webmcp-panel__identity"><span class="webmcp-panel__mark">' + brandIcon() + '</span><span><strong>MioWeave</strong><small>DeepSeek 本地工具</small></span></div>',
    '<button type="button" class="webmcp-panel__close" aria-label="关闭设置">×</button>',
    "</div>",
    '<div class="webmcp-connection">',
    '<span class="webmcp-connection__dot"></span>',
    '<span class="webmcp-connection__label"></span>',
    '<button type="button" class="webmcp-refresh">刷新</button>',
    "</div>",
    '<div class="webmcp-chat-state">',
    '<span class="webmcp-chat-state__icon" aria-hidden="true"></span>',
    '<span class="webmcp-chat-state__copy"><strong></strong><small></small></span>',
    '<button type="button" class="webmcp-reinit" title="下次发送消息时重新载入工具">重新同步</button>',
    "</div>",
    '<div class="webmcp-panel__section webmcp-permissions-section"><h4>执行权限</h4></div>',
    '<div class="webmcp-panel__section webmcp-behavior-section"><h4>快捷设置</h4></div>',
    '<details class="webmcp-panel__section webmcp-panel__diagnostics"><summary>诊断</summary></details>',
    '<div class="webmcp-panel__footer webmcp-quick-footer"><button type="button" class="webmcp-open-full">全部设置</button></div>'
  ].join("");

  panel.querySelector(".webmcp-permissions-section").append(autoApproveAnyRow());

  panel.querySelector(".webmcp-behavior-section").append(
    switchRow("自动运行只读工具", "status、list、read、search", "autoRunReadOnly"),
    switchRow("折叠工具回传", "隐藏原始传输消息，保留执行结果", "hideCallbacks"),
    callbackDelayRow()
  );
  panel.querySelector(".webmcp-panel__diagnostics").append(callbackDiagnosticsRow());

  panel.querySelector(".webmcp-panel__close").addEventListener("click", () => {
    closeSettingsPanel();
    trigger.focus({preventScroll:true});
  });
  panel.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeSettingsPanel();
    trigger.focus({preventScroll:true});
  });
  panel.querySelector(".webmcp-refresh").addEventListener("click", async () => {
    await refreshBridge();
    await refreshChatReady();
  });
  panel.querySelector(".webmcp-reinit").addEventListener("click", async () => {
    await clearChatInitialized();
    const button = panel.querySelector(".webmcp-reinit");
    button.textContent = "下次发送生效";
    setTimeout(() => { if (button.isConnected) button.textContent = "重新同步"; }, 1200);
  });
  panel.querySelector(".webmcp-open-full").addEventListener("click", async () => {
    await runtimeMessage({type:"WEBMCP_OPEN_OPTIONS"});
    closeSettingsPanel();
  });

  document.body.appendChild(panel);
  panel.dataset.anchor = "webmcp";
  positionPanel(trigger);
  return panel;
}

function positionPanel(trigger) {
  const panel = document.querySelector(".webmcp-panel");
  if (!panel || !trigger) return;
  applyHostTheme();
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(368, window.innerWidth - 24);
  const left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.right - width));
  panel.style.left = `${left}px`;
  const height = panel.getBoundingClientRect().height;
  const maxTop = Math.max(12, window.innerHeight - height - 12);
  const preferredTop = rect.top >= height + 10
    ? rect.top - height - 10
    : rect.bottom + 10;
  panel.style.top = `${Math.max(12, Math.min(preferredTop, maxTop))}px`;
}

function renderPanelState() {
  const panel = document.querySelector(".webmcp-panel");
  if (!panel) return;
  const dot = panel.querySelector(".webmcp-connection__dot");
  const label = panel.querySelector(".webmcp-connection__label");
  dot.className = "webmcp-connection__dot";
  if (state.authorized) dot.classList.add("webmcp-connection__dot--ok");
  else if (state.connected) dot.classList.add("webmcp-connection__dot--warn");
  label.textContent = state.authorized ? `已连接 · ${state.tools.length} 个工具` : statusLabel();

  const url = panel.querySelector(".webmcp-url");
  if (url && !url.matches(":focus")) {
    runtimeMessage({type:"WEBMCP_CONFIG_GET"}).then(response => {
      if (response?.ok && url.isConnected && !url.matches(":focus")) url.value = response.config.bridgeUrl || "";
    });
  }

  const token = panel.querySelector(".webmcp-token");
  if (token && !token.value) token.placeholder = state.tokenConfigured ? "Configured · enter to replace" : "Bridge token";

  const chatStrong = panel.querySelector(".webmcp-chat-state__copy strong");
  const chatSmall = panel.querySelector(".webmcp-chat-state__copy small");
  const chatIcon = panel.querySelector(".webmcp-chat-state__icon");
  if (chatStrong && chatSmall && chatIcon) {
    chatIcon.classList.toggle("webmcp-chat-state__icon--ready", state.chatReady);
    chatStrong.textContent = !state.enabled ? "本地工具已停用" : state.chatReady ? "工具已载入" : "等待载入工具";
    chatSmall.textContent = !state.enabled
      ? "在扩展设置中启用后即可使用。"
      : !state.authorized
        ? "连接 Bridge 后可使用本地工具。"
        : state.chatReady ? "当前聊天可调用本地工具。" : "下次发送消息时自动载入。";
  }

  refreshAutoApproveUi();
  const delaySelect = panel.querySelector(".webmcp-delay-select");
  if (delaySelect && !delaySelect.matches(":focus")) {
    const delay = Number(state.callbackDelayMs);
    delaySelect.value = String([...delaySelect.options].some(o=>Number(o.value)===delay) ? delay : 1500);
  }

  const count = panel.querySelector(".webmcp-tools-count");
  if (count) count.textContent = `${state.tools.length} tools`;

  const list = panel.querySelector(".webmcp-tool-list");
  if (list) {
    list.replaceChildren();
    for (const tool of state.tools) {
      const chip = document.createElement("div");
      chip.className = "webmcp-tool-chip";
      chip.innerHTML = '<span></span><small></small>';
      chip.querySelector("span").textContent = tool.name;
      chip.querySelector("small").textContent = tool.annotations?.readOnlyHint ? "read-only" : "approval";
      chip.title = tool.description || tool.name;
      list.appendChild(chip);
    }
    if (!state.tools.length) {
      const empty = document.createElement("div");
      empty.className = "webmcp-tools-empty";
      empty.textContent = state.bridgeError || "No tools available";
      list.appendChild(empty);
    }
  }
}

// Changes made in the full extension settings take effect in the chat tab
// without remounting controls, restarting Bridge, or persisting chat grants.
chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== "local") return;
  for (const key of ["approvalMode", "localToolLabel", "enabled",
    "autoRunReadOnly", "autoSendCallbacks", "callbackDelayMs", "hideCallbacks"]) {
    if (changes[key]) state[key] = changes[key].newValue;
  }
  if (state.approvalMode !== "ask" || !state.enabled) revokeAutoApprove();
  document.querySelectorAll(".webmcp-tool-provider").forEach(label => {
    label.textContent = state.localToolLabel || "MioDesk";
  });
  if (changes.bridgeUrl || changes.bridgeToken) void refreshBridge();
  if (changes.hideCallbacks) scanCallbacks();
  refreshUi();
});

async function openSettingsPanel(trigger) {
  closeSettingsPanel();
  state.panelOpen = true;
  const config = await runtimeMessage({type:"WEBMCP_CONFIG_GET"});
  if (!config && state.contextInvalidated) return;
  if (config?.ok) Object.assign(state, config.config);
  const panel = makePanel(trigger);
  panel.querySelector(".webmcp-panel__close").focus({preventScroll:true});
  renderPanelState();
  await refreshBridge();
  if (!state.contextInvalidated) await refreshChatReady();
}

function closeSettingsPanel() {
  document.querySelector(".webmcp-panel")?.remove();
  state.panelOpen = false;
}

function toggleSettingsPanel(trigger) {
  if (state.panelOpen) closeSettingsPanel();
  else openSettingsPanel(trigger);
}

function onDocumentPointer(event) {
  const panel = document.querySelector(".webmcp-panel");
  if (!panel || !state.panelOpen) return;
  if (panel.contains(event.target) ||
      event.target.closest?.(".webmcp-settings-trigger, .webmcp-approval-layer")) return;
  closeSettingsPanel();
}

async function bootState() {
  const config = await runtimeMessage({type:"WEBMCP_CONFIG_GET"});
  if (!config && state.contextInvalidated) return;
  if (config?.ok) Object.assign(state, config.config);
  await loadRecoveryState();
  state.recoveryReady = true;
  installObserver();
  addControls();
  refreshUi();
  await refreshBridge();
  if (!state.contextInvalidated) await refreshChatReady();
}

function onWindowResize() {
  const trigger = document.querySelector(".webmcp-settings-trigger");
  if (state.panelOpen && trigger) positionPanel(trigger);
}

document.addEventListener("pointerdown", onDocumentPointer, true);
document.addEventListener("click", interceptSend, true);
document.addEventListener("keydown", interceptSend, true);
window.addEventListener("resize", onWindowResize);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyHostTheme);

bootState();

window.addEventListener("webmcp-dev-inject", event => {
  const holder = document.createElement("div");
  holder.className = "webmcp-dev-message";
  holder.textContent = event.detail || `${CALL_OPEN}\n{"id":"dev_ping","tool":"webmcp.ping","arguments":{}}\n${CALL_CLOSE}`;
  document.body.appendChild(holder);
});
