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
const url_1 = require("url");
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
        }, (res) => {
            res.on("data", () => { });
            res.on("end", () => resolve());
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
function computeLineDelta(oldText, newText) {
    const oldLines = oldText.split(/\r\n|\r|\n/).length;
    const newLines = newText.split(/\r\n|\r|\n/).length;
    const diff = newLines - oldLines;
    return {
        add: diff > 0 ? diff : 0,
        rem: diff < 0 ? -diff : 0
    };
}
function countDiagnostics() {
    const all = vscode.languages.getDiagnostics();
    let errors = 0;
    let warnings = 0;
    for (const [, diags] of all) {
        for (const d of diags) {
            if (d.severity === vscode.DiagnosticSeverity.Error)
                errors++;
            else if (d.severity === vscode.DiagnosticSeverity.Warning)
                warnings++;
        }
    }
    return { errors, warnings };
}
function activate(context) {
    const baseUrl = () => getBaseUrl();
    const lastTextByUri = new Map();
    let trackedFiles = new Set();
    // Track file creation/deletion
    const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*");
    fileWatcher.onDidCreate(async (uri) => {
        if (!trackedFiles.has(uri.toString())) {
            trackedFiles.add(uri.toString());
            try {
                await requestJson(baseUrl(), "/metrics/files", { created: 1 });
            }
            catch { }
        }
    });
    fileWatcher.onDidDelete(async (uri) => {
        if (trackedFiles.has(uri.toString())) {
            trackedFiles.delete(uri.toString());
            try {
                await requestJson(baseUrl(), "/metrics/files", { deleted: 1 });
            }
            catch { }
        }
    });
    context.subscriptions.push(fileWatcher);
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.isUntitled)
            return;
        const uri = doc.uri.toString();
        lastTextByUri.set(uri, doc.getText());
        trackedFiles.add(uri);
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async (ev) => {
        const doc = ev.document;
        if (doc.isUntitled)
            return;
        if (doc.getText().length > 2_000_000)
            return;
        const uri = doc.uri.toString();
        const prev = lastTextByUri.get(uri) ?? doc.getText();
        const next = doc.getText();
        lastTextByUri.set(uri, next);
        let charsAdd = 0;
        let charsRem = 0;
        for (const c of ev.contentChanges) {
            charsAdd += c.text.length;
            charsRem += c.rangeLength || 0;
        }
        const { add: linesAdd, rem: linesRem } = computeLineDelta(prev, next);
        try {
            await requestJson(baseUrl(), "/metrics/text", {
                charsAdd: Math.max(0, charsAdd),
                charsRem: Math.max(0, charsRem),
                linesAdd,
                linesRem,
                file: doc.fileName
            });
        }
        catch { }
    }));
    let diagTimer = null;
    const pushDiagnostics = () => {
        if (diagTimer)
            clearTimeout(diagTimer);
        diagTimer = setTimeout(async () => {
            const counts = countDiagnostics();
            try {
                await requestJson(baseUrl(), "/metrics/diagnostics", counts);
            }
            catch { }
        }, 250);
    };
    context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(pushDiagnostics));
    pushDiagnostics();
    const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    cmd("speedrun.runStart", async () => {
        const name = await vscode.window.showInputBox({
            title: "Start Run - Name the first split",
            placeHolder: "[work] Feature X | [brainstorm] Planning | [chill] Cleanup | [debug] Fix crash",
            value: "Split 1"
        });
        if (name === undefined)
            return;
        // Reset file tracking
        trackedFiles.clear();
        await requestJson(baseUrl(), "/run/start", { name: name || "Split 1" });
        vscode.window.setStatusBarMessage(`Speedrun: RUNNING - ${name || "Split 1"}`, 1200);
    });
    cmd("speedrun.runPause", async () => {
        await requestJson(baseUrl(), "/run/pause");
        vscode.window.setStatusBarMessage("Speedrun: PAUSED", 1200);
    });
    cmd("speedrun.runReset", async () => {
        trackedFiles.clear();
        await requestJson(baseUrl(), "/run/reset");
        vscode.window.setStatusBarMessage("Speedrun: RESET", 1200);
    });
    cmd("speedrun.runStop", async () => {
        await requestJson(baseUrl(), "/run/stop");
        vscode.window.setStatusBarMessage("Speedrun: STOPPED", 1200);
    });
    cmd("speedrun.split", async () => {
        const name = await vscode.window.showInputBox({
            title: "Next split name",
            placeHolder: "[work] Auth Fix | [brainstorm] Idea | [chill] Cleanup | [debug] Fix crash"
        });
        if (!name)
            return;
        await requestJson(baseUrl(), "/split", { name });
        vscode.window.setStatusBarMessage(`Split: ${name}`, 1200);
    });
    cmd("speedrun.buildStart", async () => {
        await requestJson(baseUrl(), "/build/start");
        vscode.window.setStatusBarMessage("Build: START", 1200);
    });
    cmd("speedrun.buildSuccess", async () => {
        await requestJson(baseUrl(), "/build/stop", { status: "success" });
        vscode.window.setStatusBarMessage("Build: SUCCESS", 1200);
    });
    cmd("speedrun.buildFail", async () => {
        await requestJson(baseUrl(), "/build/stop", { status: "fail" });
        vscode.window.setStatusBarMessage("Build: FAIL", 1200);
    });
}
function deactivate() { }
//# sourceMappingURL=extension.js.map