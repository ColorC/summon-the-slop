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

  // ── 统一捕获 · 通用 DOM 元素解析 ─────────────────────────────────────
  // 持续上报"光标下元素"给 poof(经 SW),让 poof 不靠埋点也能知道任意网页上你指的是哪个元素。
  // 关键元素若埋了 data-omni-uri, 顺带带上语义。content-script 在 isolated world 但共享 DOM, 能读元素。
  function cssPath(el) {
    var parts = [];
    var cur = el;
    for (var d = 0; cur && cur.nodeType === 1 && d < 5; d++) {
      var seg = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(seg + "#" + cur.id); break; }
      if (typeof cur.className === "string" && cur.className.trim()) {
        seg += "." + cur.className.trim().split(/\s+/).slice(0, 2).join(".");
      }
      parts.unshift(seg);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }
  function elementInfo(el, cx, cy) {
    var r = el.getBoundingClientRect();
    var sem = el.closest ? el.closest("[data-omni-uri]") : null;
    return {
      url: location.href, title: document.title,
      tag: el.tagName ? el.tagName.toLowerCase() : "",
      id: el.id || "",
      cls: (typeof el.className === "string" ? el.className : "").slice(0, 200),
      text: (el.innerText || el.textContent || "").trim().slice(0, 240),
      selector: cssPath(el),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      dpr: window.devicePixelRatio || 1,
      omni_uri: sem ? (sem.getAttribute("data-omni-uri") || "") : "",
      omni_kind: sem ? (sem.getAttribute("data-omni-kind") || "") : "",
      omni_title: sem ? (sem.getAttribute("data-omni-title") || "") : "",
      cx: cx, cy: cy,
    };
  }
  var _lastReport = 0;
  window.addEventListener("mousemove", function (e) {
    var now = Date.now();
    if (now - _lastReport < 120) return; // 节流
    _lastReport = now;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    try { chrome.runtime.sendMessage({ type: "ELEMENT", data: elementInfo(el, e.clientX, e.clientY) }); } catch (x) {}
  }, true);
  // 点查询(poof 给视口坐标 → elementFromPoint → 应答): 供冻屏截图按选区取元素。
  chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
    if (msg && msg.type === "ELEMENT_AT") {
      var el = document.elementFromPoint(msg.x, msg.y);
      reply(el ? elementInfo(el, msg.x, msg.y) : null);
      return true;
    }
  });

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
