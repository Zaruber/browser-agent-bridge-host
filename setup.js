#!/usr/bin/env node
// Установка и подключение агентов для Browser Agent Bridge.
//
//   node setup.js setup  [--agent claude,codex|auto|none] [--trust]
//   node setup.js add    <agent> [--trust]
//   node setup.js remove <agent>
//   node setup.js status
//   node setup.js uninstall
//
// Модуль также импортирует native-host.js: кнопки «Подключить агента» в popup.
// ВАЖНО: функции модуля ничего не пишут в stdout (у native-хоста stdout — канал к Chrome).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOME = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DIR = path.join(HOME, ".browser-agent");
const CONFIG = path.join(DIR, "config.json");
const HOST_NAME = "com.browser_agent.bridge";
const SERVER_NAME = "browser-agent";
const FALLBACK_EXT_ID = "odefbpehofbinpffkcfjnbkibblgakaa";
// ID расширения из Chrome Web Store (стор выдаёт свой ID). Впиши сюда после первой публикации.
// Дополнительно можно передать через переменную окружения BROWSER_AGENT_EXTENSION_IDS="id1,id2".
const STORE_EXTENSION_IDS = ["gbnocgbgcbkibldfcpjmkcopohafbfad"];
// Установка/обновление без папки проекта (её же показывает popup расширения)
export const INSTALL_CMD = "curl -fsSL https://raw.githubusercontent.com/Zaruber/browser-agent-bridge-host/main/install.sh | sh -s --";
const MARK_START = "<!-- browser-agent-bridge:start -->";
const MARK_END = "<!-- browser-agent-bridge:end -->";

const MEMORY = `${MARK_START}
## Браузер пользователя (browser-agent)
Любые действия в браузере (открыть сайт, найти, кликнуть, заполнить форму, скачать данные, скриншот)
делай через MCP-сервер \`browser-agent\` (инструменты \`browser_*\`). Он управляет настоящим Chrome
пользователя с его логинами и куками. Предпочитай его другим браузерным инструментам
(Playwright, chrome-devtools, Claude in Chrome), если пользователь не попросил иное.
Цикл: \`browser_tab_new\`/\`browser_navigate\` → \`browser_snapshot\` (\`mode: "interactive"\` экономит токены)
или \`browser_find\` → \`browser_click\`/\`browser_type\`/\`browser_fill_form\` по ref → изменения страницы
приходят в ответе на действие, повторный снимок обычно не нужен.
${MARK_END}`;

// ---------------- утилиты ----------------
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const BIN_DIRS = [
  path.join(HOME, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
  path.join(HOME, ".npm-global/bin"), path.join(HOME, ".bun/bin"), path.join(HOME, ".claude/local"),
  path.join(HOME, ".opencode/bin"), path.join(HOME, ".volta/bin"),
];
function which(cmd) {
  const dirs = [...(process.env.PATH || "").split(path.delimiter), ...BIN_DIRS];
  for (const d of dirs) {
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

function readJson(file, fallback = {}) {
  if (!exists(file)) return fallback;
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return fallback;
  try { return JSON.parse(raw); } catch {
    throw new Error(`${file} не является корректным JSON (возможно, там комментарии). Поправь вручную.`);
  }
}

function writeFileSafe(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (exists(file)) {
    const bak = file + ".bak-browser-agent";
    if (!exists(bak)) fs.copyFileSync(file, bak);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

const writeJson = (file, obj) => writeFileSafe(file, JSON.stringify(obj, null, 2) + "\n");

export function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { return { agents: {} }; }
}
function saveConfig(cfg) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
}

// Сервер, который будут запускать агенты. Если нас запустили из временного кэша npx —
// копируем сервер в ~/.browser-agent/app, чтобы путь в конфигах агентов не протух.
function appDir() {
  if (!/[\\/](_npx|\.npm)[\\/]/.test(HERE)) return HERE;
  const dst = path.join(DIR, "app");
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ["index.js", "native-host.js", "setup.js", "package.json"]) {
    fs.copyFileSync(path.join(HERE, f), path.join(dst, f));
  }
  spawnSync("npm", ["install", "--omit=dev", "--silent"], { cwd: dst, stdio: "pipe" });
  return dst;
}

// Путь к node, который переживёт обновление (brew Cellar/<версия> → /opt/homebrew/bin/node)
function stableNode() {
  const real = fs.realpathSync(process.execPath);
  for (const cand of [which("node"), "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
    try { if (cand && fs.realpathSync(cand) === real) return cand; } catch {}
  }
  return process.execPath;
}

export function serverCommand() {
  const cfg = loadConfig();
  const dir = cfg.appDir && exists(path.join(cfg.appDir, "index.js")) ? cfg.appDir : HERE;
  return { command: cfg.node || stableNode(), args: [path.join(dir, "index.js")] };
}

function extensionId() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(HERE, "..", "extension", "manifest.json"), "utf8"));
    const hex = crypto.createHash("sha256").update(Buffer.from(m.key, "base64")).digest("hex").slice(0, 32);
    return [...hex].map((c) => "abcdefghijklmnop"[parseInt(c, 16)]).join("");
  } catch { return FALLBACK_EXT_ID; }
}

