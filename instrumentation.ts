/**
 * Next.js runs this once when the server boots. It is the only hook that fires
 * before any request, which is what the background scheduler needs — the
 * watcher must run whether or not anyone is visiting the site.
 */
export async function register() {
  // Skip the edge runtime and the build-time collection pass.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startScheduler } = await import("./lib/scheduler");
  // Deliberately not awaited: when another instance still holds the scheduler
  // lease this waits for it to free up, and boot must not block on that.
  void startScheduler();
}
