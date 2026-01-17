import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT ? Number(process.env.PORT) : 17890;

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function nowMs() { return Date.now(); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function safeDiv(a, b) { return b <= 0 ? 0 : a / b; }

function parseSplitName(raw) {
    const m = String(raw || "").trim().match(/^\s*\[(work|chill|brainstorm|debug)\]\s*(.*)$/i);
    if (!m) return { type: "default", name: String(raw || "").trim() || "Split" };
    const type = m[1].toLowerCase();
    const name = (m[2] || "").trim() || "Split";
    return { type, name };
}

function extOf(file) {
    const s = String(file || "");
    const i = s.lastIndexOf(".");
    if (i < 0) return "";
    return s.slice(i + 1).toLowerCase();
}

function bucketExt(ext) {
    if (!ext) return "other";
    if (ext === "js" || ext === "mjs" || ext === "cjs") return "js";
    if (ext === "ts" || ext === "mts" || ext === "cts") return "ts";
    if (ext === "jsx") return "jsx";
    if (ext === "tsx") return "tsx";
    if (ext === "css" || ext === "scss" || ext === "sass" || ext === "less") return "css";
    if (ext === "html" || ext === "htm") return "html";
    return "other";
}

const state = {
    run: {
        status: "stopped",
        startedAt: null,
        pausedAt: null,
        accumulatedPausedMs: 0,
        splits: [],
        lastRunSummary: null,
        snap: {
            atMs: 0,
            charsAdd: 0,
            charsRem: 0,
            linesAdd: 0,
            linesRem: 0,
            filesCount: 0,
            filesCreated: 0,
            filesDeleted: 0
        }
    },

    metrics: {
        charsAddTotal: 0,
        charsRemTotal: 0,
        linesAddedTotal: 0,
        linesRemovedTotal: 0,

        filesTouched: new Set(),
        filesByBucket: new Map(), // bucket -> Set(file)

        // Extra UX: last active file + file create/delete tracking
        activeFile: null,
        filesCreatedTotal: 0,
        filesDeletedTotal: 0,

        events: [], // { t, charsAdd, charsRem, linesAdd, linesRem }

        // Optional extra info: a "worst" diagnostic excerpt
        diagnostics: { errors: 0, warnings: 0, worst: null },

        build: {
            status: "idle",
            startedAt: null,
            lastDurationMs: null,
            lastStatus: null
        }
    }
};

function runTimeMs() {
    const r = state.run;
    if (r.status === "stopped" || !r.startedAt) return 0;
    const end = r.status === "paused" && r.pausedAt ? r.pausedAt : nowMs();
    const raw = end - r.startedAt;
    return Math.max(0, raw - r.accumulatedPausedMs);
}

function precisionPercent(charsAdd, charsRem) {
    const p = safeDiv(charsAdd, charsAdd + charsRem);
    return Math.round(p * 100);
}

function mergedActiveMs(events, windowStart, windowEnd, activeGraceMs) {
    if (!events.length) return 0;
    const intervals = [];
    for (const e of events) {
        const a = Math.max(windowStart, e.t);
        const b = Math.min(windowEnd, e.t + activeGraceMs);
        if (b > a) intervals.push([a, b]);
    }
    if (!intervals.length) return 0;

    intervals.sort((x, y) => x[0] - y[0]);

    let total = 0;
    let curA = intervals[0][0];
    let curB = intervals[0][1];

    for (let i = 1; i < intervals.length; i++) {
        const [a, b] = intervals[i];
        if (a <= curB) curB = Math.max(curB, b);
        else { total += (curB - curA); curA = a; curB = b; }
    }
    total += (curB - curA);
    return total;
}

function filesByExtPublic() {
    const out = { js: 0, ts: 0, jsx: 0, tsx: 0, css: 0, html: 0, other: 0, front: 0, back: 0 };
    for (const [bucket, set] of state.metrics.filesByBucket.entries()) {
        const n = set.size;
        if (out[bucket] == null) out.other += n;
        else out[bucket] += n;
    }
    const front = out.js + out.ts + out.jsx + out.tsx + out.css + out.html;
    const total = front + out.other;
    out.front = front;
    out.back = total - front;
    return out;
}

function toPublicState() {
    const tMs = runTimeMs();

    const windowEnd = nowMs();
    const windowStart = windowEnd - 60_000;

    state.metrics.events = state.metrics.events.filter(e => e.t >= windowStart);

    const sum = state.metrics.events.reduce(
        (acc, e) => {
            acc.add += e.charsAdd;
            acc.rem += e.charsRem;
            acc.ladd += e.linesAdd;
            acc.lrem += e.linesRem;
            return acc;
        },
        { add: 0, rem: 0, ladd: 0, lrem: 0 }
    );

    const charsPerMin = sum.add;
    const keysPerMin = Math.round(sum.add * 0.9);
    const linesNetPerMin = (sum.ladd - sum.lrem);

    const overallPrec = precisionPercent(state.metrics.charsAddTotal, state.metrics.charsRemTotal);

    const ACTIVE_GRACE_MS = 1200;
    const activeMs = mergedActiveMs(state.metrics.events, windowStart, windowEnd, ACTIVE_GRACE_MS);
    const activeRatio = clamp(Math.round(safeDiv(activeMs, 60_000) * 100), 0, 100);

    const editIntensity = clamp(sum.add + sum.rem, 0, 999999);

    const splitsCap = 200;
    const splits = state.run.splits.length > splitsCap ? state.run.splits.slice(-splitsCap) : state.run.splits;

    const seg = {
        charsAdd: Math.max(0, state.metrics.charsAddTotal - state.run.snap.charsAdd),
        charsRem: Math.max(0, state.metrics.charsRemTotal - state.run.snap.charsRem),
        linesAdd: Math.max(0, state.metrics.linesAddedTotal - state.run.snap.linesAdd),
        linesRem: Math.max(0, state.metrics.linesRemovedTotal - state.run.snap.linesRem),
        filesTouched: Math.max(0, state.metrics.filesTouched.size - state.run.snap.filesCount),
        filesCreated: Math.max(0, state.metrics.filesCreatedTotal - state.run.snap.filesCreated),
        filesDeleted: Math.max(0, state.metrics.filesDeletedTotal - state.run.snap.filesDeleted)
    };

    return {
        run: {
            status: state.run.status,
            timeMs: tMs,
            splits,
            lastRunSummary: state.run.lastRunSummary
        },
        metrics: {
            totals: {
                charsAdd: state.metrics.charsAddTotal,
                charsRem: state.metrics.charsRemTotal,
                linesAdd: state.metrics.linesAddedTotal,
                linesRem: state.metrics.linesRemovedTotal,
                filesTouchedCount: state.metrics.filesTouched.size,
                precision: overallPrec,
                filesCreated: state.metrics.filesCreatedTotal,
                filesDeleted: state.metrics.filesDeletedTotal
            },
            segment: seg,
            diagnostics: state.metrics.diagnostics,
            rolling: {
                keysPerMin: clamp(keysPerMin, 0, 99999),
                charsPerMin: clamp(charsPerMin, 0, 99999),
                linesNetPerMin: clamp(linesNetPerMin, -9999, 9999),
                precision: precisionPercent(sum.add, sum.rem),
                editIntensity
            },
            activity: {
                activeRatio,
                idleRatio: 100 - activeRatio
            },
            filesByExt: filesByExtPublic(),
            activeFile: state.metrics.activeFile,
            build: state.metrics.build
        }
    };
}

function broadcast() {
    const payload = JSON.stringify({ type: "state", data: toPublicState() });
    for (const client of wss.clients) {
        if (client.readyState === 1) client.send(payload);
    }
}

function resetMetrics() {
    state.metrics.charsAddTotal = 0;
    state.metrics.charsRemTotal = 0;
    state.metrics.linesAddedTotal = 0;
    state.metrics.linesRemovedTotal = 0;
    state.metrics.filesTouched = new Set();
    state.metrics.filesByBucket = new Map();
    state.metrics.events = [];
    state.metrics.activeFile = null;
    state.metrics.filesCreatedTotal = 0;
    state.metrics.filesDeletedTotal = 0;
    state.metrics.diagnostics = { errors: 0, warnings: 0, worst: null };
    state.metrics.build = { status: "idle", startedAt: null, lastDurationMs: null, lastStatus: null };
}

function resetRun() {
    state.run.status = "stopped";
    state.run.startedAt = null;
    state.run.pausedAt = null;
    state.run.accumulatedPausedMs = 0;
    state.run.splits = [];
    state.run.snap = {
        atMs: 0,
        charsAdd: 0,
        charsRem: 0,
        linesAdd: 0,
        linesRem: 0,
        filesCount: 0,
        filesCreated: 0,
        filesDeleted: 0
    };
}

function finishRunSummary() {
    const summary = toPublicState();
    state.run.lastRunSummary = {
        finishedAt: nowMs(),
        timeMs: summary.run.timeMs,
        splits: summary.run.splits,
        totals: summary.metrics.totals
    };
}

// --- WebSocket ---
wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "state", data: toPublicState() }));
});

