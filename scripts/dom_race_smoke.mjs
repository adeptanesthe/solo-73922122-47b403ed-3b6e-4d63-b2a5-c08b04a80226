// Focused race / failure harness (jsdom + the running server).
//   node scripts/dom_race_smoke.mjs
// Verifies:
//   * preview failure keeps strokes and the retry button recovers;
//   * formal-plan failure keeps strokes and retry recovers;
//   * a stale /api/preview response from an old draft is dropped;
//   * a stale /api/plan response (e.g. cost 999) never reaches the screen;
//   * manual stroke reorder invalidates + re-prepares.
import { JSDOM, VirtualConsole } from "jsdom";

const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCtxProxy() {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === "measureText") return () => ({ width: 120 });
      if (typeof prop === "string") return () => {};
      return undefined;
    },
    set() { return true; },
  });
}

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push("jsdomError: " + (e.detail?.stack || e.message || e)));
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

const dom = await JSDOM.fromURL(BASE, {
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.AbortController = globalThis.AbortController;
    window.fetch = (u, opt) => fetch(new URL(String(u), BASE), opt);
    window.performance = globalThis.performance;
    window.confirm = () => true;
    window.HTMLCanvasElement.prototype.getContext = () => makeCtxProxy();
    window.HTMLCanvasElement.prototype.getBoundingClientRect = () =>
      ({ width: 680, height: 680, top: 0, left: 0, right: 680, bottom: 680,
         x: 0, y: 0, toJSON() {} });
    window.addEventListener("error", (e) => errors.push("window.error: " + e.message));
  },
});

const { window } = dom;
const document = window.document;
const $ = (id) => document.getElementById(id);

async function waitFor(fn, timeout = 8000, label = "condition") {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < timeout) {
    try { if (fn()) return; } catch (e) { lastErr = e; }
    await sleep(50);
  }
  throw new Error("timeout waiting for " + label + (lastErr ? ` (${lastErr.message})` : ""));
}

const rows = () => document.querySelectorAll("#strokeList .stroke-item").length;
const results = [];

