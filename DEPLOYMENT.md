# Tool Registry — Deployment & Architecture Reference

## What This Is

Self-extending MCP server on Cloudflare Workers + KV.
Exposes 3 meta-tools to any AI coding tool: `search_tool`, `use_tool`, `register_tool`.
Acts as a bridge between AI tools (Claude Code, Cursor, Hermes, etc.) and myagent tools running on the A1 VM.

## Live Endpoints

| Resource | Value |
|---|---|
| Worker URL | `https://tool-registry.nalepy.workers.dev` |
| MCP endpoint | `https://tool-registry.nalepy.workers.dev/mcp` |
| GitHub repo | `https://github.com/nalepy/tool-registry` |
| KV namespace ID | `7b56d106d7974fde837f26c54065cede` |
| CF account ID | `d64b1e79dc05de257ace394191d44422` |

## Secrets

| Secret | Value | Used by |
|---|---|---|
| `REGISTRY_TOKEN` | `c9f7fc2f987f6434022acf0810aef290feb62bccf18c3b5de4eecfc9745969bf` | AI tool → Worker auth |
| `MYAGENT_INVOKE_TOKEN` | `c84e60e9c28be375b44a278456aa8282dcb7a896087c8d685feeb2fad6ad4a61` | Worker → myagent `/api/invoke` auth |

## Add to Any AI Tool

```json
{
  "mcpServers": {
    "tool-registry": {
      "type": "http",
      "url": "https://tool-registry.nalepy.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer c9f7fc2f987f6434022acf0810aef290feb62bccf18c3b5de4eecfc9745969bf"
      }
    }
  }
}
```

Config file locations per tool:
| Tool | Config file |
|---|---|
| Claude Code | `~/.claude.json` → `mcpServers` key |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` in project |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code Copilot | `.vscode/mcp.json` in project |
| Hermes | `~/.hermes/config.yaml` → `mcp_servers` key |

## Architecture

```
AI tool (Claude Code / Cursor / Hermes / etc.)
         ↓  MCP call (search_tool / use_tool / register_tool)
Cloudflare Worker  [KV: tool index + tool definitions]
         ↓  POST /api/invoke  (Bearer MYAGENT_INVOKE_TOKEN)
myagent Flask UI  (https://myagent.nestorale.shop)
         ↓
A1 VM tool executes (web_search, send_whatsapp, run_shell, etc.)
```

- **Cloudflare** = permanent, global, always up. Survives myagent restarts/deploys.
- **A1 VM** = where tools actually run (secrets, browser, filesystem, long tasks).
- **KV** = tool registry persists independently from both.

## invoke Types

**`myagent_http`** — routes through myagent (for tools that need A1 secrets/state):
```json
{"type": "myagent_http", "tool": "web_search"}
```

**`worker_url`** — calls any HTTP endpoint directly (no myagent needed):
```json
{"type": "worker_url", "url": "https://app.qbotest.site/tools/get_invoice"}
```

Any app can expose tools — just add an HTTP endpoint that accepts POST JSON, register it once, done.

## Tool Name Conflicts

Current meta-tool names: `search_tool`, `use_tool`, `register_tool`

To rename: edit `name` fields in `src/index.ts` → `META_TOOLS` array + `dispatchTool()` switch → redeploy. Affects ALL connected tools simultaneously (one Worker).

Better approach for per-tool conflicts: change the MCP key name in the config (e.g. `"myagent"` instead of `"tool-registry"`). Tools like Claude Code prefix all tool names with the key: `mcp__myagent__search_tool` — no collision possible.

## Redeploy (from A1 VM)

```bash
cd ~/tool-registry && git pull
export CLOUDFLARE_API_KEY='<see OCI_Setup.md>'
export CLOUDFLARE_EMAIL='nestor.ale@gmail.com'
npx wrangler deploy
```

## Re-seed KV (after manifest.json changes)

```bash
cd ~/tool-registry && git pull
export CLOUDFLARE_API_KEY='<see OCI_Setup.md>'
export CLOUDFLARE_EMAIL='nestor.ale@gmail.com'
npm run seed
```

## myagent /api/invoke Endpoint

- URL: `https://myagent.nestorale.shop/api/invoke`
- Auth: `Bearer MYAGENT_INVOKE_TOKEN`
- Body: `{"tool": "tool_name", "args": {...}}`
- Exempt from session auth (bearer token is sufficient)
- Credential stored encrypted in `~/.config/myagent/credentials.enc` as `REGISTRY_INVOKE_TOKEN`

## Key Files

| File | Purpose |
|---|---|
| `src/index.ts` | Worker code — MCP protocol, search/use/register logic |
| `manifest.json` | 31 myagent tools — source of truth for seeding |
| `scripts/seed.ts` | Generates + uploads KV entries from manifest.json |
| `wrangler.toml` | Cloudflare config — account, KV binding, Worker name |
