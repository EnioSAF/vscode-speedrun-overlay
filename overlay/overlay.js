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
    text: $("textBar"),
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
    if (!node) return;
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

function moodFromActivity(mix, kpm, lpm) {
    const textPct = mix.textPct || 0;
    const codePct = mix.jsPct + mix.cssPct + mix.htmlPct;

    // THINK: écriture de texte/docs/comments
    if (textPct > 40 && kpm < 200) {
        return { text: "THINK", color: "#38bdf8" };
    }

    // FLOW: code intense avec bonne cadence
    if (codePct > 60 && kpm > 200 && Math.abs(lpm) > 5) {
        return { text: "FLOW", color: "#35e08c" };
    }

    // ZOOM: frappe ultra rapide
    if (kpm > 280) {
        return { text: "ZOOM", color: "#ffd166" };
    }

    // WORK: code actif
    if (codePct > 40 && kpm > 100) {
        return { text: "WORK", color: "#38bdf8" };
    }

    // DEBUG: beaucoup de suppressions
    if (lpm < -10 && kpm > 80) {
        return { text: "DEBUG", color: "#f97316" };
    }

    // IDLE: peu d'activité
    if (kpm < 50) {
        return { text: "IDLE", color: "rgba(230, 241, 255, 0.4)" };
    }

    // ACTIVE: par défaut si actif
    return { text: "ACTIVE", color: "#fbbf24" };
}

function renderSplits(list) {
    el.splits.innerHTML = "";
    list.forEach((s, i) => {
        const d = document.createElement("div");
        const isCurrent = i === list.length - 1;
        const type = s.type || "default";
        d.className = `split type-${type}${isCurrent ? " current" : ""}`;

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
    const text = filesByExt.text || 0;
    const other = filesByExt.other || 0;
    const total = Math.max(1, js + css + html + text + other);

    return {
        jsPct: Math.round((js / total) * 100),
        cssPct: Math.round((css / total) * 100),
        htmlPct: Math.round((html / total) * 100),
        textPct: Math.round((text / total) * 100),
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

        // CODE MIX
        const mix = computeCodeMix(s.metrics.filesByExt || {});

        bar(el.js, mix.jsPct, "#38bdf8");
        bar(el.css, mix.cssPct, "#35e08c");
        bar(el.html, mix.htmlPct, "#fb9238");
        bar(el.text, mix.textPct, "#fbbf24");
        bar(el.other, mix.otherPct, "#b26bff");

        // MOOD basé sur le code mix
        const mood = moodFromActivity(mix, kpm, lpm);
        el.mood.textContent = mood.text;
        el.mood.style.color = mood.color;

        el.split.textContent = s.run.current?.name || s.run.currentSegment?.name || "—";

        const list = [...(s.run.splits || [])];
        if (s.run.currentSegment) list.push(s.run.currentSegment);
        renderSplits(list);
    };

    ws.onclose = () => setTimeout(connect, 800);
}
connect();