// --- API ---
app.get("/state", (_req, res) => res.json(toPublicState()));

app.post("/run/start", (_req, res) => {
    if (state.run.status === "running") return res.json({ ok: true });

    if (state.run.status === "paused") {
        const pausedFor = nowMs() - state.run.pausedAt;
        state.run.accumulatedPausedMs += pausedFor;
        state.run.pausedAt = null;
        state.run.status = "running";
        broadcast();
        return res.json({ ok: true });
    }

    resetMetrics();
    resetRun();
    state.run.startedAt = nowMs();
    state.run.status = "running";
    broadcast();
    res.json({ ok: true });
});

app.post("/run/pause", (_req, res) => {
    if (state.run.status !== "running") return res.json({ ok: true });
    state.run.status = "paused";
    state.run.pausedAt = nowMs();
    broadcast();
    res.json({ ok: true });
});

app.post("/run/reset", (_req, res) => {
    if (state.run.status !== "stopped") finishRunSummary();
    resetMetrics();
    resetRun();
    broadcast();
    res.json({ ok: true });
});

app.post("/run/stop", (_req, res) => {
    if (state.run.status === "stopped") return res.json({ ok: true });
    finishRunSummary();
    resetRun();
    broadcast();
    res.json({ ok: true });
});

// --- METRICS from extension ---
app.post("/metrics/text", (req, res) => {
    const charsAdd = Math.max(0, Number(req.body?.charsAdd || 0));
    const charsRem = Math.max(0, Number(req.body?.charsRem || 0));
    const linesAdd = Math.max(0, Number(req.body?.linesAdd || 0));
    const linesRem = Math.max(0, Number(req.body?.linesRem || 0));
    const file = String(req.body?.file || "");

    state.metrics.charsAddTotal += charsAdd;
    state.metrics.charsRemTotal += charsRem;
    state.metrics.linesAddedTotal += linesAdd;
    state.metrics.linesRemovedTotal += linesRem;

    if (file) {
        state.metrics.activeFile = file;
        state.metrics.filesTouched.add(file);
        const bucket = bucketExt(extOf(file));
        if (!state.metrics.filesByBucket.has(bucket)) state.metrics.filesByBucket.set(bucket, new Set());
        state.metrics.filesByBucket.get(bucket).add(file);
    }

    if (state.run.status === "running") {
        state.metrics.events.push({ t: nowMs(), charsAdd, charsRem, linesAdd, linesRem });
    }

    broadcast();
    res.json({ ok: true });
});

