import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { PiAgent } from "./pi-agent.js";
import { installExtensionDisposalGuard } from "./extension-guard.js";

// Before anything else: contain extension disposal races (see extension-guard.ts).
installExtensionDisposalGuard();

/**
 * pi's session factory installs its bundled undici as the global fetch implementation
 * (pi-coding-agent dist/core/http-dispatcher.js). That newer undici strictly follows the
 * fetch spec and rejects requests that set a manual "Content-Length" header, while
 * weixin-agent-sdk sets that header on every request (its api.ts buildHeaders). The result
 * is "InvalidArgumentError: invalid content-length header" on every long-poll once a Pi
 * session factory exists. Strip the forbidden header here; undici computes the correct
 * value itself. Must be installed AFTER the Pi session factory (pi installs its globals
 * there) and BEFORE the WeChat SDK starts polling.
 */
function installFetchCompatShim(): void {
  const current = globalThis.fetch;
  if ((current as { __wxCompat?: boolean }).__wxCompat) return;
  const wrapped: typeof fetch = async (input, init) => {
    if (init?.body != null && init.headers != null) {
      const headers = new Headers(init.headers);
      if (headers.has("content-length")) {
        headers.delete("content-length");
        init = { ...init, headers };
      }
    }
    return current(input, init);
  };
  (wrapped as { __wxCompat?: boolean }).__wxCompat = true;
  globalThis.fetch = wrapped;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node dist/main.js [start|login|claim] [--config path]\nlogin: explicitly replace WeChat login (owner unchanged)\nclaim: rotate an unclaimed owner's 10-minute / 5-attempt code; run only while stopped");
    return;
  }
  const configIndex = args.indexOf("--config");
  const file = configIndex >= 0 ? args[configIndex + 1] : "config.json";
  if (!file) throw new Error("--config requires a path");
  if (configIndex >= 0) args.splice(configIndex, 2);
  const command = args[0] ?? "start";
  if (args.length > 1 || !["start", "login", "claim"].includes(command)) throw new Error("Unknown arguments; use --help");
  process.umask(0o077);
  const config = loadConfig(file);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  // Dynamic import is deliberate: SDK module initialization must see our state root.
  process.env.OPENCLAW_STATE_DIR = config.dataDir;

  if (command === "claim") {
    const agent = new PiAgent(config, async () => { throw new Error("Claim cannot create Pi sessions"); });
    console.log(`OWNER_CODE=${agent.issueClaim()}\nValid for 10 minutes, at most 5 unauthorized messages. Send exactly this code to the bot. Keep it private.`);
    return;
  }

  let agent: PiAgent | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let shutdown: Promise<void> | undefined;
  let forceExit: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const stop = () => {
    if (shutdown) return;
    controller.abort();
    if (timer) clearInterval(timer);
    // login() has no abort API; bounded exit also covers stuck tools/network shutdown.
    forceExit = setTimeout(() => process.exit(0), 10_000);
    forceExit.unref();
    shutdown = agent?.close() ?? Promise.resolve();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    if (command === "start") {
      const { createSessionFactory } = await import("./pi-session.js");
      agent = new PiAgent(config, await createSessionFactory(config));
      installFetchCompatShim();
    }
    const weixin = await import("weixin-agent-sdk");
    if (controller.signal.aborted) return;
    if (command === "login") {
      weixin.logout();
      await weixin.login();
      console.log("Login saved. Start the bridge next; existing ownership is unchanged.");
      return;
    }
    if (!weixin.isLoggedIn()) {
      if (!process.stdin.isTTY) throw new Error("No WeChat login. Run the login command interactively before starting a service.");
      await weixin.login();
    }
    if (controller.signal.aborted || !agent) return;
    if (agent.needsClaim) {
      if (!agent.hasClaim) console.log(`OWNER_CODE=${agent.issueClaim()}\nSend exactly this code to the bot within 10 minutes (5 attempts total). Keep terminal/logs private.`);
      else console.log("Owner not claimed. Existing claim window is not renewed; if needed stop and run the claim command.");
    }
    const bridge = agent;
    const bot = weixin.start(bridge, { abortSignal: controller.signal });
    // Optional cross-session relay (pushExternalReplies): forward owner-session replies to
    // turns the bridge did not initiate to the owner's WeChat. Bot.sendMessage needs a
    // context_token cached from a prior inbound message (~24h validity), so pushes before
    // the first inbound message simply fail and are logged inside PiAgent. Push targets
    // only the owner: the single WeChat account this Bot instance serves. Wiring after
    // start() keeps the SDK dynamically imported and avoids import cycles.
    if (config.pushExternalReplies) bridge.pushChannel = text => bot.sendMessage(text);
    const dream = () => { void bridge.dream().catch(() => console.error("Dream scheduling failed.")); };
    timer = setInterval(dream, 60_000);
    dream();
    await bot.wait();
  } finally {
    if (timer) clearInterval(timer);
    await shutdown;
    // Startup may have completed creating the agent after a signal arrived.
    await agent?.close();
    if (forceExit) clearTimeout(forceExit);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exitCode = 1;
});
