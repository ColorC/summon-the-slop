// poof 录像 — isolated-world content script (document_start, every page). It does NOT fetch
// (MV3 strips content-script cross-origin access). It (1) relays page-world rrweb batches to
// the service worker (which does the localhost fetch), (2) injects rrweb + recorder-core +
// page-injector into the page main world on REC_START, (3) relays SW start/stop into the page.
// The window-message listener is set up FIRST so no early page-world batch is lost.
(function () {
  // page main world -> service worker
  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__poof !== true) return;
    if (d.type === "REC_BATCH") {
      try { chrome.runtime.sendMessage({ type: "BATCH", batch: d.batch }); } catch (x) {}
    } else if (d.type === "REC_ERR") {
      try { chrome.runtime.sendMessage({ type: "REC_ERR", msg: d.msg }); } catch (x) {}
    }
  });

  function inject(file) {
    return new Promise(function (res) {
      var s = document.createElement("script");
      s.src = chrome.runtime.getURL(file);
      s.onload = function () { s.remove(); res(); };
      s.onerror = function () { res(); };
      (document.head || document.documentElement).appendChild(s);
    });
  }
  var injected = false;
  async function ensureInjected() {
    if (injected) return;
    injected = true;
    await inject("vendor/rrweb.umd.js");
    await inject("src/recorder-core.js");
    await inject("src/page-injector.js");
  }

  // service worker -> page main world
  chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
    if (msg.type === "REC_START") {
      ensureInjected().then(function () {
        window.postMessage({ __poof: true, type: "REC_START", sid: msg.sid }, "*");
        reply({ ok: true });
      });
      return true; // async reply
    }
    if (msg.type === "REC_STOP") {
      window.postMessage({ __poof: true, type: "REC_STOP" }, "*");
      reply({ ok: true });
    }
  });
})();
