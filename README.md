# Browser Agent Bridge — local host

Local part of the [Browser Agent Bridge](https://chromewebstore.google.com/detail/browser-agent-bridge/gbnocgbgcbkibldfcpjmkcopohafbfad) Chrome extension: a native messaging host and an MCP server that let AI agents in your terminal (Claude Code, Codex CLI, Gemini CLI, Cursor, OpenCode and other MCP clients) work in your own Chrome.

## Install (macOS, Linux)

```sh
curl -fsSL https://raw.githubusercontent.com/Zaruber/browser-agent-bridge-host/main/install.sh | sh -s -- --agent claude
```

`--agent` takes `claude`, `codex`, `gemini`, `cursor`, `windsurf`, `claude-desktop`, `opencode` (comma-separated), `auto` (all found) or `none`. Add `--trust` so the agent doesn't ask permission for every browser tool.

The script:
1. detects your OS and CPU;
2. uses Node.js 18+ if you have it, otherwise downloads the official Node.js LTS from nodejs.org into `~/.browser-agent/node` (no sudo, SHA-256 checked);
3. downloads this repository into `~/.browser-agent/app` and installs dependencies;
4. registers the native host for Chrome, Chromium, Brave, Edge, Arc, Vivaldi, Yandex and adds the MCP server to the chosen agents.

Run the same command again to update. Then restart your agent.

## Other commands

```sh
curl -fsSL https://raw.githubusercontent.com/Zaruber/browser-agent-bridge-host/main/install.sh | sh -s -- status
curl -fsSL https://raw.githubusercontent.com/Zaruber/browser-agent-bridge-host/main/install.sh | sh -s -- uninstall
```

Everything runs locally: commands and page data go only between the extension and the host on your computer.

This repository is generated from the main project; please don't send pull requests here.
