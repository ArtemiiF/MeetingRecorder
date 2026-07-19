// Boot-smoke test against the PACKAGED Electron build (--dir output), not the
// dev checkout. v1.4.5 shipped with a main-process crash at require-time
// (events.json missing from the asar — electron-builder silently drops a
// root file that is ALSO listed in extraResources, see lib/events.js) while
// all 903 unit/integration tests stayed green: nothing in tests/ ever
// launches the real .app. This is the 6th asar-class bug in the project;
// every one was caught only at runtime. This test drives the actual packaged
// binary so the whole class (missing/misrouted packaged resource → crash
// before a window ever appears) fails loudly here instead of in a user's
// hands.
//
// Prereq (not run automatically — see the failure message below):
//   npx electron-builder --mac --arm64 --dir
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron } = require("playwright-core");

const APP_ROOT = path.join(__dirname, "..");
const APP_BUNDLE = path.join(APP_ROOT, "dist", "mac-arm64", "Meeting Recorder.app");
const APP_BINARY = path.join(APP_BUNDLE, "Contents", "MacOS", "Meeting Recorder");

// Generous — CI runners (and a cold local disk cache) are slower than a dev
// machine to get the first window on screen; boot-smoke cares about "does it
// come up at all", not startup latency.
// Холодный CI-раннер может грузиться дольше дев-машины — таймаут переопределяем env'ом.
const LAUNCH_TIMEOUT_MS = Number(process.env.E2E_LAUNCH_TIMEOUT_MS) || 30_000;

test("boot-smoke: packaged app launches, shows a window, survives packaging (preload + renderer alive)", async (t) => {
  if (!fs.existsSync(APP_BINARY)) {
    assert.fail(
      `Packaged app not found at ${APP_BINARY}.\n` +
        "Build it first: npx electron-builder --mac --arm64 --dir"
    );
  }

  // Isolated userData: the packaged app resolves presets.json/index.db/recordings
  // and the backend-env install under app.getPath("userData") (main.js). Without
  // an override this run would read/write the developer's REAL Meeting Recorder
  // userData directory — destructive on a dev machine, and non-hermetic on CI.
  // main.js honors MEETING_RECORDER_USER_DATA (env-gated app.setPath override,
  // no-op unless set) for exactly this reason.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-e2e-userdata-"));

  let electronApp;
  // Captured once, right after launch, while the playwright<->app connection
  // is alive. This is a plain Node ChildProcess handle — .exitCode/.kill()
  // stay valid after electronApp.close() tears down that connection, unlike
  // calling electronApp.process() again post-close (throws internally).
  let proc;
  const stderrChunks = [];
  try {
    electronApp = await _electron.launch({
      executablePath: APP_BINARY,
      args: [],
      cwd: APP_ROOT,
      env: {
        ...process.env,
        MEETING_RECORDER_USER_DATA: userDataDir,
      },
      timeout: LAUNCH_TIMEOUT_MS,
    });
    proc = electronApp.process();
    proc.stderr?.on("data", (chunk) => stderrChunks.push(chunk));

    // a) first window appears within a generous timeout. If the main process
    // crashed at require-time (the v1.4.5 failure mode: error dialog, no
    // window), firstWindow() never resolves and this rejects on timeout —
    // that IS the assertion for the whole "crash before a window exists"
    // bug class, no separate dialog-detection needed.
    const window = await electronApp.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
    assert.ok(window, "packaged app did not produce a window within the timeout");

    // b) no main-process crash: the child process is still alive after the
    // window appeared (a crash immediately after first paint would otherwise
    // slip past assertion (a)).
    assert.equal(proc.exitCode, null, "main process exited instead of staying up after showing a window");

    await window.waitForLoadState("domcontentloaded");

    // c) renderer alive: the sidebar nav is part of the base app shell (always
    // in the DOM — index.html renders it unconditionally), unlike #setupGate
    // (a full-cover overlay that is visible on a fresh install and hidden once
    // the backend + models are ready). Asserting on the nav means this holds
    // whether or not the isolated userData dir happens to have a backend
    // installed.
    const navCount = await window.locator(".sidebar-nav .topbtn").count();
    assert.ok(navCount >= 1, "sidebar nav (.sidebar-nav .topbtn) not found — renderer did not render the base app shell");

    // d) main-process modules loaded end-to-end: window.api only exists if
    // preload.js's contextBridge.exposeInMainWorld ran, which only happens if
    // the packaged preload.js resolved and loaded without error — proves the
    // preload + contextBridge wiring (and everything main.js requires at
    // top-level to get that far) survived packaging.
    const hasApiBridge = await window.evaluate(
      () => typeof window.api === "object" && typeof window.api.preflight === "function"
    );
    assert.ok(hasApiBridge, "window.api (preload contextBridge) missing — preload wiring did not survive packaging");
  } finally {
    if (electronApp) {
      await electronApp.close().catch(() => {});
      // Belt-and-suspenders: close() should already terminate the child, but
      // if the main process wedged (e.g. mid-crash) make sure nothing is left
      // running past this test.
      if (proc && proc.exitCode === null) {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      }
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
    if (stderrChunks.length) {
      t.diagnostic(`main-process stderr:\n${Buffer.concat(stderrChunks).toString("utf-8")}`);
    }
  }
});