try {
  await waitFor(() => document.querySelectorAll(".char-btn").length === 8, 8000, "chars");
  $("btnSample").click();
  await waitFor(() => $("sliderTrial").dataset.state === "ready", 8000, "trial ready");
  await waitFor(() => !$("planSummary").hidden && $("costTotal").textContent === "3", 8000, "cost 3");
  results.push("baseline sample ready: 4 rows, cost 3");

  // ---- preview failure + retry keeps strokes ----
  const bridgeFetch = window.fetch;
  let failPreview = true;
  window.fetch = (u, opt) => {
    if (String(u).includes("/api/preview") && failPreview) {
      failPreview = false;
      return Promise.reject(new window.Error("simulated preview network failure"));
    }
    return bridgeFetch(u, opt);
  };
  $("btnTrialRetry").click();
  await waitFor(() => $("sliderTrial").dataset.state === "error", 8000, "trial error state");
  if ($("trialError").hidden) throw new Error("trial error box should be visible");
  if (rows() !== 4) throw new Error("strokes must be preserved after preview failure");
  results.push("preview failure: error shown, all 4 strokes retained");

  $("btnTrialRetry").click();
  await waitFor(() => $("sliderTrial").dataset.state === "ready", 8000, "trial retry ready");
  results.push("preview retry recovered");

  // ---- formal plan failure + retry keeps strokes ----
  // Fail the fresh solve from the main button so no prior plan is current.
  const afterPreviewWrapper = window.fetch;
  let failPlan = true;
  window.fetch = (u, opt) => {
    if (String(u).includes("/api/plan") && failPlan) {
      failPlan = false;
      return Promise.reject(new window.Error("simulated plan network failure"));
    }
    return afterPreviewWrapper(u, opt);
  };
  $("btnPlan").click();
  await waitFor(() => !$("planError").hidden, 8000, "plan error notice");
  if (rows() !== 4) throw new Error("strokes must be preserved after plan failure");
  if (!$("btnAdopt").disabled) throw new Error("adopt disabled after plan failure");
  results.push("plan failure: retry notice shown, strokes retained, adopt disabled");

  $("btnPlanRetry").click();
  await waitFor(() => !$("planSummary").hidden && $("costTotal").textContent === "3",
    8000, "plan retry cost 3");
  if ($("planError").hidden !== true) throw new Error("plan error should clear after retry");
  results.push("plan retry recovered to cost 3");

  // ---- stale preview from an old draft must be dropped ----
  const beforeStale = window.fetch;
  let fakePreviewArmed = true;
  window.fetch = (u, opt) => {
    if (String(u).includes("/api/preview") && fakePreviewArmed) {
      fakePreviewArmed = false;
      // Bogus EMPTY levels: if this stale response were applied, the probe
      // would fall into data-state=missing.
      return new Promise((resolve) => setTimeout(() => resolve({
        ok: true,
        json: () => Promise.resolve({ feasible: true, levels: [], __fakeOldDraft: true }),
      }), 450));
    }
    return beforeStale(u, opt);
  };
  $("btnPlan").click();           // arms the slow fake preview
  $("btnUndo").click();           // new draft immediately supersedes it
  if ($("staleNotice").hidden)
    throw new Error("undo must withdraw old results immediately");
  await waitFor(() => rows() === 3, 4000, "undo removed a row");
  await waitFor(() => $("sliderTrial").dataset.state === "ready", 8000, "new draft trial ready");
  await sleep(750);               // let the 450ms fake old response settle
  if ($("sliderTrial").dataset.state !== "ready")
    throw new Error("stale empty preview overwrote the new draft probe: " +
      $("sliderTrial").dataset.state);
  if (window.__strokeApp.state.prep.__fakeOldDraft)
    throw new Error("old draft preview object became state.prep");
  results.push("stale /api/preview response from superseded draft was dropped");

  // ---- stale formal plan (cost 999) must never render ----
  const beforeStalePlan = window.fetch;
  let fakePlanArmed = true;
  window.fetch = (u, opt) => {
    if (String(u).includes("/api/plan") && fakePlanArmed) {
      fakePlanArmed = false;
      return new Promise((resolve) => setTimeout(() => resolve({
        ok: true,
        json: () => Promise.resolve({
          feasible: true, cost: 999,
          counts: { move: 999, delete: 0, add: 0 },
          steps: [], next_action: null, __fakeOldPlan: true,
        }),
      }), 450));
    }
    return beforeStalePlan(u, opt);
  };
  $("btnPlan").click();
  $("btnUndo").click();
  await waitFor(() => rows() === 2, 4000, "second undo rows=2");
  await waitFor(() => !$("planSummary").hidden, 8000, "real new plan rendered");
  await sleep(750);
  if ($("costTotal").textContent === "999")
    throw new Error("stale plan cost 999 rendered");
  if (window.__strokeApp.state.plan && window.__strokeApp.state.plan.cost === 999)
    throw new Error("stale plan object became state.plan");
  results.push("stale /api/plan cost=999 was dropped (screen keeps real plan)");

  // ---- manual reorder invalidates synchronously and re-prepares ----
  // Reload a clean sample for a deterministic reorder check.
  const fresh = await JSDOM.fromURL(BASE, {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(String(u), BASE), o);
      w.performance = globalThis.performance;
      w.confirm = () => true;
      w.HTMLCanvasElement.prototype.getContext = () => makeCtxProxy();
      w.HTMLCanvasElement.prototype.getBoundingClientRect = () =>
        ({ width: 680, height: 680, top: 0, left: 0, right: 680, bottom: 680,
           x: 0, y: 0, toJSON() {} });
    },
  });
  const d2 = fresh.window.document;
  const $2 = (id) => d2.getElementById(id);
  await waitFor(() => d2.querySelectorAll(".char-btn").length === 8, 8000, "chars2");
  $2("btnSample").click();
  await waitFor(() => $2("sliderTrial").dataset.state === "ready", 8000, "ready2");
  const app2 = fresh.window.__strokeApp;
  const uid0 = app2.state.strokes[0].uid;
  const down = d2.querySelector('.link-order[aria-label="把第 1 笔下移一位"]');
  if (!down) throw new Error("missing move-down control for row 1");
  down.dispatchEvent(new fresh.window.MouseEvent("click", { bubbles: true }));
  if (app2.state.strokes[1].uid !== uid0)
    throw new Error("row 1 did not move down");
  if ($2("staleNotice").hidden)
    throw new Error("reorder must show stale notice synchronously");
  results.push("manual 下移 changed stroke order and withdrew old results immediately");
  await waitFor(() => !$2("planSummary").hidden && $2("staleNotice").hidden,
    8000, "reorder reprepared");
  await waitFor(() => $2("sliderTrial").dataset.consistent === "true",
    8000, "reorder consistency");
  results.push("reordered draft re-prepared; formal plan consistent with trial");
  fresh.window.close();

  if (errors.length) {
    console.log(results.join("\n"));
    console.error("\nJS ERRORS:\n" + errors.slice(0, 10).join("\n"));
    process.exit(2);
  }
  console.log(results.join("\n"));
  console.log("\nRACE/FAILURE DOM HARNESS: PASS (no page errors)");
  process.exit(0);
} catch (e) {
  console.log(results.join("\n"));
  console.error("HARNESS FAIL:", e.stack || e);
  if (errors.length) console.error("PAGE ERRORS:\n" + errors.slice(0, 10).join("\n"));
  process.exit(1);
}
