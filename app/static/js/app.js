/* 笔顺订正工作台 frontend (vanilla JS, canvas 2D). */
"use strict";

const GRID = 1000;
const MAX_STROKES = 10;
const MAX_POINTS = 64;
const PLAY_MS = 1700;

const PALETTE = [
  "#d1495b", "#2e86ab", "#1f8a4c", "#e08e0b", "#7e22ce",
  "#0f9d8f", "#c2410c", "#3b5bdb", "#a61e4d", "#5c940d",
];

const state = {
  chars: [],
  charId: null,
  model: [],
  strokes: [], // {uid, points:[[x,y]], preserved, color}
  uidCursor: 1,
  colorCursor: 0,
  threshold: 180,
  plan: null,
  planStale: false,
  live: false, // first solve happened; later edits auto-prepare the new draft
  seq: 0, // draft generation token: responses of older drafts never render
  prep: null, // {status:'loading'|'ready'|'error', levels:Map, solveCount}
  prepReqId: 0,
  planLoading: false,
  planError: "",
  planThreshold: null, // threshold the current/last formal plan was solved at
  planReqId: 0,
  planAbort: null,
  sliderActive: false, // between first slider input and commit (change)
  pb: 0,
  playing: false,
  lastTick: 0,
  draft: null, // in-progress raw points
  drawing: false,
  highlightUid: null,
};

const $ = (id) => document.getElementById(id);
const canvas = $("board");
const ctx = canvas.getContext("2d");

/* ----------------------------- utilities ----------------------------- */

function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2200);
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function arcResample(points, count) {
  if (points.length === 1) return Array.from({ length: count }, () => [...points[0]]);
  const total = points.reduce((s, p, i) => (i ? s + dist(points[i - 1], p) : 0), 0);
  if (total <= 1e-9) return Array.from({ length: count }, () => [...points[0]]);
  const interval = total / (count - 1);
  const out = [[...points[0]]];
  let accum = 0, idx = 0, cur = points[0];
  while (out.length < count - 1 && idx < points.length - 1) {
    const nxt = points[idx + 1];
    const seg = dist(cur, nxt);
    if (seg <= 1e-12) { idx += 1; cur = nxt; continue; }
    if (accum + seg >= interval) {
      const t = (interval - accum) / seg;
      const np = [cur[0] + (nxt[0] - cur[0]) * t, cur[1] + (nxt[1] - cur[1]) * t];
      out.push(np); cur = np; accum = 0;
    } else { accum += seg; cur = nxt; idx += 1; }
  }
  while (out.length < count) out.push([...points[points.length - 1]]);
  out[count - 1] = [...points[points.length - 1]];
  return out.slice(0, count);
}

function finalizePoints(raw) {
  // Thin close samples, then ALWAYS arc-length normalise to a dense fixed
  // count (<=64).  Dense, evenly spaced points make the server's exact
  // discrete Frechet robust even for a sparse down/move/up gesture that only
  // produced two raw endpoints.
  const thin = [];
  for (const p of raw) {
    if (!thin.length || dist(thin[thin.length - 1], p) >= 5) thin.push(p);
  }
  const lastRaw = raw[raw.length - 1];
  if (thin.length && dist(thin[thin.length - 1], lastRaw) > 0.5) thin.push(lastRaw);
  if (thin.length === 0) return [];
  if (thin.length === 1) return [thin[0], [thin[0][0] + 0.01, thin[0][1]]];
  return arcResample(thin, 48);
}

// Must match backend apply_move: pop frm then insert at resulting index to.
function applyMove(arr, frm, to) {
  const [item] = arr.splice(frm, 1);
  arr.splice(to, 0, item);
  return arr;
}

function centroid(points) {
  let x = 0, y = 0;
  for (const p of points) { x += p[0]; y += p[1]; }
  return [x / points.length, y / points.length];
}

// Nudge order badges apart when several strokes start at the same corner
// (e.g. the vertical and the heng-zhe of 口 share their first point).
function resolveBadgePositions(strokes) {
  const MIN_D = 66;
  const pos = strokes.map((s) => {
    let [x, y] = s.points[0];
    return [Math.max(46, Math.min(GRID - 46, x)), Math.max(46, Math.min(GRID - 46, y))];
  });
  for (let iter = 0; iter < 60; iter++) {
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        let dx = pos[j][0] - pos[i][0];
        let dy = pos[j][1] - pos[i][1];
        let d = Math.hypot(dx, dy);
        if (d >= MIN_D) continue;
        if (d < 0.01) {
          const ang = i * 2.399 + j * 1.31;
          dx = Math.cos(ang); dy = Math.sin(ang); d = 1;
        }
        const push = (MIN_D - d) / 2;
        const nx = dx / d, ny = dy / d;
        pos[i][0] -= nx * push; pos[i][1] -= ny * push;
        pos[j][0] += nx * push; pos[j][1] += ny * push;
      }
    }
    for (const p of pos) {
      p[0] = Math.max(46, Math.min(GRID - 46, p[0]));
      p[1] = Math.max(46, Math.min(GRID - 46, p[1]));
    }
  }
  return pos;
}

