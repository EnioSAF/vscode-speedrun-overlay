const qs = new URLSearchParams(location.search);
const wsUrl = qs.get("server")
    ? (qs.get("server").startsWith("ws") ? qs.get("server") : `ws://${qs.get("server")}`)
    : "ws://localhost:17890";

const $ = (id) => document.getElementById(id);

const el = {
    time: $("time"),
    split: $("splitName"),
    kpm: $("kpm"),
    lpm: $("lpm"),
    prec: $("prec"),

    files: $("files"),
    activeFile: $("activeFile"),
    filesDelta: $("filesDelta"),

    diag: $("diag"),

    build: $("buildValue"),
    mood: $("mood"),

    focus: $("focusBar"),
    act: $("actBar"),
    pace: $("paceBar"),
    focusVal: $("focusVal"),
    actVal: $("actVal"),
    paceVal: $("paceVal"),

    js: $("jsBar"),
    css: $("cssBar"),
    html: $("htmlBar"),
    other: $("otherBar"),

    splits: $("splits"),
};

let run = "stopped",
    base = 0,
    sync = 0;

const pad = (n) => String(n).padStart(2, "0");
const fmt = (ms) => `${pad((ms / 60000) | 0)}:${pad(((ms % 60000) / 1000) | 0)}.${pad(((ms % 1000) / 10) | 0)}`;

function loop() {
    el.time.textContent = fmt(run === "running" ? base + (performance.now() - sync) : base);
    requestAnimationFrame(loop);
}
loop();

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function bar(node, vPct, color) {
    node.style.setProperty("--v", clamp(vPct, 0, 100) + "%");
    if (color) node.style.setProperty("--c", color);
}

function clearPerfClasses(node) {
    node.classList.remove("good", "warn", "bad", "morb");
}

function setPerf(node, level) {
    clearPerfClasses(node);
    if (level) node.classList.add(level);
}

function levelFromPrecision(p) {
    if (p >= 92) return "good";
    if (p >= 80) return "warn";
    if (p >= 65) return "bad";
    return "morb";
}

function levelFromKpm(k) {
    if (k >= 280) return "good";
    if (k >= 180) return "warn";
    if (k >= 80) return "bad";
    return "morb";
}

function basename(p) {
    const s = String(p || "");
    if (!s) return "—";
    const parts = s.split(/[/\\]/);
    return parts[parts.length - 1] || "—";
}

function moodFromActivity(focusPct, actPct, kpm) {
    if (focusPct < 15 && actPct < 10) return "IDLE";
    if (focusPct > 70 && actPct > 60) return "FLOW";
    if (kpm > 240) return "ZOOM";
    if (actPct > 50) return "ACTIVE";
    return "THINK";
}

function renderSplits(list) {
    el.splits.innerHTML = "";
    list.forEach((s, i) => {
        const d = document.createElement("div");
        d.className = "split" + (i === list.length - 1 ? " current" : "");

        const fc = s.summary?.filesCreated ?? 0;
        const fd = s.summary?.filesDeleted ?? 0;

        d.innerHTML = `<div class="name">${s.name}</div>
      <div class="meta">
        <span>${fmt(s.segMs)}</span>
        <span>L${s.summary?.linesNet ?? 0}</span>
        <span>P${s.summary?.precision ?? 0}%</span>
        <span>F+${fc}/-${fd}</span>
      </div>`;
        el.splits.appendChild(d);
    });
}

function computeCodeMix(filesByExt) {
    const js = (filesByExt.js || 0) + (filesByExt.ts || 0) + (filesByExt.jsx || 0) + (filesByExt.tsx || 0);
    const css = filesByExt.css || 0;
    const html = filesByExt.html || 0;
    const other = filesByExt.other || 0;
    const total = Math.max(1, js + css + html + other);
    return {
        jsPct: Math.round((js / total) * 100),
        cssPct: Math.round((css / total) * 100),
        htmlPct: Math.round((html / total) * 100),
        otherPct: Math.round((other / total) * 100),
    };
}

