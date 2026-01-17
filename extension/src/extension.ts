import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";
import { URL } from "url";

type DiagnosticsCounts = { errors: number; warnings: number };

function requestJson(baseUrl: string, path: string, body?: any): Promise<void> {
    return new Promise((resolve, reject) => {
        const url = new URL(path, baseUrl);
        const data = body ? Buffer.from(JSON.stringify(body)) : null;

        const lib = url.protocol === "https:" ? https : http;
        const req = lib.request(
            url,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(data ? { "Content-Length": String(data.length) } : {})
                }
            },
            (res: http.IncomingMessage) => {
                res.on("data", () => { });
                res.on("end", () => resolve());
            }
        );

        req.on("error", reject);
        if (data) req.write(data);
        req.end();
    });
}

function getBaseUrl(): string {
    const cfg = vscode.workspace.getConfiguration();
    return cfg.get<string>("speedrunOverlay.serverUrl", "http://localhost:17890");
}

function computeLineDelta(oldText: string, newText: string) {
    const oldLines = oldText.split(/\r\n|\r|\n/).length;
    const newLines = newText.split(/\r\n|\r|\n/).length;
    const diff = newLines - oldLines;
    return {
        add: diff > 0 ? diff : 0,
        rem: diff < 0 ? -diff : 0
    };
}

function countDiagnostics(): DiagnosticsCounts {
    const all = vscode.languages.getDiagnostics();
    let errors = 0;
    let warnings = 0;

    for (const [, diags] of all) {
        for (const d of diags) {
            if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
            else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
        }
    }
    return { errors, warnings };
}

export function activate(context: vscode.ExtensionContext) {
    const baseUrl = () => getBaseUrl();

    const lastTextByUri = new Map<string, string>();

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
            if (doc.isUntitled) return;
            lastTextByUri.set(doc.uri.toString(), doc.getText());
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async (ev) => {
            const doc = ev.document;

            // Ignore unsaved buffers (optional; you can remove this later)
            if (doc.isUntitled) return;

            // Safety on huge docs
            if (doc.getText().length > 2_000_000) return;

            const uri = doc.uri.toString();
            const prev = lastTextByUri.get(uri) ?? doc.getText();
            const next = doc.getText();
            lastTextByUri.set(uri, next);

            // charsAdd / charsRem from contentChanges
            let charsAdd = 0;
            let charsRem = 0;

            for (const c of ev.contentChanges) {
                charsAdd += c.text.length;       // inserted text
                charsRem += c.rangeLength || 0;  // removed/replaced length
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
            } catch {
                // server down => ignore
            }
        })
    );

    // Diagnostics push (debounced)
    let diagTimer: NodeJS.Timeout | null = null;
    const pushDiagnostics = () => {
        if (diagTimer) clearTimeout(diagTimer);
        diagTimer = setTimeout(async () => {
            const counts = countDiagnostics();
            try {
                await requestJson(baseUrl(), "/metrics/diagnostics", counts);
            } catch { }
        }, 250);
    };

    context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(pushDiagnostics));
    pushDiagnostics();

    const cmd = (id: string, fn: () => Promise<void> | void) =>
        context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    cmd("speedrun.runStart", async () => {
        await requestJson(baseUrl(), "/run/start");
        vscode.window.setStatusBarMessage("Speedrun: RUNNING", 1200);
    });

    cmd("speedrun.runPause", async () => {
        await requestJson(baseUrl(), "/run/pause");
        vscode.window.setStatusBarMessage("Speedrun: PAUSED", 1200);
    });

    cmd("speedrun.runReset", async () => {
        await requestJson(baseUrl(), "/run/reset");
        vscode.window.setStatusBarMessage("Speedrun: RESET", 1200);
    });

    cmd("speedrun.runStop", async () => {
        await requestJson(baseUrl(), "/run/stop");
        vscode.window.setStatusBarMessage("Speedrun: STOPPED", 1200);
    });

    cmd("speedrun.split", async () => {
        const name = await vscode.window.showInputBox({
            title: "Split name",
            placeHolder: "[work] Auth Fix | [brainstorm] Idea | [chill] Cleanup | [debug] Fix crash"
        });
        if (!name) return;
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

export function deactivate() { }