/* ----------------------------- API ----------------------------- */

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function payloadStrokes() {
  return state.strokes.map((s) => ({
    uid: s.uid, points: s.points, preserved: !!s.preserved,
  }));
}

// All slider stops, read from the real <input> configuration so the prepared
// levels can never drift from what the teacher can drag to.
function sliderLevels() {
  const el = $("threshold");
  const min = Number(el.min), max = Number(el.max);
  const step = Number(el.step) || 10;
  const out = [];
  for (let v = min; v <= max + 1e-9; v += step) {
    out.push(Math.round(v * 100) / 100);
  }
  return out;
}

function cancelFormalPlan() {
  // Supersede any in-flight formal solution; its response must not render.
  state.planReqId += 1;
  if (state.planAbort) {
    try { state.planAbort.abort(); } catch (_) { /* noop */ }
    state.planAbort = null;
  }
  state.planLoading = false;
}

function makeAbortController() {
  try {
    if (typeof AbortController !== "function") return null;
    return new AbortController();
  } catch (_) {
    return null;
  }
}

// Immediately take down trials + formal plan of the current draft and advance
// the draft token so every older response is dropped on arrival.
function discardResults() {
  const hadResults = !!(state.plan || state.prep);
  state.seq += 1;
  state.prepReqId += 1;
  cancelFormalPlan();
  state.prep = null;
  state.plan = null;
  state.planError = "";
  state.planThreshold = null;
  state.pb = 0;
  state.playing = false;
  // Only show the "old suggestion withdrawn" notice when something was shown.
  state.planStale = state.live && hadResults;
}

// Fetch the all-stops trial sweep once for the current draft.
function requestPreview() {
  const seq = state.seq;
  const prepReqId = ++state.prepReqId;
  state.prep = { status: "loading", levels: new Map(), solveCount: 0 };
  renderTrialProbe();
  updatePlanButtons();

  return (async () => {
    let data;
    try {
      const res = await fetch("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          character_id: state.charId,
          thresholds: sliderLevels(),
          strokes: payloadStrokes(),
        }),
      });
      data = await res.json();
    } catch (e) {
      // A newer draft / reset superseded this preparation: stay silent.
      if (prepReqId !== state.prepReqId || seq !== state.seq) return false;
      state.prep = { status: "error", levels: new Map(), error: e.message };
      renderTrialProbe();
      updatePlanButtons();
      toast("试算准备失败：" + e.message + "（笔迹已保留，可点“重试准备”）");
      return false;
    }
    // Old draft's response never reaches the screen.
    if (prepReqId !== state.prepReqId || seq !== state.seq) return false;
    if (!data || data.feasible === false || !Array.isArray(data.levels)) {
      state.prep = {
        status: "error",
        levels: new Map(),
        error: (data && data.reason) || "试算响应格式不正确",
      };
      renderTrialProbe();
      updatePlanButtons();
      toast("试算准备失败：" + state.prep.error + "（笔迹已保留，可重试）");
      return false;
    }
    const levels = new Map();
    for (const lv of data.levels) levels.set(Number(lv.threshold), lv);
    state.prep = {
      status: "ready",
      levels,
      solveCount: data.solve_count,
      pairCount: data.pair_count,
    };
    renderTrialProbe();
    return true;
  })();
}

// Prepare every slider stop and, unless ``plan === false``, generate the
// formal plan for the currently selected threshold in parallel.
function prepareDraft({ plan = true } = {}) {
  const prepPromise = requestPreview();
  const planPromise = plan ? requestPlan() : Promise.resolve(false);
  return { prepPromise, planPromise };
}

async function requestPlan() {
  const seq = state.seq;
  const reqId = ++state.planReqId;
  if (state.planAbort) {
    try { state.planAbort.abort(); } catch (_) { /* noop */ }
  }
  const ac = makeAbortController();
  state.planAbort = ac;
  state.planLoading = true;
  state.planError = "";
  renderPlanPanel();
  updatePlanButtons();

  let data;
  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ac ? ac.signal : undefined,
      body: JSON.stringify({
        character_id: state.charId,
        threshold: Number(state.threshold),
        strokes: payloadStrokes(),
      }),
    });
    data = await res.json();
  } catch (e) {
    // Superseded by a newer request / slider re-drag / draft edit: drop silently.
    if (e && e.name === "AbortError") return false;
    if (reqId !== state.planReqId || seq !== state.seq) return false;
    state.planLoading = false;
    state.planError = "求解请求失败：" + e.message;
    renderPlanPanel();
    updatePlanButtons();
    toast("求解失败：" + e.message + "（笔迹已保留，可点重试）");
    return false;
  }
  if (reqId !== state.planReqId || seq !== state.seq) return false;

  state.planLoading = false;
  state.live = true;
  state.plan = data;
  state.planStale = false;
  state.planThreshold = Number(state.threshold);
  state.pb = 0;
  state.playing = false;
  renderPlanPanel();
  renderStepList();
  updatePlanButtons();
  renderTrialProbe();
  return true;
}

