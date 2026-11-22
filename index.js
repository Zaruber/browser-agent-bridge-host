#!/usr/bin/env node
// Browser Agent Bridge — MCP-сервер (stdio) для терминальных агентов.
//
//   агент --stdio/MCP--> этот процесс --unix socket--> native-host.js (по одному на профиль Chrome) --native messaging--> расширение
//
// native-host.js запускает сам Chrome (как у стокового Claude in Chrome), поэтому ни порта, ни токена нет.
// Любое число агентов может подключиться одновременно; у каждого своя «текущая вкладка» и группа вкладок.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = "0.3.3";
const DEFAULT_TIMEOUT_MS = 90_000;
// действия могут ждать подтверждения пользователя в Chrome
const LONG_TIMEOUT_MS = 200_000;
const LONG = new Set(["page.click", "page.type", "page.fill", "page.key", "page.navigate", "page.upload", "page.evaluate", "page.select", "tabs.create"]);
const CHUNK = 512 * 1024; // native messaging: сообщения хост→Chrome ограничены 1 МБ
const MAX_UPLOAD = 25 * 1024 * 1024;

const log = (...a) => process.stderr.write(`[browser-agent] ${a.join(" ")}\n`);

const NO_EXT =
  "Нет связи с Chrome. Проверь, что Chrome открыт и расширение Browser Agent Bridge включено " +
  "(на иконке бейдж ON или число агентов). Если хост не установлен или сломался, выполни: " +
  "curl -fsSL https://raw.githubusercontent.com/Zaruber/browser-agent-bridge-host/main/install.sh | sh " +
  "и открой popup расширения.";

// ---------- профили Chrome ----------
// У каждого профиля Chrome с расширением свой native-хост и свой сокет ~/.browser-agent/hosts/<pid>.sock.
// Профиль один — подключаемся сами. Профилей несколько — инструменты просят агента спросить пользователя,
// какой использовать (browser_profile_select). Выбор можно задать заранее: BROWSER_AGENT_PROFILE=<id или имя>.
const HOSTS = path.join(os.homedir(), ".browser-agent", "hosts");

let choice = process.env.BROWSER_AGENT_PROFILE
  ? { key: process.env.BROWSER_AGENT_PROFILE.trim(), explicit: true }
  : null; // {id?, key?, name, explicit}
let lastList = [];

const sockFiles = () => {
  try { return fs.readdirSync(HOSTS).filter((f) => f.endsWith(".sock")).map((f) => path.join(HOSTS, f)); } catch { return []; }
};

// разовый запрос profile.info к хосту (агентом в popup не считается: hello не отправляем)
function probe(file, ms = 3000) {
  return new Promise((resolve) => {
    const s = net.createConnection(file);
    let buf = "";
    let done = false;
    const fin = (v) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); resolve(v); };
    const timer = setTimeout(() => fin(null), ms);
    s.setEncoding("utf8");
    s.once("connect", () => s.write(JSON.stringify({ id: 1, method: "profile.info", params: {} }) + "\n"));
    s.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        let m;
        try { m = JSON.parse(buf.slice(0, i)); } catch {}
        buf = buf.slice(i + 1);
        if (!m || m.type || m.id !== 1) continue;
        // старое расширение без profile.info — профиль всё равно доступен
        fin(m.error ? { file, id: path.basename(file, ".sock"), name: "", active: [] } : { file, ...m.result });
      }
    });
    s.on("error", (e) => {
      if (e.code === "ECONNREFUSED") { try { fs.unlinkSync(file); } catch {} } // хост умер, сокет остался
      fin(null);
    });
    s.on("close", () => fin(null));
  });
}

async function discover() {
  const list = (await Promise.all(sockFiles().map((f) => probe(f)))).filter(Boolean);
  list.sort((a, b) => (a.name || "￿").localeCompare(b.name || "￿") || String(a.id).localeCompare(String(b.id)));
  lastList = list;
  return list;
}