// File create/delete tracking (used for per-split delta)
app.post("/metrics/files", (req, res) => {
    const created = Math.max(0, Number(req.body?.created || 0));
    const deleted = Math.max(0, Number(req.body?.deleted || 0));
    const activeFile = req.body?.activeFile != null ? String(req.body.activeFile) : null;

    state.metrics.filesCreatedTotal += created;
    state.metrics.filesDeletedTotal += deleted;
    if (activeFile) state.metrics.activeFile = activeFile;

    broadcast();
    res.json({ ok: true });
});

app.post("/metrics/diagnostics", (req, res) => {
    const errors = Math.max(0, Number(req.body?.errors || 0));
    const warnings = Math.max(0, Number(req.body?.warnings || 0));
    const worst = req.body?.worst ? {
        severity: String(req.body.worst.severity || "info"),
        message: String(req.body.worst.message || ""),
        source: req.body.worst.source != null ? String(req.body.worst.source) : null
    } : null;
    state.metrics.diagnostics.errors = errors;
    state.metrics.diagnostics.warnings = warnings;
    state.metrics.diagnostics.worst = worst;
    broadcast();
    res.json({ ok: true });
});

// --- BUILD ---
app.post("/build/start", (_req, res) => {
    state.metrics.build.status = "running";
    state.metrics.build.startedAt = nowMs();
    state.metrics.build.lastStatus = null;
    broadcast();
    res.json({ ok: true });
});