// Explicit first solve (button).  Arms live mode and prepares all stops plus
// the formal plan for the current stop.
function startSolving() {
  if (!state.model.length) return;
  state.live = true;
  discardResults();
  renderStrokeList();
  renderPlanPanel();
  renderStepList();
  prepareDraft();
}

/* ------------------------- character picker ------------------------- */

async function initCharacters() {
  const idx = await fetchJSON("/api/characters");
  state.chars = idx.characters;
  const picker = $("charPicker");
  picker.innerHTML = "";
  for (const c of state.chars) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "char-btn";
    b.dataset.id = c.id;
    b.title = `${c.char} · ${c.stroke_count} 笔 · ${c.meaning || ""}`;
    b.textContent = c.char;
    b.addEventListener("click", () => selectCharacter(c.id, true));
    picker.appendChild(b);
  }
  await selectCharacter(state.chars.find((c) => c.id === "mu") ? "mu" : state.chars[0].id, false);
}

async function selectCharacter(id, confirmChange) {
  if (confirmChange && state.strokes.length &&
      !window.confirm("切换范字会清空当前笔迹与建议，确定吗？")) {
    return;
  }
  // Tear down the old draft immediately (old responses are token-dropped).
  const wasLive = state.live;
  state.charId = id;
  state.model = [];
  state.strokes = [];
  $("adoptLog").innerHTML = "";
  discardResults();
  document.querySelectorAll(".char-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.id === id));
  renderStrokeList();
  renderTrialProbe();
  renderPlanPanel();
  renderStepList();
  updatePlanButtons();

  let data;
  try {
    data = await fetchJSON(`/api/characters/${id}`);
  } catch (e) {
    toast("范字加载失败：" + e.message);
    return;
  }
  // A newer character selection superseded this response.
  if (state.charId !== id) return;
  state.model = data.strokes;
  updatePlanButtons();
  // The spec lists switching model characters among the edits that immediately
  // re-prepare once the workbench is live.
  if (wasLive) prepareDraft();
}

/* --------------------------- canvas sizing --------------------------- */

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const px = Math.max(1, Math.round(rect.width * dpr));
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
}
window.addEventListener("resize", resizeCanvas);

function toGrid(e) {
  const r = canvas.getBoundingClientRect();
  return [
    ((e.clientX - r.left) / r.width) * GRID,
    ((e.clientY - r.top) / r.height) * GRID,
  ];
}

/* ----------------------------- drawing ----------------------------- */

function strokePath(c, pts) {
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
}

function drawGrid(c) {
  c.save();
  c.fillStyle = "#fffdf8";
  c.fillRect(0, 0, GRID, GRID);

  // faint regular grid thirds
  c.strokeStyle = "#efe7d6";
  c.lineWidth = 1.4;
  for (let i = 1; i < 3; i++) {
    const p = (GRID / 3) * i;
    c.beginPath(); c.moveTo(p, 0); c.lineTo(p, GRID); c.stroke();
    c.beginPath(); c.moveTo(0, p); c.lineTo(GRID, p); c.stroke();
  }
  // rice grid diagonals + center cross
  c.strokeStyle = "rgba(199,92,84,0.35)";
  c.lineWidth = 2;
  c.setLineDash([16, 14]);
  c.strokeRect(8, 8, GRID - 16, GRID - 16);
  c.beginPath();
  c.moveTo(8, 8); c.lineTo(GRID - 8, GRID - 8);
  c.moveTo(GRID - 8, 8); c.lineTo(8, GRID - 8);
  c.moveTo(GRID / 2, 8); c.lineTo(GRID / 2, GRID - 8);
  c.moveTo(8, GRID / 2); c.lineTo(GRID - 8, GRID / 2);
  c.stroke();
  c.setLineDash([]);
  c.restore();
}

function drawModelGuide(c) {
  if (!state.model.length) return;
  c.save();
  c.lineCap = "round";
  c.lineJoin = "round";
  for (const pts of state.model) {
    strokePath(c, pts);
    c.strokeStyle = "rgba(156,43,37,0.16)";
    c.lineWidth = 40;
    c.stroke();
    strokePath(c, pts);
    c.strokeStyle = "rgba(156,43,37,0.42)";
    c.lineWidth = 3;
    c.setLineDash([2, 10]);
    c.stroke();
    c.setLineDash([]);
  }
  c.restore();
}

function drawInk(c, pts, color, width = 18, alpha = 1) {
  c.save();
  c.globalAlpha = alpha;
  c.lineCap = "round";
  c.lineJoin = "round";
  strokePath(c, pts);
  c.strokeStyle = color;
  c.lineWidth = width;
  c.stroke();
  // subtle darker core
  strokePath(c, pts);
  c.strokeStyle = "rgba(0,0,0,0.12)";
  c.lineWidth = Math.max(2, width * 0.28);
  c.stroke();
  c.restore();
}

