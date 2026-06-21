// poof 录像 — VSCode activity recorder (P3). rrweb can't reach VSCode's own UI / Simple
// Browser / other extensions' webviews, so instead of DOM we record the genuinely useful
// VSCode signal via the extension API: file open/edit/save, active-editor switches, terminal,
// debug — as schema envelopes (surface:"vscode") POSTed to poof's localhost collector (P2).
// The extension host is Node, so it can fetch localhost directly (no content-script limits).
// PRIVACY: edits record a per-file SUMMARY (counts + line deltas), never file content.
const vscode = require("vscode");
const http = require("http");

let session = null; // { sid, port, token, seq, buffer, timer, editTimer, editAgg, disposables, status }

function post(path, body, port, token) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length, Authorization: "Bearer " + token } },
      (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => resolve(b)); }
    );
    req.on("error", () => resolve(null));
    req.write(data);
    req.end();
  });
}

function emit(kind, p) {
  if (!session) return;
  session.buffer.push({ sid: session.sid, seq: session.seq++, ts: Date.now(), surface: "vscode", src: vscode.workspace.name || "vscode", kind, p });
  if (session.buffer.length >= 30) flush(); else schedule();
}
function flush() {
  if (!session || !session.buffer.length) return;
  const batch = session.buffer;
  session.buffer = [];
  post("/rec/event", { sid: session.sid, batch }, session.port, session.token);
}
function schedule() {
  if (!session || session.timer) return;
  session.timer = setTimeout(() => { session.timer = null; flush(); }, 500);
}

async function start() {
  if (session) { vscode.window.showInformationMessage("poof 已在录制"); return; }
  const cfg = vscode.workspace.getConfiguration("poof");
  const port = cfg.get("port", 8732);
  const token = cfg.get("token", "");
  if (!token) { vscode.window.showWarningMessage("先在设置里填 poof.token(见 %USERPROFILE%\\.poof\\rec_token)"); return; }
  const resp = await post("/rec/start", { title: "VSCode: " + (vscode.workspace.name || "无工作区"), surface: "vscode" }, port, token);
  let sid = null;
  try { sid = JSON.parse(resp).sid; } catch (e) {}
  if (!sid) { vscode.window.showErrorMessage("poof 收集口无响应(poof 在运行吗?)"); return; }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = "● poof 录制中";
  status.tooltip = "点击停止 poof 录制";
  status.command = "poof.stopRecording";
  status.show();

  const d = [];
  session = { sid, port, token, seq: 0, buffer: [], timer: null, editTimer: null, editAgg: new Map(), disposables: d, status };

  if (vscode.window.activeTextEditor) {
    emit("vscode.active", { path: vscode.window.activeTextEditor.document.fileName, lang: vscode.window.activeTextEditor.document.languageId });
  }
  d.push(vscode.window.onDidChangeActiveTextEditor((e) => { if (e) emit("vscode.active", { path: e.document.fileName, lang: e.document.languageId }); }));
  d.push(vscode.workspace.onDidOpenTextDocument((doc) => emit("vscode.open", { path: doc.fileName, lang: doc.languageId })));
  d.push(vscode.workspace.onDidSaveTextDocument((doc) => emit("vscode.save", { path: doc.fileName })));
  // edits: debounced per-file summary (counts + line deltas), NEVER content
  d.push(vscode.workspace.onDidChangeTextDocument((e) => {
    if (!session) return;
    const f = e.document.fileName;
    const a = session.editAgg.get(f) || { edits: 0, addedLines: 0, removedLines: 0 };
    for (const c of e.contentChanges) {
      a.edits++;
      a.addedLines += (c.text.match(/\n/g) || []).length;
      a.removedLines += c.range.end.line - c.range.start.line;
    }
    session.editAgg.set(f, a);
    if (!session.editTimer) {
      session.editTimer = setTimeout(() => {
        session.editTimer = null;
        for (const [path, agg] of session.editAgg) emit("vscode.edit", Object.assign({ path }, agg));
        session.editAgg.clear();
      }, 1500);
    }
  }));
  d.push(vscode.window.onDidOpenTerminal((t) => emit("vscode.terminal.open", { name: t.name })));
  d.push(vscode.debug.onDidStartDebugSession((s) => emit("vscode.debug.start", { name: s.name, type: s.type })));

  vscode.window.showInformationMessage("poof 录制开始(VSCode 活动)");
}

async function stop() {
  if (!session) return;
  const s = session;
  session = null;
  for (const d of s.disposables) { try { d.dispose(); } catch (e) {} }
  if (s.timer) clearTimeout(s.timer);
  if (s.editTimer) clearTimeout(s.editTimer);
  // drain any aggregated edits + the buffer, then close the session
  for (const [path, agg] of s.editAgg) s.buffer.push({ sid: s.sid, seq: s.seq++, ts: Date.now(), surface: "vscode", src: vscode.workspace.name || "vscode", kind: "vscode.edit", p: Object.assign({ path }, agg) });
  if (s.buffer.length) await post("/rec/event", { sid: s.sid, batch: s.buffer }, s.port, s.token);
  await post("/rec/stop", { sid: s.sid }, s.port, s.token);
  try { s.status.dispose(); } catch (e) {}
  vscode.window.showInformationMessage("poof 录制已保存");
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("poof.startRecording", start));
  context.subscriptions.push(vscode.commands.registerCommand("poof.stopRecording", stop));
}
function deactivate() { if (session) return stop(); }
module.exports = { activate, deactivate };
