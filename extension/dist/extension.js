"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
const url_1 = require("url");
let serverProcess = null;
/* =====================================================
   Utils HTTP
===================================================== */
function requestJson(baseUrl, path, body) {
    return new Promise((resolve, reject) => {
        const url = new url_1.URL(path, baseUrl);
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const lib = url.protocol === "https:" ? https : http;
        const req = lib.request(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(data ? { "Content-Length": String(data.length) } : {})
            }
        }, res => {
            res.on("data", () => { });
            res.on("end", resolve);
        });
        req.on("error", reject);
        if (data)
            req.write(data);
        req.end();
    });
}
function getBaseUrl() {
    const cfg = vscode.workspace.getConfiguration();
    return cfg.get("speedrunOverlay.serverUrl", "http://localhost:17890");
}
function getCodeType(fileName) {
    const ext = fileName.split(".").pop()?.toLowerCase();
    switch (ext) {
        case "js":
        case "ts":
        case "jsx":
        case "tsx":
            return "js";
        case "css":
        case "scss":
        case "sass":
            return "css";
        case "html":
        case "htm":
            return "html";
        case "md":
        case "txt":
        case "json":
            return "txt";
        default:
            return "oth";
    }
}
function countNewlines(text) {
    let count = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10)
            count++;
    }
    return count;
}
function getLineOffsets(text) {
    const offsets = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10)
            offsets.push(i + 1);
    }
    return offsets;
}
function offsetAt(lineOffsets, pos) {
    const line = Math.max(0, Math.min(pos.line, lineOffsets.length - 1));
    return lineOffsets[line] + pos.character;
}
/* =====================================================
Extension
===================================================== */
function activate(context) {
    const baseUrl = () => getBaseUrl();
    const knownFiles = new Set();
    const buildTracker = { running: 0, failed: false };
    const isAutoBuildTask = (task) => {
        if (task.group === vscode.TaskGroup.Build)
            return true;
        return /(build|compile|bundle|pack|tsc|webpack|vite|rollup|dev|serve|watch|start)/i.test(task.name);
    };
    const sendBuildStart = () => requestJson(baseUrl(), "/build/start").catch(() => { });
    const sendBuildStop = (status) => requestJson(baseUrl(), "/build/stop", { status }).catch(() => { });
    const isLocalhost = (host) => host === "localhost" || host === "127.0.0.1";
    const pingServer = (url) => new Promise(resolve => {
        const lib = url.protocol === "https:" ? https : http;
        const req = lib.request(url, { method: "GET" }, res => {
            resolve(!!res.statusCode && res.statusCode >= 200 && res.statusCode < 500);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(700, () => {
            req.destroy();
            resolve(false);
        });
        req.end();
    });
    const waitForServer = async (url, timeoutMs = 2000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (await pingServer(url))
                return true;
            await new Promise(r => setTimeout(r, 150));
        }
        return false;
    };
    const ensureServerRunning = async () => {
        const base = new url_1.URL(getBaseUrl());
        if (!isLocalhost(base.hostname))
            return false;
        const port = base.port ? Number(base.port) : (base.protocol === "https:" ? 443 : 80);
        const stateUrl = new url_1.URL("/state", base);
        if (await pingServer(stateUrl))
            return true;
        if (serverProcess && !serverProcess.killed)
            return true;
        const serverPath = path.join(context.extensionPath, "server", "server.js");
        if (!fs.existsSync(serverPath))
            return false;
        serverProcess = (0, child_process_1.spawn)(process.execPath, [serverPath], {
            cwd: path.dirname(serverPath),
            env: { ...process.env, PORT: String(port) },
            stdio: "ignore"
        });
        serverProcess.on("exit", () => {
            serverProcess = null;
        });
        return await waitForServer(stateUrl);
    };
    const setRunButtonState = (btn, status) => {
        const s = status || "stopped";
        if (s === "running") {
            btn.text = "$(debug-pause) SR Pause";
            btn.tooltip = "Speedrun: Pause";
            btn.command = "speedrun.runPause";
            btn.color = "#ffd166";
        }
        else {
            btn.text = "$(rocket) SR Run";
            btn.tooltip = "Speedrun: Start/Resume";
            btn.command = "speedrun.runStart";
            btn.color = "#35e08c";
        }
    };
    const sendFilesDelta = (created, deleted, activeFile) => {
        requestJson(baseUrl(), "/metrics/files", {
            created,
            deleted,
            activeFile: activeFile ?? null
        }).catch(() => { });
    };
    const sendDiagnostics = () => {
        const all = vscode.languages.getDiagnostics();
        let errors = 0;
        let warnings = 0;
        let worst = null;
        const pickWorst = (d) => {
            const sev = d.severity === vscode.DiagnosticSeverity.Error ? "error" :
                d.severity === vscode.DiagnosticSeverity.Warning ? "warning" :
                    d.severity === vscode.DiagnosticSeverity.Information ? "info" : "hint";
            if (!worst)
                return { severity: sev, message: d.message, source: d.source };
            const rank = (s) => s === "error" ? 3 : s === "warning" ? 2 : s === "info" ? 1 : 0;
            if (rank(sev) > rank(worst.severity)) {
                return { severity: sev, message: d.message, source: d.source };
            }
            return worst;
        };
        for (const [, list] of all) {
            for (const d of list) {
                if (d.severity === vscode.DiagnosticSeverity.Error)
                    errors++;
                if (d.severity === vscode.DiagnosticSeverity.Warning)
                    warnings++;
                worst = pickWorst(d);
            }
        }
        if (buildTracker.running > 0 && errors > 0) {
            buildTracker.failed = true;
        }
        requestJson(baseUrl(), "/metrics/diagnostics", {
            errors,
            warnings,
            worst: worst ? {
                severity: worst.severity,
                message: worst.message,
                source: worst.source ?? null
            } : null
        }).catch(() => { });
    };
    /* ---------------------------------------------
    Track last known text per file
    ---------------------------------------------- */
    const lastTextByUri = new Map();
    // Init already opened documents
    for (const doc of vscode.workspace.textDocuments) {
        if (!doc.isUntitled) {
            lastTextByUri.set(doc.uri.toString(), doc.getText());
            knownFiles.add(doc.uri.fsPath);
        }
    }
    // Track newly opened documents
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => {
        if (!doc.isUntitled) {
            lastTextByUri.set(doc.uri.toString(), doc.getText());
            knownFiles.add(doc.uri.fsPath);
        }
    }));
    /* ---------------------------------------------
    Track file create/delete/rename
    ---------------------------------------------- */
    context.subscriptions.push(vscode.workspace.onDidCreateFiles(ev => {
        const file = ev.files[0]?.fsPath;
        for (const f of ev.files)
            knownFiles.add(f.fsPath);
        sendFilesDelta(ev.files.length, 0, file);
    }));
    context.subscriptions.push(vscode.workspace.onDidDeleteFiles(ev => {
        const file = ev.files[0]?.fsPath;
        for (const f of ev.files)
            knownFiles.delete(f.fsPath);
        sendFilesDelta(0, ev.files.length, file);
    }));
    context.subscriptions.push(vscode.workspace.onDidRenameFiles(ev => {
        const file = ev.files[0]?.newUri?.fsPath;
        for (const f of ev.files) {
            knownFiles.delete(f.oldUri.fsPath);
            knownFiles.add(f.newUri.fsPath);
        }
        sendFilesDelta(ev.files.length, ev.files.length, file);
    }));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.isUntitled)
            return;
        if (!knownFiles.has(doc.uri.fsPath)) {
            knownFiles.add(doc.uri.fsPath);
            sendFilesDelta(1, 0, doc.uri.fsPath);
        }
    }));
    /* ---------------------------------------------
       Track diagnostics
    ---------------------------------------------- */
    context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(() => {
        sendDiagnostics();
    }));
    sendDiagnostics();
    /* ---------------------------------------------
       Auto build tracking (VS Code tasks)
    ---------------------------------------------- */
    context.subscriptions.push(vscode.tasks.onDidStartTaskProcess(ev => {
        if (!isAutoBuildTask(ev.execution.task))
            return;
        if (buildTracker.running === 0) {
            buildTracker.failed = false;
            sendBuildStart();
        }
        buildTracker.running += 1;
    }));
    context.subscriptions.push(vscode.tasks.onDidEndTaskProcess(ev => {
        if (!isAutoBuildTask(ev.execution.task))
            return;
        if (ev.exitCode != null && ev.exitCode !== 0) {
            buildTracker.failed = true;
        }
        buildTracker.running = Math.max(0, buildTracker.running - 1);
        if (buildTracker.running === 0) {
            sendBuildStop(buildTracker.failed ? "fail" : "success");
        }
    }));
    /* ---------------------------------------------
       Track active file (focus)
    ---------------------------------------------- */
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!editor)
            return;
        const file = editor.document.fileName;
        const type = getCodeType(file);
        requestJson(baseUrl(), "/metrics/active-file", {
            file,
            type
        }).catch(() => { });
    }));
    /* ---------------------------------------------
    Track text changes → CODE MIX
    ---------------------------------------------- */
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async (ev) => {
        const doc = ev.document;
        if (doc.isUntitled)
            return;
        if (doc.getText().length > 2_000_000)
            return;
        const uri = doc.uri.toString();
        const prev = lastTextByUri.get(uri) ?? "";
        const next = doc.getText();
        lastTextByUri.set(uri, next);
        let charsAdd = 0;
        let charsRem = 0;
        let linesAdd = 0;
        let linesRem = 0;
        const lineOffsets = getLineOffsets(prev);
        for (const c of ev.contentChanges) {
            charsAdd += c.text.length;
            charsRem += c.rangeLength || 0;
            linesAdd += countNewlines(c.text);
            const start = offsetAt(lineOffsets, c.range.start);
            const end = offsetAt(lineOffsets, c.range.end);
            const safeStart = Math.min(start, prev.length);
            const safeEnd = Math.min(end, prev.length);
            if (safeEnd > safeStart) {
                linesRem += countNewlines(prev.slice(safeStart, safeEnd));
            }
        }
        if (charsAdd === 0 && charsRem === 0)
            return;
        const isUndoRedo = ev.reason === vscode.TextDocumentChangeReason.Undo ||
            ev.reason === vscode.TextDocumentChangeReason.Redo;
        const undoPenalty = isUndoRedo ? (charsAdd + charsRem) : 0;
        const type = getCodeType(doc.fileName);
        try {
            await requestJson(baseUrl(), "/metrics/code-mix", {
                type,
                charsAdd,
                charsRem,
                linesAdd,
                linesRem,
                undoPenalty,
                file: doc.fileName
            });
        }
        catch {
            // silent
        }
    }));
    /* ---------------------------------------------
    Commands (runs / splits / build)
    ---------------------------------------------- */
    const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    cmd("speedrun.runStart", async () => {
        if (!(await ensureServerRunning())) {
            vscode.window.showErrorMessage("Speedrun server not available. Check serverUrl or reinstall extension.");
            return;
        }
        const state = await requestGetJson(baseUrl(), "/state");
        const status = state?.run?.status || "stopped";
        if (status === "paused") {
            await requestJson(baseUrl(), "/run/start", {});
            setRunButtonState(runButton, "running");
            vscode.window.setStatusBarMessage("Speedrun: RESUMED", 1200);
            return;
        }
        const name = await vscode.window.showInputBox({
            title: "Start Run - Name the first split",
            placeHolder: "[work] Feature X | [debug] Fix bug | [chill] Cleanup",
            value: "Split 1"
        });
        if (name === undefined)
            return;
        await requestJson(baseUrl(), "/run/start", { name });
        setRunButtonState(runButton, "running");
        vscode.window.setStatusBarMessage(`Speedrun: RUNNING - ${name}`, 1500);
    });
    cmd("speedrun.runPause", async () => {
        if (!(await ensureServerRunning())) {
            vscode.window.showErrorMessage("Speedrun server not available. Check serverUrl or reinstall extension.");
            return;
        }
        await requestJson(baseUrl(), "/run/pause");
        setRunButtonState(runButton, "paused");
        vscode.window.setStatusBarMessage("Speedrun: PAUSED", 1200);
    });
    cmd("speedrun.runReset", async () => {
        if (!(await ensureServerRunning())) {
            vscode.window.showErrorMessage("Speedrun server not available. Check serverUrl or reinstall extension.");
            return;
        }
        await requestJson(baseUrl(), "/run/reset");
        setRunButtonState(runButton, "stopped");
        vscode.window.setStatusBarMessage("Speedrun: RESET", 1200);
    });
    cmd("speedrun.runStop", async () => {
        if (!(await ensureServerRunning())) {
            vscode.window.showErrorMessage("Speedrun server not available. Check serverUrl or reinstall extension.");
            return;
        }
        await requestJson(baseUrl(), "/run/stop");
        setRunButtonState(runButton, "stopped");
        vscode.window.setStatusBarMessage("Speedrun: STOPPED", 1200);
    });
    cmd("speedrun.split", async () => {
        if (!(await ensureServerRunning())) {
            vscode.window.showErrorMessage("Speedrun server not available. Check serverUrl or reinstall extension.");
            return;
        }
        const name = await vscode.window.showInputBox({
            title: "Next split name",
            placeHolder: "[work] Auth | [debug] Crash | [refactor] Cleanup"
        });
        if (!name)
            return;
        await requestJson(baseUrl(), "/split", { name });
        vscode.window.setStatusBarMessage(`Split: ${name}`, 1200);
    });
    cmd("speedrun.buildStart", async () => {
        if (!(await ensureServerRunning())) {
            vscode.window.showErrorMessage("Speedrun server not available. Check serverUrl or reinstall extension.");
            return;
        }
        await requestJson(baseUrl(), "/build/start");
        vscode.window.setStatusBarMessage("Build: START", 1200);
    });
    cmd("speedrun.buildSuccess", async () => {
        if (!(await ensureServerRunning())) {
            vscode.window.showErrorMessage("Speedrun server not available. Check serverUrl or reinstall extension.");
            return;
        }
        await requestJson(baseUrl(), "/build/stop", { status: "success" });
        vscode.window.setStatusBarMessage("Build: SUCCESS", 1200);
    });
    cmd("speedrun.buildFail", async () => {
        if (!(await ensureServerRunning())) {
            vscode.window.showErrorMessage("Speedrun server not available. Check serverUrl or reinstall extension.");
            return;
        }
        await requestJson(baseUrl(), "/build/stop", { status: "fail" });
        vscode.window.setStatusBarMessage("Build: FAIL", 1200);
    });
    /* ---------------------------------------------
       Status bar controls
    ---------------------------------------------- */
    const mkButton = (text, tooltip, command, priority, color) => {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, priority);
        item.text = text;
        item.tooltip = tooltip;
        item.command = command;
        if (color)
            item.color = color;
        item.show();
        context.subscriptions.push(item);
        return item;
    };
    const runButton = mkButton("$(rocket) SR Run", "Speedrun: Start/Resume", "speedrun.runStart", 100000, "#35e08c");
    const splitButton = mkButton("$(kebab-horizontal) SR Split", "Speedrun: Add Split", "speedrun.split", 99998, "#38bdf8");
    const stopButton = mkButton("$(debug-stop) SR Stop", "Speedrun: Stop", "speedrun.runStop", 99997, "#ff4d6d");
    const resetButton = mkButton("$(debug-restart)", "Speedrun: Reset", "speedrun.runReset", 99996, "#b26bff");
    setRunButtonState(runButton, "stopped");
    const syncRunState = async () => {
        const state = await requestGetJson(baseUrl(), "/state");
        const status = state?.run?.status;
        if (status)
            setRunButtonState(runButton, status);
    };
    syncRunState().catch(() => { });
    const syncTimer = setInterval(() => { syncRunState().catch(() => { }); }, 2000);
    context.subscriptions.push(new vscode.Disposable(() => clearInterval(syncTimer)));
}
function requestGetJson(baseUrl, path) {
    return new Promise(resolve => {
        const url = new url_1.URL(path, baseUrl);
        const lib = url.protocol === "https:" ? https : http;
        const req = lib.request(url, { method: "GET" }, res => {
            let data = "";
            res.on("data", d => { data += d; });
            res.on("end", () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch {
                    resolve(null);
                }
            });
        });
        req.on("error", () => resolve(null));
        req.setTimeout(700, () => {
            req.destroy();
            resolve(null);
        });
        req.end();
    });
}
function deactivate() {
    if (serverProcess && !serverProcess.killed) {
        serverProcess.kill();
        serverProcess = null;
    }
}
//# sourceMappingURL=extension.js.map