const qs = new URLSearchParams(location.search);
const serverOverride = (document.body?.dataset?.server || "").trim();
const serverParam = serverOverride || qs.get("server") || "";
const toWsUrl = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.startsWith("ws://") || raw.startsWith("wss://")) return raw;
    if (raw.startsWith("http://")) return "ws://" + raw.slice("http://".length);
    if (raw.startsWith("https://")) return "wss://" + raw.slice("https://".length);
    return `ws://${raw}`;
};
const wsUrl = serverParam ? toWsUrl(serverParam) : "ws://localhost:17890";

const scaleOverride = (document.body?.dataset?.scale || "").trim();
const scaleParam = scaleOverride || qs.get("scale") || "";
const scaleValue = Number(scaleParam);
if (Number.isFinite(scaleValue) && scaleValue > 0) {
    document.documentElement.style.setProperty("--overlay-scale", String(scaleValue));
}

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
    diagSummary: $("diagSummary"),

    diag: $("diag"),

    build: $("buildValue"),
    buildLabel: $("buildLabel"),
    buildToast: $("buildToast"),
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
    currentDate: $("currentDate"),
    splitType: $("splitType"),
};

let run = "stopped",
    base = 0,
    sync = 0;
let lastBuildStatus = null;
let lastBuildState = "idle";
let lastBuildLabel = null;

function showBuildToast(text, level) {
    if (!el.buildToast) return;
    el.buildToast.textContent = text;
    el.buildToast.classList.remove("good", "bad", "warn", "show");
    if (level) el.buildToast.classList.add(level);
    void el.buildToast.offsetWidth;
    el.buildToast.classList.add("show");
}

const pad = (n) => String(n).padStart(2, "0");
const fmt = (ms) => {
    if (ms >= 3600000) {
        const h = (ms / 3600000) | 0;
        const m = ((ms % 3600000) / 60000) | 0;
        const s = ((ms % 60000) / 1000) | 0;
        return `${h}:${pad(m)}:${pad(s)}`;
    }
    return `${pad((ms / 60000) | 0)}:${pad(((ms % 60000) / 1000) | 0)}.${pad(((ms % 1000) / 10) | 0)}`;
};
const fmtDelta = (ms) => {
    const sign = ms >= 0 ? "+" : "-";
    const abs = Math.abs(ms);
    if (abs >= 3600000) {
        const h = (abs / 3600000) | 0;
        const m = ((abs % 3600000) / 60000) | 0;
        const s = ((abs % 60000) / 1000) | 0;
        return `${sign}${h}:${pad(m)}:${pad(s)}`;
    }
    if (abs >= 60000) {
        const m = (abs / 60000) | 0;
        const s = ((abs % 60000) / 1000) | 0;
        return `${sign}${pad(m)}:${pad(s)}`;
    }
    const sec = abs / 1000;
    const str = sec < 10 ? sec.toFixed(1) : sec.toFixed(0);
    return `${sign}${str}s`;
};
const deltaShift = (ms) => {
    const maxShift = 20;
    const span = 30000;
    const ratio = Math.max(-1, Math.min(1, ms / span));
    return Math.round(ratio * maxShift);
};
const trimTrailingZero = (s) => s.replace(/\.0$/, "");
const shortCount = (n) => {
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(Number(n) || 0);
    if (abs >= 1_000_000_000) {
        const v = abs / 1_000_000_000;
        return sign + trimTrailingZero(v >= 10 ? v.toFixed(0) : v.toFixed(1)) + "B";
    }
    if (abs >= 1_000_000) {
        const v = abs / 1_000_000;
        return sign + trimTrailingZero(v >= 10 ? v.toFixed(0) : v.toFixed(1)) + "M";
    }
    if (abs >= 1_000) {
        const v = abs / 1_000;
        return sign + trimTrailingZero(v >= 10 ? v.toFixed(0) : v.toFixed(1)) + "k";
    }
    return sign + String(abs);
};

const dateFormatter = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
});

function updateDate() {
    if (!el.currentDate) return;
    el.currentDate.textContent = dateFormatter.format(new Date());
}

updateDate();
setInterval(updateDate, 60 * 1000);

function loop() {
    el.time.textContent = fmt(run === "running" ? base + (performance.now() - sync) : base);
    requestAnimationFrame(loop);
}
loop();

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function colorScale(value, min, max, invert) {
    const t = clamp((value - min) / (max - min), 0, 1);
    const v = invert ? 1 - t : t;
    const hue = 120 * v;
    return `hsl(${hue}, 85%, 55%)`;
}

function setValueColor(node, value, min, max, invert) {
    if (!node) return;
    node.style.color = colorScale(value, min, max, invert);
}

function setKpmPower(node, kpm) {
    if (!node) return;
    const n = Math.max(0, Number(kpm) || 0);
    node.style.setProperty("--kpm", String(n));
    node.classList.remove("power-0", "power-1", "power-2", "power-3", "power-4");
    if (n === 0) node.classList.add("power-0");
    else if (n < 80) node.classList.add("power-1");
    else if (n < 180) node.classList.add("power-2");
    else if (n < 280) node.classList.add("power-3");
    else node.classList.add("power-4");
}

