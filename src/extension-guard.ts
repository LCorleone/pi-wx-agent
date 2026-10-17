/**
 * Containment for extension disposal races.
 *
 * `AgentSession.dispose()` invalidates the extension runner WITHOUT emitting
 * `session_shutdown` (the SDK exposes no public way to emit it), so an
 * extension holding a timer never runs its cleanup. pi's own control
 * extensions are affected: their alias-sync interval keeps firing after the
 * session is gone and throws "This extension ctx is stale ..." from a timer
 * callback — an uncaughtException that would kill the whole bridge.
 *
 * This guard recognizes exactly that stale-context pattern and contains it:
 * logged once per process, then swallowed. Everything else keeps default
 * Node semantics (our handler re-throws via process.exit(1) after logging)
 * so genuine bugs still crash loudly.
 */
const STALE_MARKER = "extension ctx is stale";

let staleLogged = false;

export function isStaleExtensionCtxError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(STALE_MARKER);
}

/** Install the containment handlers. Call once at process start. */
export function installExtensionDisposalGuard(): void {
  const contain = (origin: string, error: unknown) => {
    if (isStaleExtensionCtxError(error)) {
      if (!staleLogged) {
        staleLogged = true;
        console.error(`Contained ${origin}: an extension timer fired after its session was disposed (known SDK dispose gap; harmless). Further occurrences will be silent.`);
      }
      return;
    }
    console.error(`Uncaught ${origin}:`, error);
    process.exit(1);
  };
  process.on("uncaughtException", error => contain("uncaughtException", error));
  process.on("unhandledRejection", reason => contain("unhandledRejection", reason));
}