function upsertMemory(file) {
  const cur = exists(file) ? fs.readFileSync(file, "utf8") : "";
  const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
  const next = re.test(cur) ? cur.replace(re, MEMORY) : (cur.trimEnd() + (cur.trim() ? "\n\n" : "") + MEMORY + "\n");
  if (next !== cur) writeFileSafe(file, next);
}
function dropMemory(file) {
  if (!exists(file)) return;
  const cur = fs.readFileSync(file, "utf8");
  const next = cur.replace(new RegExp(`\\n*${MARK_START}[\\s\\S]*?${MARK_END}\\n?`), "\n");
  if (next === cur) return;
  if (next.trim()) writeFileSafe(file, next);
  else fs.unlinkSync(file);
}

// JSON-конфиги вида { <key>: { "browser-agent": {...} } }
function jsonAgent(file, key = "mcpServers", entry = (c) => ({ command: c.command, args: c.args })) {
  return {
    configured: () => { try { return !!readJson(file)[key]?.[SERVER_NAME]; } catch { return false; } },
    add: (c, opts) => {
      const j = readJson(file);
      j[key] = { ...(j[key] || {}), [SERVER_NAME]: entry(c, opts) };
      writeJson(file, j);
      return `MCP прописан в ${file.replace(HOME, "~")}`;
    },
    remove: () => {
      if (!exists(file)) return;
      const j = readJson(file);
      if (j[key]?.[SERVER_NAME]) { delete j[key][SERVER_NAME]; writeJson(file, j); }
    },
  };
}

// ---------------- агенты ----------------
const P = (...a) => path.join(HOME, ...a);
const APP_SUPPORT = process.platform === "darwin" ? P("Library/Application Support") : P(".config");

const claudeJson = jsonAgent(P(".claude.json"), "mcpServers", (c) => ({ type: "stdio", command: c.command, args: c.args, env: {} }));