app.post("/build/stop", (req, res) => {
    const status = String(req.body?.status || "success");
    if (state.metrics.build.status !== "running" || !state.metrics.build.startedAt) {
        return res.json({ ok: true });
    }
    const dur = nowMs() - state.metrics.build.startedAt;
    state.metrics.build.status = "idle";
    state.metrics.build.lastDurationMs = dur;
    state.metrics.build.lastStatus = status === "fail" ? "fail" : "success";
    state.metrics.build.startedAt = null;
    broadcast();
    res.json({ ok: true });
});

// --- SPLIT ---
app.post("/split", (req, res) => {
    const raw = String(req.body?.name || "");
    const parsed = parseSplitName(raw);

    if (state.run.status === "stopped" || !state.run.startedAt) {
        return res.status(400).json({ ok: false, error: "Run not started" });
    }

    const atMs = runTimeMs();

    const segMs = Math.max(0, atMs - (state.run.snap.atMs || 0));
    const segCharsAdd = state.metrics.charsAddTotal - state.run.snap.charsAdd;
    const segCharsRem = state.metrics.charsRemTotal - state.run.snap.charsRem;
    const segLinesAdd = state.metrics.linesAddedTotal - state.run.snap.linesAdd;
    const segLinesRem = state.metrics.linesRemovedTotal - state.run.snap.linesRem;
    const segFiles = state.metrics.filesTouched.size - state.run.snap.filesCount;
    const segFilesCreated = state.metrics.filesCreatedTotal - state.run.snap.filesCreated;
    const segFilesDeleted = state.metrics.filesDeletedTotal - state.run.snap.filesDeleted;

    const segPrec = precisionPercent(segCharsAdd, segCharsRem);
    const segLinesNet = segLinesAdd - segLinesRem;
    const segKeys = Math.round(segCharsAdd * 0.9);

    state.run.splits.push({
        name: parsed.name,
        type: parsed.type,
        atMs,
        segMs,
        summary: {
            files: segFiles,
            filesCreated: segFilesCreated,
            filesDeleted: segFilesDeleted,
            linesNet: segLinesNet,
            precision: segPrec,
            keys: segKeys
        }
    });

    state.run.snap = {
        atMs,
        charsAdd: state.metrics.charsAddTotal,
        charsRem: state.metrics.charsRemTotal,
        linesAdd: state.metrics.linesAddedTotal,
        linesRem: state.metrics.linesRemovedTotal,
        filesCount: state.metrics.filesTouched.size,
        filesCreated: state.metrics.filesCreatedTotal,
        filesDeleted: state.metrics.filesDeletedTotal
    };

    broadcast();
    res.json({ ok: true });
});

server.listen(PORT, () => {
    console.log(`[server] running on http://localhost:${PORT}`);
});