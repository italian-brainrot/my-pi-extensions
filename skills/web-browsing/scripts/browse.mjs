#!/usr/bin/env node
// Multi-step browsing: one page, several actions, one Obscura session.
//
//   browse.mjs start [--port 9233] [--stealth] [--proxy URL] [--allow-private-network]
//   browse.mjs stop | status | doctor
//   browse.mjs [--port N] [--stdout] [--timeout S] '<command>' '<command>' ...
//
// Commands, run in order against the same page:
//   goto URL | wait SELECTOR | click SELECTOR | fill SELECTOR TEXT | press KEY
//   eval JS | markdown | text | html | links | scroll [PIXELS] | shot [PATH] | cookies
//
// Obscura keeps the page only while the CDP connection is open, so a run is the
// session boundary: put every step of a flow in one call. Page dumps go to
// $WEB_CACHE_DIR with a bounded preview; --stdout prints them instead.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CACHE = process.env.WEB_CACHE_DIR ?? join(process.env.TMPDIR ?? "/tmp", "web-browsing");
const PREVIEW = Number(process.env.WEB_PREVIEW_CHARS ?? 2500);

function die(message) {
  console.error(`browse.mjs: ${message}`);
  process.exit(1);
}

// The header comment of this file is its usage text.
function usage() {
  const lines = readFileSync(new URL(import.meta.url), "utf8").split("\n");
  const block = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("//")) block.push(line.slice(2).replace(/^ /, ""));
    else if (line.trim()) break;
    else block.push("");
  }
  console.log(block.join("\n").trimEnd());
}

function findObscura() {
  const envBin = process.env.OBSCURA_BIN;
  if (envBin) {
    if (!existsSync(envBin)) die(`OBSCURA_BIN=${envBin} does not exist`);
    return envBin;
  }
  const home = process.env.HOME ?? "";
  const candidates = [join(home, "Apps/obscura/obscura"), join(home, ".local/bin/obscura"), "/usr/local/bin/obscura", "/usr/bin/obscura"];
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir) candidates.unshift(join(dir, "obscura"));
  }
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? die("obscura not found; set OBSCURA_BIN");
}

const argv = process.argv.slice(2);
const sub = argv[0] && ["start", "stop", "status", "doctor"].includes(argv[0]) ? argv.shift() : "run";

