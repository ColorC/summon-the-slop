// overlay-shell 录像 — MV3 service worker. It owns ALL collector HTTP (a content-script fetch loses
// the cross-origin privilege in MV3 — only the SW keeps host_permissions cross-origin access,
// verified: SW fetch to 127.0.0.1 → 200, page fetch → blocked). The content script just
// relays page-world rrweb batches here; the page world owns rrweb; the SW owns the wire.
const Rec = {
  S: null, // { sid, tabId, port, token }
  api(path, body) {
    return fetch("http://127.0.0.1:" + this.S.port + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + this.S.token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  async start(tabId, title, port, token) {
    this.S = { sid: null, tabId, port, token };
    const j = await (await this.api("/rec/start", { title: title || "", surface: "chrome" })).json();
    this.S.sid = j.sid;
    await chrome.tabs.sendMessage(tabId, { type: "REC_START", sid: j.sid }); // inject + start rrweb
    return j.sid;
  },
  event(batch) {
    if (this.S && this.S.sid) this.api("/rec/event", { sid: this.S.sid, batch }).catch(() => {});
  },
  async stop() {
    if (!this.S) return;
    const { sid, tabId, port, token } = this.S; // capture BEFORE nulling (the setTimeout below
    this.S = null;                              // must not read this.S — it's gone by then)
    try { await chrome.tabs.sendMessage(tabId, { type: "REC_STOP" }); } catch (e) {}
    // let the final flush relay through before stamping stop_ms
    setTimeout(() => {
      fetch("http://127.0.0.1:" + port + "/rec/stop", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ sid }),
      }).catch(() => {});
    }, 500);
  },
};
self.__overlayShellRec = Rec; // exposed on the SW global for tests/introspection (not reachable from web pages)

// 统一捕获 · 通用 DOM 元素上报: content-script 报"光标下元素", SW 转发到 overlay-shell(content-script 不能跨源 fetch)。
let _cfg = null;
function withCfg(cb) {
  if (_cfg) return cb(_cfg);
  chrome.storage.local.get(["port", "token"], (c) => {
    _cfg = { port: c.port || 8732, token: c.token || "" };
    cb(_cfg);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "ELEMENT") {
    withCfg((c) => {
      fetch("http://127.0.0.1:" + c.port + "/element", {
        method: "POST",
        headers: { Authorization: "Bearer " + c.token, "Content-Type": "application/json" },
        body: JSON.stringify(msg.data),
      }).catch(() => {});
    });
    return;
  }
  if (msg.type === "START") {
    chrome.storage.local.get(["port", "token"], (cfg) => {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab) { reply({ ok: false, error: "no active tab" }); return; }
        try {
          const sid = await Rec.start(tab.id, msg.title, cfg.port || 8732, cfg.token || "");
          reply({ ok: true, sid });
        } catch (e) {
          Rec.S = null;
          reply({ ok: false, error: String(e) });
        }
      });
    });
    return true;
  }
  if (msg.type === "BATCH") { Rec.event(msg.batch); return; }
  if (msg.type === "STOP") { Rec.stop().then(() => reply({ ok: true })); return true; }
  if (msg.type === "STATUS") { reply({ recording: !!Rec.S }); }
  if (msg.type === "REC_ERR") { chrome.action.setBadgeText({ text: "!" }); }
});

chrome.tabs.onRemoved.addListener((tabId) => { if (Rec.S && Rec.S.tabId === tabId) Rec.stop(); });