function drawOrderBadge(c, bx, by, index1, color, preserved) {
  c.save();
  c.beginPath(); c.arc(bx, by, 27, 0, Math.PI * 2);
  c.fillStyle = color; c.fill();
  c.lineWidth = preserved ? 7 : 4;
  c.strokeStyle = preserved ? "#1f8a4c" : "rgba(255,255,255,0.9)";
  c.stroke();
  c.fillStyle = "#fff";
  c.font = "bold 30px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  c.textAlign = "center"; c.textBaseline = "middle";
  c.fillText(String(index1), bx, by + 2);
  if (preserved) {
    c.font = "bold 20px sans-serif";
    const label = "保";
    const tw = c.measureText(label).width + 18;
    c.fillStyle = "#1f8a4c";
    roundRect(c, bx + 18, by - 44, tw, 30, 8); c.fill();
    c.fillStyle = "#fff";
    c.fillText(label, bx + 18 + tw / 2, by - 28);
  }
  c.restore();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawPill(c, x, y, text, bg) {
  c.save();
  c.font = "bold 26px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  const w = c.measureText(text).width + 30;
  const h = 44;
  let px = x - w / 2, py = y - h / 2;
  px = Math.max(10, Math.min(GRID - w - 10, px));
  py = Math.max(10, Math.min(GRID - h - 10, py));
  c.globalAlpha = 0.95;
  c.fillStyle = bg;
  roundRect(c, px, py, w, h, 12); c.fill();
  c.fillStyle = "#fff";
  c.textAlign = "center"; c.textBaseline = "middle";
  c.fillText(text, px + w / 2, py + h / 2 + 2);
  c.restore();
}

function playbackView() {
  const plan = state.plan;
  if (!plan || !plan.feasible || state.planStale) return null;
  const arr = state.strokes.map((s) => ({ ...s }));
  const addSteps = [];
  let last = null;
  for (let k = 0; k < state.pb && k < plan.steps.length; k++) {
    const step = plan.steps[k];
    last = step;
    if (step.kind === "delete") {
      let idx = arr.findIndex((s) => s.uid === step.uid);
      if (idx < 0) idx = Math.min(step.index, arr.length - 1);
      if (idx >= 0) arr.splice(idx, 1);
    } else if (step.kind === "move") {
      let from = step.from;
      if (arr[from] && step.uid != null && arr[from].uid !== step.uid) {
        from = arr.findIndex((s) => s.uid === step.uid);
      }
      if (from >= 0) applyMove(arr, from, step.to);
    } else if (step.kind === "add") {
      addSteps.push(step);
    }
  }
  return { arr, addSteps, last };
}

function drawDashedAdd(c, pts, alpha, animate, width = 12) {
  c.save();
  c.globalAlpha = alpha;
  c.lineCap = "round"; c.lineJoin = "round";
  strokePath(c, pts);
  c.strokeStyle = "#7e22ce";
  c.lineWidth = width;
  c.setLineDash([26, 18]);
  if (animate) c.lineDashOffset = -performance.now() / 35;
  c.stroke();
  c.restore();
}

function render() {
  resizeCanvas();
  const sx = canvas.width / GRID;
  ctx.setTransform(sx, 0, 0, sx, 0, 0);
  ctx.clearRect(0, 0, GRID, GRID);

  drawGrid(ctx);
  drawModelGuide(ctx);

  const view = playbackView();
  const showPlan = view !== null;

  // Persistent faint dashed previews of every missing stroke once planned.
  if (showPlan) {
    const appliedAddSlots = new Set(view.addSteps.map((s) => s.slot));
    for (const step of state.plan.steps) {
      if (step.kind !== "add" || appliedAddSlots.has(step.slot)) continue;
      drawDashedAdd(ctx, step.points, 0.35, false, 9);
    }
  }

  // Normal / playback strokes.
  const strokesToDraw = view ? view.arr : state.strokes;
  const now = performance.now();
  const moveUid = view && view.last && view.last.kind === "move" ? view.last.uid : null;
  const badgePos = resolveBadgePositions(strokesToDraw);

  strokesToDraw.forEach((s, i) => {
    if (moveUid != null && s.uid === moveUid) {
      const pulse = 0.25 + 0.18 * Math.sin(now / 220);
      drawInk(ctx, s.points, "#1d5fd0", 30 + 6 * Math.sin(now / 220), pulse);
      drawInk(ctx, s.points, "#1d5fd0", 18, 1);
    } else if (state.highlightUid != null && s.uid === state.highlightUid) {
      drawInk(ctx, s.points, "#2e86ab", 26, 0.35);
      drawInk(ctx, s.points, s.color, 18, 1);
    } else {
      drawInk(ctx, s.points, s.color || "#22201c", 18, 0.96);
    }
    drawOrderBadge(ctx, badgePos[i][0], badgePos[i][1], i + 1, s.color || "#22201c", s.preserved);
  });

  // In-progress draft.
  if (state.draft && state.draft.length > 1) {
    drawInk(ctx, state.draft, "#9aa0a6", 18, 0.8);
  }

  if (showPlan) {
    // Applied add strokes (animated dashed).
    for (const step of view.addSteps) {
      const isLast = view.last === step;
      drawDashedAdd(ctx, step.points, isLast ? 1 : 0.7, isLast, isLast ? 14 : 11);
      if (isLast) {
        const [cx, cy] = centroid(step.points);
        drawPill(ctx, cx, Math.max(60, cy - 70), `补第 ${step.slot + 1} 笔`, "#7e22ce");
      }
    }

    // Delete ghost.
    if (view.last && view.last.kind === "delete" && view.last.points) {
      const pulse = 0.3 + 0.2 * Math.sin(now / 200);
      drawInk(ctx, view.last.points, "#d3382c", 26, pulse);
      drawInk(ctx, view.last.points, "#d3382c", 16, 0.85);
      const [cx, cy] = centroid(view.last.points);
      drawPill(ctx, cx, Math.max(60, cy - 60), `删除第 ${view.last.index + 1} 笔`, "#d3382c");
    }
    // Move tag.
    if (view.last && view.last.kind === "move") {
      const target = view.arr.find((s) => s.uid === view.last.uid);
      if (target) {
        const [cx, cy] = centroid(target.points);
        drawPill(ctx, cx, Math.max(60, cy - 70),
          `移笔 ${view.last.from + 1} → ${view.last.to + 1}`, "#1d5fd0");
      }
    }

    // Auto-advance playback.
    if (state.playing && state.plan.feasible) {
      if (!state.lastTick) state.lastTick = now;
      if (now - state.lastTick > PLAY_MS) {
        if (state.pb < state.plan.steps.length) {
          state.pb += 1;
          state.lastTick = now;
          renderStepList();
          updatePlanButtons();
        }
        if (state.pb >= state.plan.steps.length) state.playing = false;
      }
    }
  }

  requestAnimationFrame(render);
}

/* ------------------------- pointer drawing ------------------------- */

canvas.addEventListener("pointerdown", (e) => {
  if (state.strokes.length >= MAX_STROKES) {
    toast(`最多 ${MAX_STROKES} 笔，请撤销或删除后再写`);
    return;
  }
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  state.drawing = true;
  const p = toGrid(e);
  state.draft = [p];
  $("canvasHint").style.opacity = "0";
});

canvas.addEventListener("pointermove", (e) => {
  if (!state.drawing || !state.draft) return;
  e.preventDefault();
  const p = toGrid(e);
  if (dist(state.draft[state.draft.length - 1], p) >= 4) state.draft.push(p);
});

function endStroke(e) {
  if (!state.drawing) return;
  state.drawing = false;
  try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
  if (e && e.clientX != null) {
    const p = toGrid(e);
    if (state.draft) state.draft.push(p);
  }
  const pts = finalizePoints(state.draft || []);
  state.draft = null;
  if (pts.length >= 2 && pathLen(pts) > 12) {
    state.strokes.push({
      uid: `u${state.uidCursor++}`,
      points: pts,
      preserved: false,
      color: PALETTE[state.colorCursor++ % PALETTE.length],
    });
    afterStrokesChanged({ keepPlan: false });
  }
}
function pathLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}
canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);