const profileTitle = (p) => (p.name ? `«${p.name}»` : "профиль без имени") + ` (id ${p.id})`;
function describe(list) {
  const cur = sock && !sock.destroyed ? sockPath : null;
  return list.map((p, i) => {
    const bits = [`окон ${p.windows ?? "?"}`, `вкладок ${p.tabs ?? "?"}`];
    if (p.focused) bits.push("сейчас на переднем плане");
    if (p.agents?.length) bits.push(`агенты: ${p.agents.join(", ")}`);
    if (p.enabled === false) bits.push("управление выключено в popup");
    const act = p.active?.length ? `\n   активные вкладки: ${p.active.map((t) => `«${t}»`).join(", ")}` : "";
    return `${i + 1}. ${p.file === cur ? "★ " : ""}${profileTitle(p)}: ${bits.join(", ")}${act}`;
  }).join("\n");
}
const askUser = (list, lead = "В Chrome открыто несколько профилей с расширением Browser Agent Bridge:") =>
  `${lead}\n${describe(list)}\n\n` +
  "НЕ выбирай профиль сам. Спроси пользователя в чате, в каком профиле Chrome работать, и перечисли ему эти варианты " +
  "(имя, активные вкладки). После ответа вызови browser_profile_select {profile: \"<номер, id или имя>\"} и повтори действие. " +
  "Имя профилю пользователь может задать в popup расширения → «Агенты».";

function matchProfile(list, key) {
  const k = String(key).trim().toLowerCase();
  if (/^\d+$/.test(k) && list[Number(k) - 1] && Number(k) <= list.length && k.length < 4) return list[Number(k) - 1];
  return list.find((p) => String(p.id).toLowerCase() === k) || list.find((p) => (p.name || "").toLowerCase() === k)
    || list.find((p) => p.name && p.name.toLowerCase().includes(k));
}

// какой хост использовать; бросает ошибку с просьбой спросить пользователя, если выбор неоднозначен
async function pickHost() {
  const list = await discover();
  if (!list.length) throw new Error(NO_EXT);
  if (choice?.explicit) {
    const p = choice.id ? list.find((x) => x.id === choice.id) : matchProfile(list, choice.key);
    if (p) { Object.assign(choice, { id: p.id, name: p.name }); return p; }
    if (list.length === 1 && !choice.id) throw new Error(`Профиль «${choice.key}» не найден.\n` + askUser(list, "Сейчас подключён один профиль:"));
    throw new Error(askUser(list, `Выбранный профиль ${choice.name ? `«${choice.name}»` : choice.id || choice.key} сейчас не подключён ` +
      "(Chrome с ним закрыт или расширение выключено). Подключены:"));
  }
  if (list.length === 1) { choice = { id: list[0].id, name: list[0].name, explicit: false }; return list[0]; }
  throw new Error(askUser(list));
}

// ---------- связь с native-хостом (unix socket, JSON построчно) ----------
let sock = null;
let sockPath = null;
let connecting = null;
let nextId = 1;
const pending = new Map();
let clientInfo = null;

function hello() {
  if (!sock || sock.destroyed) return;
  sock.write(JSON.stringify({
    type: "hello",
    client: clientInfo || { name: "agent" },
    cwd: process.cwd(),
    pid: process.pid,
  }) + "\n");
}

function connectTo(file) {
  if (sock && !sock.destroyed && sockPath === file) return Promise.resolve(sock);
  if (sock && !sock.destroyed) { const old = sock; sock = null; old.destroy(); } // переключение профиля
  return new Promise((resolve, reject) => {
    const s = net.createConnection(file);
    let buf = "";
    s.setEncoding("utf8");
    s.once("connect", () => { sock = s; sockPath = file; hello(); resolve(s); });
    s.once("error", () => { if (sock !== s) reject(new Error(NO_EXT)); });
    s.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { settle(JSON.parse(line)); } catch {}
      }
    });
    s.on("close", () => {
      if (sock === s) sock = null;
      for (const [id, p] of pending) if (p.sock === s) settle({ id, error: "Связь с Chrome оборвалась (Chrome закрыт или расширение перезагружено). Повтори действие." });
    });
  });
}

async function connect() {
  // уже подключены; если профиль выбран не явно, а профилей стало больше одного — надо спросить пользователя
  if (sock && !sock.destroyed && (choice?.explicit || sockFiles().length <= 1)) return sock;
  if (connecting) return connecting;
  connecting = pickHost().then((p) => connectTo(p.file)).finally(() => (connecting = null));
  return connecting;
}