function shortText(s, max) {
    const text = String(s || "");
    if (!text) return "-";
    return text.length > max ? text.slice(0, Math.max(0, max - 3)) + "..." : text;
}

function diagColor(count, rgb) {
    const t = clamp(count / 20, 0, 1);
    const a = 0.35 + t * 0.65;
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
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
    if (!s) return "-";
    const parts = s.split(/[/\\]/);
    return parts[parts.length - 1] || "-";
}

function mixColorForFile(p) {
    const name = String(p || "");
    const ext = name.split(".").pop()?.toLowerCase();
    switch (ext) {
        case "js":
        case "ts":
        case "jsx":
        case "tsx":
            return "#38bdf8";
        case "css":
        case "scss":
        case "sass":
            return "#35e08c";
        case "html":
        case "htm":
            return "#fb9238";
        case "md":
        case "txt":
        case "json":
            return "#fbbf24";
        default:
            return "#b26bff";
    }
}

function moodFromActivity(mix, kpm, lpm, consoleActive) {
    const textPct = mix.textPct || 0;
    const codePct = mix.jsPct + mix.cssPct + mix.htmlPct;

    if (consoleActive && kpm < 50) {
        return { text: "CONSOLE", color: "#38bdf8" };
    }

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

const splitTypeLabels = {
    work: "WORK",
    brainstorm: "BRAIN",
    chill: "CHILL",
    debug: "DEBUG",
    default: "GEN"
};
const splitTypeClasses = ["type-work", "type-brainstorm", "type-chill", "type-debug", "type-default"];

function setSplitType(type) {
    if (!el.splitType) return;
    const t = splitTypeLabels[type] ? type : "default";
    el.splitType.textContent = splitTypeLabels[t];
    el.splitType.classList.remove(...splitTypeClasses);
    el.splitType.classList.add(`type-${t}`);
}

function renderSplits(list) {
    el.splits.innerHTML = "";
    list.forEach((s, i) => {
        const prevSegMs = i > 0 ? (list[i - 1]?.segMs ?? null) : null;
        if (prevSegMs != null) {
            const diff = s.segMs - prevSegMs;
            const gap = document.createElement("div");
            gap.className = "split-gap";

            const toast = document.createElement("span");
            toast.className = `delta-toast ${diff <= 0 ? "good" : "bad"}`;
            toast.textContent = fmtDelta(diff);
            toast.style.setProperty("--delta-shift", `${deltaShift(diff)}px`);

            gap.appendChild(toast);
            el.splits.appendChild(gap);
        }

        const d = document.createElement("div");
        const isCurrent = i === list.length - 1;
        const type = s.type || "default";
        d.className = `split type-${type}${isCurrent ? " current" : ""}`;

        const fc = s.summary?.filesCreated ?? 0;
        const fd = s.summary?.filesDeleted ?? 0;
        const linesNet = s.summary?.linesNet ?? 0;
        const charsNet = s.summary?.charsNet ?? 0;
        const prec = s.summary?.precision ?? 0;

        const name = document.createElement("div");
        name.className = "name";
        name.textContent = s.name;

        const meta = document.createElement("div");
        meta.className = "meta";

        const t = document.createElement("span");
        t.textContent = fmt(s.segMs);

        const l = document.createElement("span");
        l.textContent = `L${linesNet}`;
        l.style.color = colorScale(Math.abs(linesNet), 0, 50, false);

        const p = document.createElement("span");
        p.textContent = `P${prec}%`;
        p.style.color = colorScale(prec, 0, 100, false);

        const f = document.createElement("span");
        f.textContent = `F+${fc}/-${fd}`;
        f.style.color = colorScale(fc + fd, 0, 10, false);

        const c = document.createElement("span");
        c.textContent = `C${shortCount(charsNet)}`;
        c.style.color = colorScale(Math.abs(charsNet), 0, 5000, false);

        meta.append(t, l, c, p, f);
        d.append(name, meta);
        el.splits.appendChild(d);
    });
    scheduleSplitsScroll();
}

let splitsScroll = { distance: 0, duration: 0 };
let splitsScrollPending = false;

function updateSplitsScroll() {
    if (!el.splits) return;
    const track = el.splits;
    const viewport = track.parentElement;
    if (!viewport) return;
    const distance = Math.max(0, track.scrollHeight - viewport.clientHeight);
    if (distance <= 2) {
        if (splitsScroll.distance !== 0) {
            track.style.animation = "none";
            track.style.transform = "translateY(0px)";
            track.style.removeProperty("--scroll-distance");
            splitsScroll = { distance: 0, duration: 0 };
        }
        return;
    }
    const duration = Math.max(8000, Math.round(distance * 45));
    if (distance === splitsScroll.distance && duration === splitsScroll.duration) return;
    track.style.setProperty("--scroll-distance", `${distance}px`);
    track.style.animation = `splits-scroll ${duration}ms linear infinite`;
    splitsScroll = { distance, duration };
}

function scheduleSplitsScroll() {
    if (splitsScrollPending) return;
    splitsScrollPending = true;
    requestAnimationFrame(() => {
        splitsScrollPending = false;
        updateSplitsScroll();
    });
}

function computeCodeMix(filesByExt) {
    const js = filesByExt.js || 0;
    const css = filesByExt.css || 0;
    const html = filesByExt.html || 0;
    const text = filesByExt.txt || 0;   // <-- ICI
    const other = filesByExt.oth || 0;   // <-- ICI

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

        setKpmPower(el.kpm, kpm);
        setValueColor(el.prec, prec, 0, 100, false);
        setValueColor(el.lpm, Math.abs(lpm), 0, 50, false);

        const filesTouched = s.metrics.segment?.filesTouched ?? s.metrics.totals.filesTouchedCount;
        el.files.textContent = filesTouched;
        setValueColor(el.files, filesTouched, 0, 20, false);
        const activeFile = s.metrics.activeFile;
        el.activeFile.textContent = basename(activeFile);
        el.activeFile.style.color = activeFile ? mixColorForFile(activeFile) : "";

        const segCreated = s.metrics.segment?.filesCreated ?? 0;
        const segDeleted = s.metrics.segment?.filesDeleted ?? 0;
        el.filesDelta.innerHTML = `<span class="pos">+${segCreated}</span>/<span class="neg">-${segDeleted}</span>`;
        const posEl = el.filesDelta.querySelector(".pos");
        const negEl = el.filesDelta.querySelector(".neg");
        if (posEl) posEl.classList.toggle("active", segCreated > 0);
        if (negEl) negEl.classList.toggle("active", segDeleted > 0);

        const errors = s.metrics.diagnostics.errors;
        const warnings = s.metrics.diagnostics.warnings;
        el.diag.innerHTML = `<span class="diag-errors">E${errors}</span> <span class="diag-warnings">W${warnings}</span>`;
        const errEl = el.diag.querySelector(".diag-errors");
        const warnEl = el.diag.querySelector(".diag-warnings");
        if (errEl) errEl.style.color = diagColor(errors, [255, 107, 107]);
        if (warnEl) warnEl.style.color = diagColor(warnings, [255, 169, 77]);

        const worst = s.metrics.diagnostics.worst;
        if (el.diagSummary) {
            if (worst && (worst.message || worst.source)) {
                const sev = String(worst.severity || "info").toUpperCase();
                const src = worst.source ? `${worst.source}: ` : "";
                el.diagSummary.textContent = shortText(`${sev} ${src}${worst.message || ""}`.trim(), 28);
            } else {
                el.diagSummary.textContent = "-";
            }
        }

        const build = s.metrics.build;
        const buildLabel = String(build.label || build.lastLabel || "BUILD").toUpperCase();
        if (el.buildLabel) el.buildLabel.textContent = buildLabel;
        el.build.textContent = build.status === "running"
            ? "RUN"
            : build.lastStatus === "fail"
                ? "FAIL"
                : build.lastStatus === "success"
                    ? "OK"
                    : "IDLE";
        clearPerfClasses(el.build);
        if (build.status === "running") {
            el.build.classList.add("warn");
        } else if (build.lastStatus === "fail") {
            el.build.classList.add("bad");
        } else if (build.lastStatus === "success") {
            el.build.classList.add("good");
        }

        if (build.status === "running" && lastBuildState !== "running") {
            showBuildToast(`${buildLabel}...`, "warn");
        } else if (build.status !== "running" && build.lastStatus && (build.lastStatus !== lastBuildStatus || buildLabel !== lastBuildLabel)) {
            showBuildToast(`${buildLabel} ${build.lastStatus === "fail" ? "FAIL" : "OK"}`, build.lastStatus === "fail" ? "bad" : "good");
        }
        lastBuildState = build.status;
        lastBuildStatus = build.lastStatus || null;
        lastBuildLabel = buildLabel;

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

        setValueColor(el.focusVal, focus, 0, 100, false);
        setValueColor(el.actVal, act, 0, 100, false);
        setValueColor(el.paceVal, kpm, 0, 300, false);

        // CODE MIX
        const mix = computeCodeMix(s.metrics.filesByExt || {});

        bar(el.js, mix.jsPct, "#38bdf8");
        bar(el.css, mix.cssPct, "#35e08c");
        bar(el.html, mix.htmlPct, "#fb9238");
        bar(el.text, mix.textPct, "#fbbf24");
        bar(el.other, mix.otherPct, "#b26bff");

        // MOOD basé sur le code mix
        const consoleActive = s.metrics.console?.status === "running";
        const mood = moodFromActivity(mix, kpm, lpm, consoleActive);
        el.mood.textContent = mood.text;
        el.mood.style.color = mood.color;

        el.split.textContent = s.run.current?.name || s.run.currentSegment?.name || "-";
        setSplitType(s.run.current?.type || s.run.currentSegment?.type || "default");

        const list = [...(s.run.splits || [])];
        if (s.run.currentSegment) list.push(s.run.currentSegment);
        renderSplits(list);
    };

    ws.onclose = () => setTimeout(connect, 800);
}
connect();
