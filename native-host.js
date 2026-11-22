#!/usr/bin/env node
// Native Messaging host. Его запускает сам Chrome, когда расширение вызывает
// chrome.runtime.connectNative("com.browser_agent.bridge").
//
//   Chrome <-stdin/stdout (4 байта длины + JSON)-> этот процесс <-unix socket-> MCP-серверы агентов
//
// Сокет: ~/.browser-agent/hosts/<pid>.sock (права 0600 — доступен только твоему пользователю).
// У каждого профиля Chrome свой хост и свой сокет; какой профиль использовать, выбирает агент
// (а при нескольких профилях — спрашивает пользователя), см. server/index.js.
// ВАЖНО: stdout здесь — канал к Chrome. Никаких console.log.

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectAgents, addAgent, removeAgent, loadConfig } from "./setup.js";

const DIR = path.join(os.homedir(), ".browser-agent");
const HOSTS = path.join(DIR, "hosts");
const SOCK = path.join(HOSTS, `${process.pid}.sock`);
const LOG = path.join(DIR, "native-host.log");
const VERSION = "0.3.3";

fs.mkdirSync(HOSTS, { recursive: true, mode: 0o700 });
const log = (...a) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} [${process.pid}] ${a.join(" ")}\n`); } catch {} };
// не даём случайному выводу сломать протокол
console.log = console.info = console.warn = (...a) => log("console:", ...a);

// ---------- Chrome <-> host (stdio) ----------
function sendToChrome(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  if (body.length > 1024 * 1024) {
    // Chrome не принимает сообщения от хоста больше 1 МБ
    if (obj.id != null) return sendToChrome({ id: obj.id, error: "Слишком большой ответ (>1 МБ)" });
    return log("drop oversized message", obj.type);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([head, body]));
}

let inBuf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32LE(0);
    if (inBuf.length < 4 + len) break;
    const raw = inBuf.subarray(4, 4 + len).toString();
    inBuf = inBuf.subarray(4 + len);
    try { onChromeMessage(JSON.parse(raw)); } catch (e) { log("bad msg from chrome", e.message); }
  }
});
process.stdin.on("end", () => shutdown("chrome closed stdin"));

// ---------- агенты (unix socket, JSON построчно) ----------
const clients = new Map(); // sock -> {cid, name, version, cwd, pid, since}
const routed = new Map();  // hostId -> {sock, id}
let seq = 1;
let cseq = 1;

const agentList = () => [...clients.values()];
const announce = () => sendToChrome({ type: "agents", list: agentList() });

function hostInfo() {
  let agents = [];
  try { agents = detectAgents(); } catch (e) { log("detect", e.message); }
  const cfg = loadConfig();
  return {
    socket: SOCK, pid: process.pid, hostVersion: VERSION, agents,
    setupCmd: `node "${path.join(cfg.appDir || path.dirname(fileURLToPath(import.meta.url)), "setup.js")}"`,
  };
}

const HOST_OPS = {
  detect: () => detectAgents(),
  add: ({ agent, trust }) => ({ message: addAgent(agent, { trust }), agents: detectAgents() }),
  remove: ({ agent }) => ({ message: removeAgent(agent), agents: detectAgents() }),
};

function onChromeMessage(msg) {
  if (msg.type === "hello") {
    log("extension hello", JSON.stringify(msg.info || {}), SOCK);
    sendToChrome({ type: "ready", ...hostInfo() });
    return announce();
  }
  if (msg.type === "ping") return sendToChrome({ type: "pong" });
  if (msg.type === "host") {
    let reply;
    try {
      const fn = HOST_OPS[msg.op];
      if (!fn) throw new Error(`Неизвестная операция ${msg.op}`);
      reply = { type: "hostResult", rid: msg.rid, result: fn(msg.args || {}) };
    } catch (e) {
      reply = { type: "hostResult", rid: msg.rid, error: String(e.message || e) };
    }
    log("host op", msg.op, JSON.stringify(msg.args || {}), reply.error || "ok");
    return sendToChrome(reply);
  }
  if (msg.type === "event") {
    // уведомление агенту (например, пользователь отключил управление)
    for (const [s, c] of clients) if (!msg.cid || c.cid === msg.cid) s.write(JSON.stringify(msg) + "\n");
    return;
  }
  const r = routed.get(msg.id);
  if (!r) return;
  routed.delete(msg.id);
  if (!r.sock.destroyed) r.sock.write(JSON.stringify({ ...msg, id: r.id }) + "\n");
}

function onClient(sock) {
  // агентом соединение становится только после hello: короткие опросы профиля (profile.info) в popup не видны
  const info = { cid: `c${cseq++}`, name: "agent", version: "", since: Date.now() };
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type === "hello") {
        Object.assign(info, {
          name: String(m.client?.name || "agent").slice(0, 60),
          version: String(m.client?.version || "").slice(0, 30),
          cwd: m.cwd ? String(m.cwd).replace(os.homedir(), "~").slice(-80) : undefined,
          pid: m.pid,
        });
        clients.set(sock, info);
        announce();
        continue;
      }
      if (m.id == null || !m.method) continue;
      const hostId = `h${seq++}`;
      routed.set(hostId, { sock, id: m.id });
      sendToChrome({ id: hostId, method: m.method, params: m.params || {}, client: info.cid });
    }
  });
  const gone = () => {
    for (const [k, r] of routed) if (r.sock === sock) routed.delete(k);
    if (clients.delete(sock)) announce();
  };
  sock.on("close", gone);
  sock.on("error", gone);
}

// старый общий сокет из версий ≤0.3.0 — убираем, чтобы старые MCP-серверы не цеплялись к мёртвому файлу
try { fs.unlinkSync(path.join(DIR, "bridge.sock")); } catch {}
try { fs.unlinkSync(SOCK); } catch {}
const server = net.createServer(onClient);
server.listen(SOCK, () => {
  try { fs.chmodSync(SOCK, 0o600); } catch (e) { log("chmod", e.message); }
  log("listening", SOCK);
});
server.on("error", (e) => { log("server error", e.message); shutdown("server error"); });

function shutdown(why) {
  log("exit:", why);
  try { server.close(); } catch {}
  try { fs.unlinkSync(SOCK); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (e) => log("uncaught", e.stack || e.message));