const options = { port: 9233, stealth: false, proxy: "", private: false, stdout: false, timeout: 30 };
const commands = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--port") options.port = Number(argv[++i]);
  else if (arg === "--stealth") options.stealth = true;
  else if (arg === "--proxy") options.proxy = argv[++i] ?? "";
  else if (arg === "--allow-private-network") options.private = true;
  else if (arg === "--stdout") options.stdout = true;
  else if (arg === "--timeout") options.timeout = Number(argv[++i]);
  else if (arg === "-f" || arg === "--file") {
    commands.push(
      ...readFileSync(argv[++i], "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    );
  } else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else if (arg.startsWith("-") && commands.length === 0) die(`unknown flag: ${arg}`);
  else commands.push(arg);
}

const stateDir = join(CACHE, "cdp", String(options.port));
const pidFile = join(stateDir, "pid");
const logFile = join(stateDir, "server.log");
mkdirSync(stateDir, { recursive: true });
const http = `http://127.0.0.1:${options.port}`;

async function serverInfo(timeoutMs = 1500) {
  try {
    const response = await fetch(`${http}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return await response.json();
  } catch {
    return null;
  }
}

async function startServer() {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      process.kill(pid, 0);
      if (await serverInfo()) return true;
    } catch {
      /* stale pid file */
    }
  }
  const args = ["serve", "--port", String(options.port), "--quiet"];
  if (options.stealth) args.push("--stealth");
  if (options.proxy) args.push("--proxy", options.proxy);
  if (options.private) args.push("--allow-private-network");
  const child = spawn(findObscura(), args, {
    detached: true,
    stdio: ["ignore", openSync(logFile, "a"), openSync(logFile, "a")],
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  for (let waited = 0; waited < 20_000; waited += 250) {
    if (await serverInfo()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  die(`obscura serve did not come up on ${http}; see ${logFile}`);
}

function stopServer() {
  if (!existsSync(pidFile)) die(`no server recorded for port ${options.port}`);
  const pid = Number(readFileSync(pidFile, "utf8"));
  try {
    process.kill(pid);
    console.log(`stopped obscura serve (pid ${pid})`);
  } catch (error) {
    console.log(`could not signal pid ${pid}: ${error.message}`);
  }
  try {
    unlinkSync(pidFile);
  } catch {
    /* already gone */
  }
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = message.id && pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(`${message.error.message} (code ${message.error.code})`)) : waiter.resolve(message.result);
  });
  return {
    open: new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", () => reject(new Error(`could not connect to ${url}`)));
    }),
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`${method} timed out`));
        }, 60_000);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

async function main() {
  if (sub === "doctor") {
    const running = await serverInfo(600);
    console.log(`obscura: ${findObscura()}`);
    console.log(`port: ${options.port} ${running ? `(running, ${running.Browser ?? "?"})` : "(not running)"}`);
    console.log(`cache: ${CACHE}`);
    return;
  }

  if (sub === "stop") return stopServer();

  if (sub === "start") {
    await startServer();
    console.log(`obscura serve on ${http}`);
    return;
  }

  if (sub === "run" && commands.length === 0) {
    usage();
    process.exitCode = 2;
    return;
  }

  let info = await serverInfo();
  if (!info && sub !== "status") {
    await startServer();
    info = await serverInfo();
  }
  if (!info) {
    if (sub === "status") {
      console.log(`not running: ${http}`);
      process.exitCode = 1;
      return;
    }
    die(`no CDP server on ${http}; run: browse.mjs start`);
  }
  if (sub === "status") {
    console.log(`running: ${http} (${info.Browser ?? "?"})`);
    return;
  }

  const client = connect(info.webSocketDebuggerUrl);
  await client.open;
  const call = (method, params = {}, sessionId) => client.send(method, params, sessionId);

  const { targetId } = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) die(`JS failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result?.value;
  };
  const settle = async () => {
    const deadline = Date.now() + options.timeout * 1000;
    while (Date.now() < deadline) {
      if ((await evaluate("document.readyState")) === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  };
  const save = async (text, extension) => {
    if (options.stdout) return void console.log(text);
    const url = (await evaluate("document.location.href")) ?? "page";
    const slug = url
      .replace(/^[a-z]+:\/\//, "")
      .replace(/[^\w.-]+/g, "-")
      .slice(0, 70);
    const path = join(CACHE, `page-${slug}-${Date.now()}.${extension}`);
    writeFileSync(path, text);
    console.log(`saved ${text.length} chars -> ${path}`);
    if (text.length > PREVIEW) console.log(`${text.slice(0, PREVIEW)}\n[... truncated; read or grep ${path} for the rest]`);
    else console.log(text);
  };

  try {
    await call("Page.enable", {}, sessionId);
    await call("Network.enable", {}, sessionId);
    for (const line of commands) {
      const command = line.trim().split(/\s+/)[0];
      const rest = line.trim().slice(command.length).trim();
      const args = rest.split(/\s+/);
      switch (command) {
        case "goto":
          if (!args[0]) die("goto needs a URL");
          await call("Page.navigate", { url: args[0] }, sessionId);
          await settle();
          break;
        case "wait": {
          const deadline = Date.now() + options.timeout * 1000;
          while (Date.now() < deadline) {
            if (await evaluate(`document.querySelector(${JSON.stringify(rest)}) !== null`)) break;
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          if (!(await evaluate(`document.querySelector(${JSON.stringify(rest)}) !== null`))) die(`timed out waiting for: ${rest}`);
          break;
        }
        case "click": {
          const handle = await call("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(rest)})` }, sessionId);
          if (!handle.result?.objectId) die(`no element for: ${rest}`);
          try {
            const { model } = await call("DOM.getBoxModel", { objectId: handle.result.objectId }, sessionId);
            const x = (model.content[0] + model.content[2] + model.content[4] + model.content[6]) / 4;
            const y = (model.content[1] + model.content[3] + model.content[5] + model.content[7]) / 4;
            for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
              await call(
                "Input.dispatchMouseEvent",
                { type, x, y, button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1 },
                sessionId,
              );
            }
          } catch {
            await evaluate(`document.querySelector(${JSON.stringify(rest)}).click()`);
          }
          await settle();
          break;
        }
        case "fill": {
          const selector = args[0];
          const value = rest.slice(selector.length).trim();
          await evaluate(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("no element: ${selector}"); ` +
              `const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; ` +
              `Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); ` +
              `el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
          );
          break;
        }
        case "press": {
          const key = args[0] ?? "Enter";
          for (const type of ["keyDown", "keyUp"]) {
            await call(
              "Input.dispatchKeyEvent",
              { type, key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: key.charCodeAt(0) },
              sessionId,
            );
          }
          await settle();
          break;
        }
        case "eval":
          console.log(JSON.stringify(await evaluate(rest)) ?? "undefined");
          break;
        case "markdown":
          await save((await call("LP.getMarkdown", {}, sessionId)).markdown ?? "", "md");
          break;
        case "text":
          await save(String(await evaluate("document.body?.innerText ?? ''")), "txt");
          break;
        case "html":
          await save(String(await evaluate("document.documentElement.outerHTML")), "html");
          break;
        case "links":
          await save(
            String(
              await evaluate(
                `JSON.stringify([...document.querySelectorAll('a[href]')].map(a=>[a.textContent.trim().replace(/\\s+/g,' '), a.href]),null,1)`,
              ),
            ),
            "json",
          );
          break;
        case "scroll":
          console.log(String(await evaluate(`window.scrollBy(0, ${args[0] ?? 800}), document.scrollingElement?.scrollTop ?? 0`)));
          break;
        case "shot": {
          const { data } = await call("Page.captureScreenshot", { format: "png" }, sessionId);
          const path = args[0] || join(CACHE, `shot-${Date.now()}.png`);
          writeFileSync(path, Buffer.from(data, "base64"));
          console.log(`screenshot -> ${path}`);
          break;
        }
        case "cookies":
          console.log(JSON.stringify((await call("Network.getCookies", {}, sessionId)).cookies, null, 1));
          break;
        default:
          die(`unknown command: ${command}`);
      }
    }
    console.log(`page: ${await evaluate("document.location.href")} — ${await evaluate("document.title")}`);
  } finally {
    try {
      await call("Target.closeTarget", { targetId });
    } catch {
      /* the server closes it with the connection anyway */
    }
    client.close();
  }
}

main().catch((error) => die(error.message));