let ws;
function connect() {
    ws = new WebSocket(wsUrl);

    ws.onmessage = (e) => {
        const s = JSON.parse(e.data).data;

        run = s.run.status;
        base = s.run.timeMs;
        sync = performance.now();

        const kpm = s.metrics.rolling.keysPerMin;
        const lpm = s.metrics.rolling.linesNetPerMin;
        const prec = s.metrics.rolling.precision;

        el.kpm.textContent = kpm;
        el.lpm.textContent = lpm;
        el.prec.textContent = prec + "%";

        setPerf(el.kpm, levelFromKpm(kpm));
        setPerf(el.prec, levelFromPrecision(prec));

        el.files.textContent = s.metrics.totals.filesTouchedCount;
        el.activeFile.textContent = basename(s.metrics.activeFile);

        const segCreated = s.metrics.segment?.filesCreated ?? 0;
        const segDeleted = s.metrics.segment?.filesDeleted ?? 0;
        el.filesDelta.innerHTML = `<span class="pos">+${segCreated}</span>/<span class="neg">-${segDeleted}</span>`;

        const errors = s.metrics.diagnostics.errors;
        const warnings = s.metrics.diagnostics.warnings;
        el.diag.innerHTML = `<span class="diag-errors">E${errors}</span> <span class="diag-warnings">W${warnings}</span>`;

        const build = s.metrics.build;
        el.build.textContent = build.status === "running" ? "RUN" : "IDLE";
        clearPerfClasses(el.build);
        if (build.status === "running") {
            el.build.classList.add("warn");
        } else if (build.lastStatus === "fail") {
            el.build.classList.add("bad");
        } else {
            el.build.classList.add("good");
        }

        const focus = clamp(s.metrics.activity.activeRatio, 0, 100);
        const act = clamp(Math.abs(lpm) * 2, 0, 100);
        const pace = clamp(kpm / 5, 0, 100);

        const focusColor = focus > 70 ? "#35e08c" : focus > 35 ? "#ffd166" : "#ff4d6d";
        const actColor = act > 70 ? "#38bdf8" : act > 35 ? "#ffd166" : "#b26bff";
        const paceColor = pace > 70 ? "#35e08c" : pace > 35 ? "#ffd166" : "#ff4d6d";

        bar(el.focus, focus, focusColor);
        bar(el.act, act, actColor);
        bar(el.pace, pace, paceColor);

        el.focusVal.textContent = focus + "%";
        el.actVal.textContent = String(lpm);
        el.paceVal.textContent = String(kpm);

        setPerf(el.focusVal, focus >= 70 ? "good" : focus >= 40 ? "warn" : focus >= 20 ? "bad" : "morb");
        setPerf(el.actVal, act >= 70 ? "good" : act >= 40 ? "warn" : act >= 20 ? "bad" : "morb");
        setPerf(el.paceVal, levelFromKpm(kpm));

        const moodText = moodFromActivity(focus, act, kpm);
        el.mood.textContent = moodText;
        clearPerfClasses(el.mood);
        el.mood.style.color = ""; // Reset inline style

        // Couleurs MOOD selon l'état
        if (moodText === "FLOW") {
            el.mood.classList.add("good");
        } else if (moodText === "ZOOM" || moodText === "ACTIVE") {
            el.mood.classList.add("warn");
        } else if (moodText === "THINK") {
            el.mood.classList.add("good"); // Bleu soft pour réflexion
            el.mood.style.color = "#38bdf8";
        } else if (moodText === "IDLE") {
            el.mood.style.color = "rgba(230, 241, 255, 0.4)"; // Gris très soft
        }

        const mix = computeCodeMix(s.metrics.filesByExt || {});
        bar(el.js, mix.jsPct, "#38bdf8");
        bar(el.css, mix.cssPct, "#35e08c");
        bar(el.html, mix.htmlPct, "#fb9238");
        bar(el.other, mix.otherPct, "#b26bff");

        el.split.textContent = s.run.splits?.at(-1)?.name || "—";
        renderSplits(s.run.splits || []);
    };

    ws.onclose = () => setTimeout(connect, 800);
}
connect();