export const AGENTS = {
  claude: {
    title: "Claude Code",
    installed: () => !!which("claude") || exists(P(".claude")),
    memory: P(".claude", "CLAUDE.md"),
    configured: claudeJson.configured,
    add(c, { trust } = {}) {
      const bin = which("claude");
      let how;
      if (bin) {
        const env = { ...process.env, PATH: [...BIN_DIRS, process.env.PATH].join(path.delimiter) };
        spawnSync(bin, ["mcp", "remove", SERVER_NAME, "-s", "user"], { stdio: "pipe", env, timeout: 30_000 });
        const r = spawnSync(bin, ["mcp", "add-json", SERVER_NAME, JSON.stringify({ type: "stdio", ...c }), "-s", "user"],
          { stdio: "pipe", env, timeout: 30_000 });
        if (r.status === 0) how = "через `claude mcp add-json -s user`";
      }
      if (!how) { claudeJson.add(c); how = "в ~/.claude.json"; }
      const settingsFile = P(".claude", "settings.json");
      const s = readJson(settingsFile);
      const allow = new Set(s.permissions?.allow || []);
      const had = allow.has(`mcp__${SERVER_NAME}`);
      if (trust) allow.add(`mcp__${SERVER_NAME}`); else allow.delete(`mcp__${SERVER_NAME}`);
      if (had !== !!trust) { s.permissions = { ...(s.permissions || {}), allow: [...allow] }; writeJson(settingsFile, s); }
      return `MCP прописан ${how}${trust ? "; инструменты браузера разрешены без запросов" : ""}`;
    },
    remove() {
      const bin = which("claude");
      if (bin) spawnSync(bin, ["mcp", "remove", SERVER_NAME, "-s", "user"], { stdio: "pipe", timeout: 30_000 });
      claudeJson.remove();
      const settingsFile = P(".claude", "settings.json");
      const s = readJson(settingsFile);
      if (s.permissions?.allow?.includes(`mcp__${SERVER_NAME}`)) {
        s.permissions.allow = s.permissions.allow.filter((x) => x !== `mcp__${SERVER_NAME}`);
        writeJson(settingsFile, s);
      }
    },
  },

  codex: (() => {
    const file = P(".codex", "config.toml");
    const header = /^\[mcp_servers\.(?:"browser-agent"|browser-agent)(?:\.[^\]]+)?\]\s*$/;
    const strip = (txt) => {
      const out = [];
      let skip = false;
      for (const line of txt.split("\n")) {
        if (/^\s*\[/.test(line)) skip = header.test(line.trim());
        if (!skip) out.push(line);
      }
      return out.join("\n").replace(/\n{3,}/g, "\n\n");
    };
    return {
      title: "Codex CLI",
      installed: () => !!which("codex") || exists(P(".codex")),
      memory: P(".codex", "AGENTS.md"),
      configured: () => exists(file) && fs.readFileSync(file, "utf8").split("\n").some((l) => header.test(l.trim())),
      add(c) {
        const cur = exists(file) ? fs.readFileSync(file, "utf8") : "";
        const block = `[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(c.command)}\nargs = ${JSON.stringify(c.args)}\n`;
        writeFileSafe(file, strip(cur).trimEnd() + (cur.trim() ? "\n\n" : "") + block);
        return `MCP прописан в ${file.replace(HOME, "~")}`;
      },
      remove() { if (exists(file)) writeFileSafe(file, strip(fs.readFileSync(file, "utf8")).trimEnd() + "\n"); },
    };
  })(),

  gemini: {
    title: "Gemini CLI",
    installed: () => !!which("gemini") || exists(P(".gemini")),
    memory: P(".gemini", "GEMINI.md"),
    ...jsonAgent(P(".gemini", "settings.json"), "mcpServers",
      (c, o = {}) => ({ command: c.command, args: c.args, ...(o.trust ? { trust: true } : {}) })),
  },

  cursor: {
    title: "Cursor",
    installed: () => exists(P(".cursor")) || exists("/Applications/Cursor.app"),
    ...jsonAgent(P(".cursor", "mcp.json")),
  },

  windsurf: {
    title: "Windsurf",
    installed: () => exists(P(".codeium", "windsurf")) || exists("/Applications/Windsurf.app"),
    ...jsonAgent(P(".codeium", "windsurf", "mcp_config.json")),
  },

  "claude-desktop": {
    title: "Claude Desktop",
    installed: () => exists("/Applications/Claude.app") || exists(path.join(APP_SUPPORT, "Claude")),
    ...jsonAgent(path.join(APP_SUPPORT, "Claude", "claude_desktop_config.json")),
  },

  opencode: {
    title: "OpenCode",
    installed: () => !!which("opencode") || exists(P(".config", "opencode")),
    memory: P(".config", "opencode", "AGENTS.md"),
    ...jsonAgent(P(".config", "opencode", "opencode.json"), "mcp",
      (c) => ({ type: "local", command: [c.command, ...c.args], enabled: true })),
  },
};

