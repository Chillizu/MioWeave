<p align="center"><img src="extension/icons/mioweave-logo.png" width="220" alt="MioWeave logo"></p>

# MioWeave

**Bring user-approved local tools into DeepSeek Web.** MioWeave is an experimental, unofficial Chromium extension and local MCP bridge. It renders tool calls as cards within a normal DeepSeek chat, executes permitted tools through [miodesk](https://github.com/Chillizu/miodesk), and returns concise results through the regular chat UI.

**MioWeave 是一个面向 DeepSeek 网页版的第三方本地工具扩展。** 它通过本机 miodesk MCP 服务连接文件、命令与上下文工具，并在网页上显示工具卡片和授权操作。它不是 DeepSeek 官方产品或 API。

## Features

- Read-only local tools and opt-in execution/write tools, with browser-side authorization controls.
- DeepSeek-matched popup styling and Chinese settings with system/light/dark appearance modes.
- Sequential multi-tool batches, per-tool results and explicit confirmation states.
- Size-bounded tool result callbacks (about 8 KiB per tool and 24 KiB per batch), preventing large local output from flooding chat.
- Best-effort, chat-scoped callback recovery and safeguards against silently rerunning an interrupted file modification.
- Flexible callback/Markdown projection for different DeepSeek message layouts; small/full Moon Cat branding.
- No cookie extraction, private DeepSeek API use, or CAPTCHA/rate-limit bypass.

## Requirements

- Chromium-based browser with **Developer mode** (load an unpacked extension).
- Node.js **20+** for the local bridge.
- [miodesk](https://github.com/Chillizu/miodesk) running locally at `http://127.0.0.1:8787/mcp` (or configure `MIODESK_MCP_URL`).

## Quick start

1. Clone this repository and enter its directory.
2. Generate your **own local bridge token**; do not commit or share it:

   ```bash
   mkdir -p artifacts
   umask 077
   openssl rand -hex 32 > artifacts/dev-token.txt
   ```

3. Start a **read-only** bridge, in a separate shell:

   ```bash
   ./bridge/start-readonly.sh
   ```

   On the machine running miodesk, the bridge listens on `127.0.0.1:8790` only. Keep the process running while using the extension.

4. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the **`extension/`** directory.
5. Open the MioWeave extension settings and configure:
   - Bridge URL: `http://127.0.0.1:8790`
   - Bridge token: the value generated in step 2
   - Select the desired browser-side permissions and behavior.
6. Open `https://chat.deepseek.com/`, refresh the tab, and enable **MioWeave** beside the chat controls. Try the `status` tool first.

**Advanced / higher-risk:** `./bridge/start-full.sh` enables the additional shell and write tools. This is **opt-in**. These tools operate with your local user's filesystem permissions. Keep per-tool confirmation unless you intentionally grant broader access. Do not expose the Bridge or miodesk MCP service to the public Internet.

If `curl http://127.0.0.1:8790/health` succeeds but MioWeave shows offline, verify the configured token, reload the extension and refresh the DeepSeek tab. The browser must be able to reach the machine running the bridge.

### Permissions and appearance

The popup follows the current DeepSeek chat's appearance. The standalone settings page has its own system/light/dark preference.

Inline cards, buttons, warnings and approval dialogs share the host theme even
when it differs from the OS. Theme changes synchronize before paint without a
bright card-background transition. Long statuses wrap on narrow screens, and
popovers/dialogs stay within centered-composer and short-window viewports.

- **全局授权 / Global authorization** persists across chats and reloads; enabling it requires typing `ENABLE`.
- **临时授权 / Temporary authorization** applies only to the current chat and expires when the chat changes or the page reloads.
- Both full-tool grants can allow commands and file modification/deletion **without per-call confirmation**. Only grant them when you trust the instructions and content reaching the chat. They do not change the Bridge's read-only/full mode.

会话内面板跟随 DeepSeek 主题，独立设置页可单独选择外观。全局授权长期生效，临时授权在切换会话或刷新页面后失效；两者均可能免逐次确认执行命令、修改或删除文件。

### File-backed Bridge tokens

The helper launchers use `WEBMCP_BRIDGE_TOKEN_FILE`, defaulting to `artifacts/dev-token.txt`. Keep this file private (`0600`). The Bridge rereads it on authenticated requests, so an atomic replacement takes effect without a restart; update the token saved in the extension separately. An explicitly configured `WEBMCP_BRIDGE_TOKEN` takes precedence and stays fixed for the life of the process.

Run `npm run doctor` to check the configured Core, loopback Bridge and token match without printing the token.

## Architecture

```text
DeepSeek Web tab
    ↓ (DOM, explicit tool protocol)
MioWeave content script → extension background
    ↓ HTTP, local token
MioWeave Bridge (127.0.0.1:8790)
    ↓ MCP JSON-RPC, localhost
miodesk Core (127.0.0.1:8787/mcp)
```

The bridge and extension are independently deployable from miodesk and from the optional OpenAI Secure MCP Tunnel. The tunnel is **not required** for MioWeave. This project does not expose DeepSeek as an API or create a reverse proxy to its private endpoints.

## Limitations and privacy

- This is a **browser-UI integration**, not native DeepSeek function calling. Changes to DeepSeek's DOM can break the overlay. Tool calls may need manual confirmation and page refresh.
- A rendered `Sent` state only means MioWeave observed a matching callback message in the current chat. It is **not a server-side acknowledgment from DeepSeek**. A failed callback should be inspected before trying any side-effecting tool again.
- Tool outputs posted to the DeepSeek chat **are sent to DeepSeek** as conversation content. Avoid sending secrets, private files, credentials or unnecessary local data.
- Session recovery is best-effort, has a time limit and cannot guarantee exactly-once command execution after crashes.
- Respect DeepSeek's terms and applicable laws. This third-party tool is not endorsed by DeepSeek or OpenAI.

## Development

```bash
npm test
```

`npm test` runs syntax checks, Bridge authentication/origin/size-limit regressions, and callback recovery/DOM fixtures. The tests use mocked MCP operations and isolated headless Chromium/Chrome profiles; they do **not** execute real local tools or contact DeepSeek. Recovery must be journaled before privileged dispatch or callback submission; storage failures fail closed, and uncertain submissions are not automatically replayed.

The theme regression fixture also checks both OS preferences, immediate host
theme changes, text contrast of at least 4.5:1, narrow status geometry and bounded
overlays. Visual audit screenshots and browser artifacts remain local and are
not included in the repository or release assets. Signed-in DeepSeek testing
is performed separately by the user.

No npm install is required for the runtime bridge (uses Node.js built-ins). Linux/macOS helper scripts are supplied; other systems can set `WEBMCP_BRIDGE_TOKEN` in their environment and run `node bridge/server.mjs`.

## License

MIT — see [LICENSE](LICENSE).