/* ------------------------- stroke list UI ------------------------- */

function afterStrokesChanged() {
  // Any handwriting / order / preserve edit is a new draft: synchronously
  // drop old trials and plans, then prepare the new draft when live.
  const shouldPrepare = state.live;
  discardResults();
  renderStrokeList();
  renderTrialProbe();
  renderPlanPanel();
  renderStepList();
  updatePlanButtons();
  if (shouldPrepare) return prepareDraft();
  return null;
}

// Teacher manually changes the actual stroke order (the "改笔序" trigger).
function moveStrokeOrder(index, delta) {
  const j = index + delta;
  if (j < 0 || j >= state.strokes.length) return;
  const [item] = state.strokes.splice(index, 1);
  state.strokes.splice(j, 0, item);
  afterStrokesChanged();
}

function invalidatePlan() {
  // Kept for older call sites: full teardown of results for this draft.
  discardResults();
  renderTrialProbe();
  renderPlanPanel();
  renderStepList();
  updatePlanButtons();
}

function renderStrokeList() {
  const ul = $("strokeList");
  ul.innerHTML = "";
  $("strokeCount").textContent = String(state.strokes.length);
  $("emptyStrokes").style.display = state.strokes.length ? "none" : "block";

  state.strokes.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "stroke-item" + (s.preserved ? " preserved" : "") +
      (state.highlightUid === s.uid ? " highlight" : "");

    const badge = document.createElement("span");
    badge.className = "order";
    badge.style.background = s.color;
    badge.textContent = String(i + 1);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<div class="name">第 ${i + 1} 笔${s.preserved ? " · 已保留" : ""}</div>
      <div class="sub">${s.points.length} 个坐标点</div>`;

    const label = document.createElement("label");
    label.className = "preserve-toggle";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!s.preserved;
    cb.addEventListener("change", () => {
      s.preserved = cb.checked;
      afterStrokesChanged();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode("保留"));

    const orderBox = document.createElement("span");
    orderBox.className = "order-actions";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "link-order";
    up.textContent = "↑";
    up.title = "上移笔序";
    up.setAttribute("aria-label", `把第 ${i + 1} 笔上移一位`);
    up.disabled = i === 0;
    up.addEventListener("click", () => moveStrokeOrder(i, -1));
    const down = document.createElement("button");
    down.type = "button";
    down.className = "link-order";
    down.textContent = "↓";
    down.title = "下移笔序";
    down.setAttribute("aria-label", `把第 ${i + 1} 笔下移一位`);
    down.disabled = i === state.strokes.length - 1;
    down.addEventListener("click", () => moveStrokeOrder(i, 1));
    orderBox.appendChild(up);
    orderBox.appendChild(down);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "link-del";
    del.textContent = "删除";
    if (s.preserved) {
      del.disabled = true;
      del.title = "保留笔不能删除；请先取消“保留”";
    }
    del.addEventListener("click", () => {
      if (s.preserved) return;
      state.strokes.splice(i, 1);
      afterStrokesChanged();
    });

    li.appendChild(badge);
    li.appendChild(meta);
    li.appendChild(orderBox);
    li.appendChild(label);
    li.appendChild(del);

    li.addEventListener("mouseenter", () => { state.highlightUid = s.uid; });
    li.addEventListener("mouseleave", () => { state.highlightUid = null; });
    ul.appendChild(li);
  });
}

/* --------------------------- plan panel --------------------------- */

function currentTrial() {
  if (!state.prep || state.prep.status !== "ready") return null;
  return state.prep.levels.get(Number(state.threshold)) || null;
}

function renderTrialProbe() {
  const bar = $("sliderTrial");
  const inline = $("sliderTrialText");
  if (!bar || !inline) return;
  const t = Number(state.threshold);
  $("trialThreshold").textContent = String(t);
  bar.dataset.threshold = String(t);

  const dormant = $("trialDormant");
  const loading = $("trialLoading");
  const errBox = $("trialError");
  const result = $("trialResult");
  const noSol = $("trialNoSolution");
  const dragHint = $("trialDragHint");
  const consist = $("trialConsistency");
  [dormant, loading, errBox, result, noSol].forEach((el) => { el.hidden = true; });
  dragHint.hidden = !state.sliderActive;
  consist.hidden = true;
  consist.classList.remove("is-mismatch");
  consist.textContent = "✓ 正式方案的动作数与可行性和试算一致";

  bar.classList.remove("is-dormant", "is-loading", "is-error",
                       "is-feasible", "is-infeasible", "is-dragging");
  if (state.sliderActive) bar.classList.add("is-dragging");
  inline.className = "threshold-probe";
  inline.textContent = "";
  inline.title = "";

  if (!state.live || !state.prep) {
    bar.classList.add("is-dormant");
    bar.dataset.state = "dormant";
    bar.dataset.feasible = "";
    bar.dataset.cost = "";
    dormant.hidden = false;
    return;
  }

  if (state.prep.status === "loading") {
    bar.classList.add("is-loading");
    bar.dataset.state = "loading";
    bar.dataset.feasible = "";
    bar.dataset.cost = "";
    loading.hidden = false;
    inline.classList.add("is-busy");
    inline.textContent = `上限 ${t}：各档试算准备中…`;
    return;
  }

  if (state.prep.status === "error") {
    bar.classList.add("is-error");
    bar.dataset.state = "error";
    bar.dataset.feasible = "";
    bar.dataset.cost = "";
    errBox.hidden = false;
    inline.classList.add("is-busy");
    inline.textContent = `上限 ${t}：试算准备失败，可重试`;
    return;
  }

  const lv = state.prep.levels.get(t);
  if (!lv) {
    bar.dataset.state = "missing";
    return;
  }

  // Preparation is ready; feasibility lives in data-feasible.
  bar.dataset.state = "ready";
  bar.dataset.feasible = String(!!lv.feasible);
  if (lv.feasible) {
    bar.classList.add("is-feasible");
    bar.dataset.cost = String(lv.cost);
    result.hidden = false;
    $("trialCost").textContent = String(lv.cost);
    $("trialMove").textContent = String(lv.counts.move);
    $("trialDel").textContent = String(lv.counts.delete);
    $("trialAdd").textContent = String(lv.counts.add);
    inline.classList.add("is-feasible");
    inline.textContent =
      `上限 ${t}：最少 ${lv.cost} 步（移 ${lv.counts.move} · 删 ${lv.counts.delete} · 补 ${lv.counts.add}）`;
  } else {
    bar.classList.add("is-infeasible");
    bar.dataset.cost = "";
    noSol.hidden = false;
    $("trialReason").textContent = lv.reason ? `—— ${lv.reason}` : "";
    inline.classList.add("is-infeasible");
    inline.textContent = `上限 ${t}：无解`;
    inline.title = lv.reason || "";
  }

  // Cross-check the released formal plan against this stop's trial.
  const p = state.plan;
  if (!state.sliderActive && !state.planLoading && p &&
      state.planThreshold === t) {
    let ok = p.feasible === !!lv.feasible;
    if (ok && p.feasible && lv.feasible && p.counts && lv.counts) {
      ok = p.cost === lv.cost &&
        p.counts.move === lv.counts.move &&
        p.counts.delete === lv.counts.delete &&
        p.counts.add === lv.counts.add;
    }
    bar.dataset.consistent = ok ? "true" : "false";
    if (ok) {
      consist.hidden = false;
    } else {
      consist.hidden = false;
      consist.classList.add("is-mismatch");
      consist.textContent = "⚠ 正式方案与试算不一致，请点“求最优修订”重试";
      // Should be unreachable: same core solver and same inputs.
      console.error("plan/trial mismatch", { threshold: t, plan: p, trial: lv });
    }
  } else {
    bar.dataset.consistent = "";
  }
}

function renderPlanPanel() {
  const stale = $("staleNotice");
  const noSol = $("noSolution");
  const summary = $("planSummary");
  const errBox = $("planError");
  const loadingBox = $("planLoading");

  stale.hidden = !(state.planStale && state.live && !state.plan);
  errBox.hidden = !state.planError;
  $("planErrorText").textContent =
    state.planError || "正式方案求解失败，笔迹已保留。";
  loadingBox.hidden = !state.planLoading;

  if (state.plan && state.plan.feasible) {
    noSol.hidden = true;
    summary.hidden = false;
    $("costTotal").textContent = state.plan.cost;
    $("cntMove").textContent = state.plan.counts.move;
    $("cntDel").textContent = state.plan.counts.delete;
    $("cntAdd").textContent = state.plan.counts.add;
  } else if (state.plan && !state.plan.feasible) {
    summary.hidden = true;
    noSol.hidden = false;
    noSol.textContent = state.plan.reason || "无解";
  } else {
    summary.hidden = true;
    noSol.hidden = true;
  }
  updatePlanButtons();
}

function updatePlanButtons() {
  const thresholdNow = Number(state.threshold);
  const planCurrent = !!(state.plan && state.plan.feasible && !state.planStale &&
    !state.planLoading && state.planThreshold === thresholdNow);
  // While dragging the slider, playback and adoption are explicitly suspended.
  const canUsePlan = planCurrent && !state.sliderActive;
  const steps = canUsePlan ? state.plan.steps : [];
  const realNext = canUsePlan ? state.plan.next_action : null;

  $("btnPlan").disabled = state.planLoading || !state.model.length;
  $("btnPlan").textContent = state.planLoading ? "求解中…" : "求最优修订";

  $("btnAdopt").disabled = !realNext || state.planLoading || state.sliderActive;
  if (state.sliderActive) {
    $("btnAdopt").textContent = "松开滑块后生成正式方案";
    $("adoptHint").textContent = "拖动中已停用采纳";
  } else if (realNext) {
    const verb = realNext.kind === "delete" ? "删除" : "移动";
    const where = realNext.kind === "delete"
      ? `第 ${realNext.index + 1} 笔`
      : `第 ${realNext.from + 1} 笔 → 第 ${realNext.to + 1} 位`;
    $("btnAdopt").textContent = `采纳下一步：${verb}${where}`;
    $("adoptHint").textContent = "采纳后按当前实际笔序重新准备 / 求解";
  } else {
    $("btnAdopt").textContent = "采纳下一步移笔 / 删笔";
    $("adoptHint").textContent = planCurrent
      ? (state.plan.counts.add ? "已无需移 / 删，请播放查看虚线补笔" : "已经符合范字笔序")
      : (state.planLoading ? "正式方案生成中…" : "");
  }

  const hasSteps = steps.length > 0;
  $("btnPlay").disabled = !hasSteps || state.sliderActive;
  $("btnNext").disabled = !hasSteps || state.pb >= steps.length || state.sliderActive;
  $("btnPrev").disabled = !hasSteps || state.pb <= 0 || state.sliderActive;
  $("btnResetPb").disabled = !hasSteps || state.pb === 0 || state.sliderActive;
  $("btnPlay").textContent = state.playing ? "暂停" : (state.pb >= steps.length ? "重播" : "播放");

  const playback = document.querySelector(".playback");
  if (playback) playback.classList.toggle("is-locked", !!state.sliderActive);
}

function stepTag(kind) {
  if (kind === "move") return '<span class="tag tag-move">移</span>';
  if (kind === "delete") return '<span class="tag tag-delete">删</span>';
  return '<span class="tag tag-add">补</span>';
}

function renderStepList() {
  const ol = $("stepList");
  if (!state.plan || !state.plan.feasible || state.planStale) {
    ol.innerHTML = "";
    return;
  }
  const steps = state.plan.steps;
  ol.innerHTML = "";
  steps.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "step" + (i < state.pb - 1 ? " done" : "") +
      (i === state.pb - 1 ? " current" : "");
    li.innerHTML = `<span class="n">${i + 1}</span><span>${stepTag(s.kind)}${s.label}</span>`;
    li.addEventListener("click", () => {
      if (state.sliderActive || state.planLoading) return;
      state.playing = false;
      state.pb = i + 1;
      state.lastTick = 0;
      renderStepList();
      updatePlanButtons();
    });
    ol.appendChild(li);
  });
  updatePlanButtons();
}

/* --------------------------- adopt action --------------------------- */

async function adoptNext() {
  if (state.sliderActive || state.planLoading) return;
  const na = state.plan && state.plan.next_action;
  if (!na || state.planStale || state.planThreshold !== Number(state.threshold)) return;

  // Guard against any index/uid mismatch.
  if (na.uid != null && state.strokes[na.index] &&
      state.strokes[na.index].uid !== na.uid) {
    const idx = state.strokes.findIndex((s) => s.uid === na.uid);
    if (idx < 0) { toast("该笔已不存在，建议失效，请重新求解"); invalidatePlan(); return; }
    if (na.kind === "delete") na.index = idx;
    else na.from = idx;
  }

  addAdoptLog(na.label);

  if (na.kind === "delete") {
    state.strokes.splice(na.index, 1);
  } else {
    applyMove(state.strokes, na.from, na.to);
  }
  // Content / actual stroke order changed: old trials and plan come down
  // immediately and preparation for the new draft starts at once.
  const prep = afterStrokesChanged();
  const ok = prep ? await prep.planPromise : false;
  if (ok) toast("已采纳，并按实际笔序重新计算");
}

function addAdoptLog(label) {
  const ul = $("adoptLog");
  const li = document.createElement("li");
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  li.innerHTML = `${label}<small>${hh}:${mm}:${ss}</small>`;
  ul.prepend(li);
}

/* --------------------------- sample data --------------------------- */

async function loadSample() {
  if (!state.charId) return;
  const charId = state.charId;
  try {
    const data = await fetchJSON(`/api/sample/${charId}`);
    // Character switched while the sample was loading: drop stale response.
    if (state.charId !== charId) return;
    state.colorCursor = 0;
    state.uidCursor = 1;
    state.strokes = data.strokes.map((s) => ({
      uid: s.uid,
      points: s.points,
      preserved: false,
      color: PALETTE[state.colorCursor++ % PALETTE.length],
    }));
    state.live = true;
    discardResults();
    renderStrokeList();
    $("canvasHint").style.opacity = "0";
    prepareDraft();
    toast("已填入含移笔 / 删笔 / 缺笔错误的示例，各档试算准备中…");
  } catch (e) {
    toast("示例载入失败：" + e.message);
  }
}

/* --------------------------- wire controls --------------------------- */

const thresholdSlider = $("threshold");
thresholdSlider.addEventListener("input", (e) => {
  const v = Number(e.target.value);
  state.threshold = v;
  $("thresholdValue").textContent = e.target.value;

  if (!state.sliderActive) {
    state.sliderActive = true;
    state.playing = false;
    // A fresh (re-)drag voids any formal plan still in flight; its response
    // is token-dropped / aborted and must not reach the screen.
    cancelFormalPlan();
    // Dragging before the first solve arms the one-time trial preparation.
    if (!state.live) {
      state.live = true;
      discardResults();
      prepareDraft({ plan: false });
    }
  }
  // With trials prepared this is a pure local render: no request is sent.
  renderTrialProbe();
  updatePlanButtons();
});

thresholdSlider.addEventListener("change", async (e) => {
  const v = Number(e.target.value);
  state.threshold = v;
  $("thresholdValue").textContent = e.target.value;
  state.sliderActive = false;
  state.pb = 0;
  renderTrialProbe();
  renderStepList();
  updatePlanButtons();

  if (!state.live) {
    // Commit before any input armed preparation (defensive): first solve.
    startSolving();
    return;
  }
  // Release: generate the formal plan for exactly the selected stop. Its
  // feasibility / counts must equal the local trial for this threshold.
  const ok = await requestPlan();
  if (ok) renderTrialProbe();
});

$("btnPlan").addEventListener("click", startSolving);
$("btnPlanRetry").addEventListener("click", () => {
  state.planError = "";
  requestPlan();
});
$("btnTrialRetry").addEventListener("click", () => {
  requestPreview();
});
$("btnAdopt").addEventListener("click", adoptNext);
$("btnUndo").addEventListener("click", () => {
  if (!state.strokes.length) return;
  state.strokes.pop();
  afterStrokesChanged();
});
$("btnClear").addEventListener("click", () => {
  if (!state.strokes.length) return;
  if (!window.confirm("确定清空全部实写笔迹吗？")) return;
  state.strokes = [];
  afterStrokesChanged();
  $("canvasHint").style.opacity = "1";
});
$("btnSample").addEventListener("click", loadSample);

$("btnPlay").addEventListener("click", () => {
  if (!state.plan || !state.plan.steps.length) return;
  if (state.pb >= state.plan.steps.length) state.pb = 0; // replay
  state.playing = !state.playing;
  state.lastTick = 0;
  updatePlanButtons();
});
$("btnNext").addEventListener("click", () => {
  state.playing = false;
  if (state.pb < state.plan.steps.length) state.pb += 1;
  state.lastTick = 0;
  renderStepList();
});
$("btnPrev").addEventListener("click", () => {
  state.playing = false;
  if (state.pb > 0) state.pb -= 1;
  state.lastTick = 0;
  renderStepList();
});
$("btnResetPb").addEventListener("click", () => {
  state.playing = false; state.pb = 0; state.lastTick = 0;
  renderStepList();
});

/* ------------------------------ boot ------------------------------ */
resizeCanvas();
renderTrialProbe();
requestAnimationFrame(render);
initCharacters().catch((e) => toast("范字加载失败：" + e.message));

// Debug / DOM-smoke hook: read-only-ish access to the prepared trials.
window.__strokeApp = { state, sliderLevels, currentTrial };