// Держим соединение, чтобы popup расширения показывал «агент подключён» с самого старта сессии.
// Без явного выбора подключаемся в фоне, только если профиль один.
setInterval(() => {
  if (sock && !sock.destroyed) return;
  if (choice?.explicit || sockFiles().length === 1) connect().catch(() => {});
}, 3000).unref();

function settle(msg) {
  if (msg.type) return; // события от хоста
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
}

async function call(method, params = {}) {
  const s = await connect();
  const id = nextId++;
  const ms = LONG.has(method) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Таймаут ${method} (${ms / 1000} с)`)); }, ms);
    pending.set(id, { resolve, reject, timer, sock: s });
    s.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

// ---------- MCP ----------
// Коротко: Codex приклеивает эти инструкции к описанию КАЖДОГО инструмента (~30 раз)
const INSTRUCTIONS = `Настоящий Chrome пользователя (вкладки, логины). Цикл: browser_tab_new {url} (вкладка становится текущей) → \
browser_snapshot {mode:"interactive"} или browser_find → browser_click/type/fill_form по ref; действия сами возвращают изменения страницы. \
Несколько профилей Chrome → спроси пользователя, какой, затем browser_profile_select. \
Риск (оплата, удаление, отправка) пользователь подтверждает в Chrome — жди. Элемент перекрыт — закрой баннер и повтори.`;

const mcp = new McpServer({ name: "browser-agent", version: VERSION }, { instructions: INSTRUCTIONS });

mcp.server.oninitialized = () => {
  clientInfo = mcp.server.getClientVersion() || null;
  hello();
};

const asText = (v) => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});

function tool(name, description, shape, handler) {
  const run = typeof handler === "string" ? async (args) => asText(await call(handler, args)) : handler;
  mcp.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      return await run(args);
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e.message || e) }] };
    }
  });
}

const tabId = z.number().int().optional().describe("ID вкладки; по умолчанию — твоя текущая вкладка");
const ref = z.string().describe("ref элемента из browser_snapshot/browser_find, например e12 или f3.e5");
const snapshot = z.enum(["diff", "interactive", "full", "none"]).optional()
  .describe("что вернуть после действия: diff (по умолчанию) — изменения страницы; interactive/full — снимок; none — ничего");

tool("browser_profiles", "Профили Chrome, в которых включено расширение (★ — тот, с которым ты работаешь). " +
  "Если их несколько, спроси пользователя, какой использовать, и вызови browser_profile_select.", {}, async () => {
  const list = await discover();
  if (!list.length) throw new Error(NO_EXT);
  return asText(`${describe(list)}\n\n` + (choice?.explicit && sock && !sock.destroyed
    ? "Сменить профиль: browser_profile_select {profile}."
    : list.length > 1 ? "Спроси пользователя, какой профиль использовать, затем browser_profile_select {profile}." : "Профиль один, он выбран автоматически."));
});

tool("browser_profile_select", "Выбрать профиль Chrome для работы (номер из browser_profiles, id или имя). " +
  "Вызывай только после ответа пользователя, какой профиль использовать.", {
  profile: z.string().describe("номер из списка, id профиля или его имя"),
}, async ({ profile }) => {
  const list = lastList.length ? lastList : await discover();
  let p = matchProfile(list, profile);
  if (!p) {
    const fresh = await discover();
    p = matchProfile(fresh, profile);
    if (!p) throw new Error(`Профиль «${profile}» не найден. Подключены:\n${describe(fresh)}`);
  }
  choice = { id: p.id, name: p.name, explicit: true };
  await connectTo(p.file);
  return asText(`Выбран: ${profileTitle(p)}. Дальше все команды работают в нём.`);
});

tool("browser_tabs", "Список вкладок. ★ — твоя текущая вкладка, [agent: …] — вкладки других агентов.", {}, "tabs.list");

tool("browser_tab_new", "Открыть новую вкладку (в группе вкладок агента) и сделать её текущей.", {
  url: z.string().optional(),
  active: z.boolean().optional().describe("переключить на неё окно (по умолчанию true)"),
}, "tabs.create");

tool("browser_tab_close", "Закрыть вкладку.", { tabId: z.number().int() }, "tabs.close");

tool("browser_tab_select", "Сделать вкладку текущей для тебя (и активной в окне).", { tabId: z.number().int() }, "tabs.select");

tool("browser_navigate", "Перейти по URL (или back/forward/reload) и дождаться загрузки. Возвращает интерактивный снимок.", {
  tabId,
  url: z.string().describe("URL, либо 'back' | 'forward' | 'reload'"),
  snapshot,
}, "page.navigate");

tool(
  "browser_snapshot",
  "Снимок страницы с ref для действий. mode=interactive: только интерактивные элементы и заголовки (дёшево). " +
    "mode=full: плюс текст. Содержимое iframe идёт отдельными секциями.",
  {
    tabId,
    mode: z.enum(["full", "interactive"]).optional().describe("по умолчанию full"),
    maxChars: z.number().int().optional().describe("лимит символов, по умолчанию 25000"),
    frames: z.boolean().optional().describe("включать iframe (по умолчанию true)"),
  },
  "page.snapshot"
);

tool("browser_find", "Найти элементы по тексту/подписи/placeholder (без полного снимка). Возвращает строки с ref.", {
  tabId,
  query: z.string(),
  limit: z.number().int().optional().describe("по умолчанию 15"),
}, "page.find");

tool("browser_click", "Клик по элементу (ref) или по координатам x,y (CSS-пиксели вьюпорта). Проверяет, что элемент не перекрыт.", {
  tabId,
  ref: ref.optional(),
  x: z.number().optional(), y: z.number().optional(),
  button: z.enum(["left", "right", "middle"]).optional(),
  doubleClick: z.boolean().optional(),
  modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).optional().describe("например Meta — открыть ссылку в новой вкладке"),
  force: z.boolean().optional().describe("кликнуть, даже если элемент перекрыт"),
  snapshot,
}, "page.click");

tool("browser_type", "Ввести текст в поле (ref или текущий фокус).", {
  tabId,
  ref: ref.optional(),
  text: z.string(),
  clear: z.boolean().optional().describe("очистить поле перед вводом (по умолчанию true)"),
  submit: z.boolean().optional().describe("нажать Enter после ввода"),
  snapshot,
}, "page.type");

tool("browser_fill_form", "Заполнить несколько полей за раз. value: строка для текста/select, true/false для чекбоксов и радио.", {
  tabId,
  fields: z.array(z.object({
    ref,
    value: z.union([z.string(), z.boolean(), z.array(z.string())]),
  })).min(1),
  snapshot,
}, "page.fill");

tool("browser_select_option", "Выбрать значение(я) в <select> (по value или тексту).", {
  tabId, ref, values: z.array(z.string()), snapshot,
}, "page.select");

tool("browser_press_key", "Нажать клавишу: Enter, Tab, Escape, ArrowDown, Backspace, a… Сочетания: 'Control+a', 'Meta+l', 'Shift+Tab'.", {
  tabId, key: z.string(), snapshot,
}, "page.key");

tool("browser_hover", "Навести курсор на элемент.", { tabId, ref, snapshot }, "page.hover");

tool("browser_scroll", "Прокрутить страницу на dx/dy пикселей или до элемента ref.", {
  tabId,
  ref: ref.optional(),
  dx: z.number().optional(),
  dy: z.number().optional().describe("по умолчанию 600"),
}, "page.scroll");

tool("browser_handle_dialog", "Ответить на alert/confirm/prompt/beforeunload, открытый на странице.", {
  tabId,
  accept: z.boolean().optional().describe("OK (по умолчанию) или Отмена"),
  promptText: z.string().optional(),
}, "page.dialog");

tool(
  "browser_file_upload",
  "Загрузить локальные файлы в поле <input type=file> или в drop-зону. ref — само поле, кнопка «Загрузить» рядом с ним или drop-зона; " +
    "без ref — единственное поле файла на странице.",
  { tabId, ref: ref.optional(), paths: z.array(z.string()).min(1).describe("абсолютные пути к файлам") },
  async ({ tabId, ref, paths }) => {
    const files = [];
    for (const p of paths) {
      const abs = path.resolve(p.replace(/^~(?=\/)/, os.homedir()));
      const st = fs.statSync(abs);
      if (!st.isFile()) throw new Error(`${abs} — не файл`);
      if (st.size > MAX_UPLOAD) throw new Error(`${abs} больше ${MAX_UPLOAD / 1024 / 1024} МБ`);
      const b64 = fs.readFileSync(abs).toString("base64");
      const key = `u${Date.now()}_${Math.random().toString(36).slice(2)}`;
      for (let i = 0; i < b64.length; i += CHUNK) await call("file.chunk", { key, data: b64.slice(i, i + CHUNK) });
      files.push({ key, name: path.basename(abs), mime: mimeOf(abs) });
    }
    return asText(await call("page.upload", { tabId, ref, files }));
  }
);

tool(
  "browser_screenshot",
  "Скриншот видимой области (или всей страницы, или одного элемента). labels=true подписывает ref на элементах. " +
    "Координаты на картинке = CSS-пиксели для browser_click. savePath — сохранить в файл.",
  {
    tabId,
    ref: ref.optional().describe("снять только этот элемент"),
    fullPage: z.boolean().optional(),
    labels: z.boolean().optional().describe("нарисовать ref поверх интерактивных элементов"),
    quality: z.number().int().min(1).max(100).optional().describe("JPEG, по умолчанию 70"),
    savePath: z.string().optional().describe("путь для сохранения .jpg/.png"),
  },
  async ({ savePath, ...args }) => {
    if (savePath && /\.png$/i.test(savePath)) args.format = "png";
    const r = await call("page.screenshot", args);
    const content = [{ type: "image", data: r.data, mimeType: r.mimeType }];
    if (savePath) {
      const abs = path.resolve(savePath.replace(/^~(?=\/)/, os.homedir()));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from(r.data, "base64"));
      content.push({ type: "text", text: `Сохранено: ${abs}` });
    }
    if (r.note) content.push({ type: "text", text: r.note });
    return { content };
  }
);

tool("browser_get_text", "Видимый текст страницы (innerText).", {
  tabId, maxChars: z.number().int().optional().describe("по умолчанию 40000"),
}, "page.text");

tool("browser_evaluate", "Выполнить JavaScript в странице и вернуть результат (поддерживает await).", {
  tabId, expression: z.string(),
}, "page.evaluate");

tool("browser_wait_for", "Подождать появления (или исчезновения) текста/селектора, либо просто timeoutMs.", {
  tabId,
  text: z.string().optional(), selector: z.string().optional(),
  gone: z.boolean().optional().describe("ждать исчезновения"),
  timeoutMs: z.number().int().optional().describe("по умолчанию 10000"),
}, "page.waitFor");

tool("browser_console", "Последние сообщения консоли и ошибки JS вкладки.", {
  tabId, level: z.enum(["all", "error", "warning"]).optional(), clear: z.boolean().optional(),
}, "page.console");

tool("browser_network", "Сетевые запросы вкладки (id, method, url, status). С requestId — тело ответа.", {
  tabId,
  filter: z.string().optional().describe("подстрока URL"),
  requestId: z.string().optional().describe("вернуть тело ответа этого запроса"),
  clear: z.boolean().optional(),
}, "page.network");

tool("browser_cookies", "Куки текущего сайта (по умолчанию без значений).", {
  tabId, values: z.boolean().optional().describe("включить значения"), urls: z.array(z.string()).optional(),
}, "page.cookies");

tool("browser_downloads", "Последние загрузки браузера (файл, статус, размер).", {
  limit: z.number().int().optional(),
}, "downloads.list");

tool("browser_cdp", "Сырой вызов Chrome DevTools Protocol (например 'Emulation.setDeviceMetricsOverride').", {
  tabId, method: z.string(), params: z.record(z.any()).optional(),
}, "cdp.send");

function mimeOf(f) {
  const ext = path.extname(f).slice(1).toLowerCase();
  return ({
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    pdf: "application/pdf", txt: "text/plain", csv: "text/csv", json: "application/json", html: "text/html",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    zip: "application/zip", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg",
  })[ext] || "application/octet-stream";
}

// ---------- старт ----------
await mcp.connect(new StdioServerTransport());
connect().then(() => log("connected to Chrome"), (e) => log(String(e.message).split("\n")[0]));
process.stdin.on("close", () => process.exit(0));