export function detectAgents() {
  const cfg = loadConfig();
  return Object.entries(AGENTS).map(([id, a]) => {
    let configured = false;
    try { configured = a.configured(); } catch {}
    return { id, title: a.title, installed: a.installed(), configured, trust: !!cfg.agents?.[id]?.trust };
  });
}

// ---------------- native-хост ----------------
export function installHost() {
  const log = [];
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DIR, 0o700);
  const app = appDir();
  const node = stableNode();
  const wrapper = path.join(DIR, "native-host.sh");
  // Chrome запускает хост без PATH пользователя, поэтому абсолютный путь к node
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${node}" "${path.join(app, "native-host.js")}" "$@"\n`, { mode: 0o755 });
  fs.chmodSync(wrapper, 0o755);

  const extId = extensionId();
  const manifest = JSON.stringify({
    name: HOST_NAME,
    description: "Browser Agent Bridge native host",
    path: wrapper,
    type: "stdio",
    allowed_origins: [...new Set([extId, ...STORE_EXTENSION_IDS,
      ...(process.env.BROWSER_AGENT_EXTENSION_IDS || "").split(",").map((x) => x.trim()).filter(Boolean)])]
      .map((id) => `chrome-extension://${id}/`),
  }, null, 2) + "\n";

  const browsers = process.platform === "darwin"
    ? ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome Canary", "Chromium",
       "BraveSoftware/Brave-Browser", "Microsoft Edge", "Arc/User Data", "Vivaldi", "Yandex/YandexBrowser"]
        .map((b) => path.join(APP_SUPPORT, b))
    : ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium", "BraveSoftware/Brave-Browser",
       "microsoft-edge", "vivaldi", "yandex-browser"].map((b) => P(".config", b));
  for (const base of browsers) {
    if (!exists(base)) continue;
    const d = path.join(base, "NativeMessagingHosts");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${HOST_NAME}.json`), manifest);
    log.push(`✓ native-хост зарегистрирован: ${path.relative(HOME, base) || base}`);
  }
  if (!log.length) log.push("⚠ Не найден ни один Chromium-браузер. Поставь Chrome и повтори.");

  const cfg = loadConfig();
  Object.assign(cfg, { version: 3, appDir: app, node, extensionId: extId, installedAt: cfg.installedAt || new Date().toISOString() });
  saveConfig(cfg);
  return { log, extId };
}

export function addAgent(id, { trust = false } = {}) {
  const a = AGENTS[id];
  if (!a) throw new Error(`Неизвестный агент «${id}». Доступны: ${Object.keys(AGENTS).join(", ")}`);
  const msg = a.add(serverCommand(), { trust });
  if (a.memory) upsertMemory(a.memory);
  const cfg = loadConfig();
  cfg.agents = { ...(cfg.agents || {}), [id]: { at: new Date().toISOString(), trust } };
  saveConfig(cfg);
  return `✓ ${a.title}: ${msg}${a.memory ? `; инструкция добавлена в ${a.memory.replace(HOME, "~")}` : ""}`;
}

export function removeAgent(id) {
  const a = AGENTS[id];
  if (!a) throw new Error(`Неизвестный агент «${id}»`);
  a.remove();
  if (a.memory) dropMemory(a.memory);
  const cfg = loadConfig();
  delete cfg.agents?.[id];
  saveConfig(cfg);
  return `✓ ${a.title} отключён`;
}

function uninstall() {
  const log = [];
  for (const id of Object.keys(AGENTS)) {
    try { if (AGENTS[id].configured()) log.push(removeAgent(id)); } catch (e) { log.push(`⚠ ${id}: ${e.message}`); }
  }
  const roots = process.platform === "darwin" ? [APP_SUPPORT] : [P(".config")];
  for (const root of roots) {
    const walk = (d, depth) => {
      if (depth > 3) return;
      let items = [];
      try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        if (!it.isDirectory()) continue;
        const p = path.join(d, it.name);
        if (it.name === "NativeMessagingHosts") {
          const f = path.join(p, `${HOST_NAME}.json`);
          if (exists(f)) { fs.unlinkSync(f); log.push(`✓ удалён ${f.replace(HOME, "~")}`); }
        } else walk(p, depth + 1);
      }
    };
    walk(root, 0);
  }
  return log;
}

// ---------------- CLI ----------------
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--trust") o.trust = true;
    else if (a === "--agent" || a === "-a") o.agent = argv[++i];
    else if (a.startsWith("--agent=")) o.agent = a.slice(8);
    else if (a === "-h" || a === "--help") o.help = true;
    else o._.push(a);
  }
  return o;
}

function cli() {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o._[0] || "setup";
  const out = (s) => process.stdout.write(s + "\n");
  if (o.help) {
    out(`Использование:
  setup [--agent claude,codex|auto|none] [--trust]   установка хоста и подключение агентов
  add <agent> [--trust]                              подключить агента
  remove <agent>                                     отключить агента
  status                                             что установлено
  uninstall                                          удалить всё

Агенты: ${Object.entries(AGENTS).map(([k, a]) => `${k} (${a.title})`).join(", ")}
--trust: агент не будет спрашивать разрешение на каждый инструмент браузера (Claude Code, Gemini CLI)`);
    return;
  }
  try {
    if (cmd === "setup") {
      const { log, extId } = installHost();
      log.forEach(out);
      let list = (o.agent || "auto").split(",").map((s) => s.trim()).filter(Boolean);
      if (list.includes("auto")) list = detectAgents().filter((a) => a.installed).map((a) => a.id);
      if (list.includes("none")) list = [];
      for (const id of list) {
        try { out(addAgent(id, { trust: o.trust })); } catch (e) { out(`⚠ ${id}: ${e.message}`); }
      }
      if (!list.length) out(`Агенты не выбраны. Подключить позже: из popup расширения или командой ${INSTALL_CMD} --agent claude`);
      out(`\nID расширения: ${extId}`);
      out("Готово. Открой popup расширения: статус обновится сам. Перезапусти агента, чтобы он подхватил MCP.");
    } else if (cmd === "add") {
      out(addAgent(o._[1] || o.agent, { trust: o.trust }));
    } else if (cmd === "remove") {
      out(removeAgent(o._[1] || o.agent));
    } else if (cmd === "status") {
      const cfg = loadConfig();
      out(`Каталог: ${DIR}\nСервер: ${serverCommand().args[0]}\nПрофилей Chrome подключено: ${(() => { try { return fs.readdirSync(path.join(DIR, "hosts")).filter((f) => f.endsWith(".sock")).length; } catch { return 0; } })()}`);
      for (const a of detectAgents()) out(`${a.configured ? "✓" : a.installed ? "·" : " "} ${a.title.padEnd(15)} ${a.configured ? "подключён" : a.installed ? "установлен, не подключён" : "не найден"}${a.trust ? " (без запросов)" : ""}`);
      if (cfg.installedAt) out(`Установлено: ${cfg.installedAt}`);
    } else if (cmd === "uninstall") {
      uninstall().forEach(out);
      out("Готово. Само расширение удали в chrome://extensions.");
    } else {
      out(`Неизвестная команда ${cmd}. См. --help`);
      process.exitCode = 1;
    }
  } catch (e) {
    out(`✗ ${e.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) cli();
