// poof 录像 — page MAIN-world injector (loaded via web_accessible_resource <script>).
// rrweb + recorder-core are already loaded (the content script injects them in order before
// this). Listens for REC_START/REC_STOP from the isolated world (window.postMessage) and runs
// the recorder; ships each batch back to the isolated world via postMessage (it does the
// localhost fetch — the page's CSP can't block that). The page never touches localhost.
(function () {
  var rec = null;

  function send(batch) {
    window.postMessage({ __poof: true, type: "REC_BATCH", batch: batch }, "*");
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__poof !== true) return;
    if (d.type === "REC_START") {
      if (rec) return; // already recording
      if (!window.rrweb || !window.rrweb.record || !window.__poofRecorder) {
        window.postMessage({ __poof: true, type: "REC_ERR", msg: "rrweb not loaded in page" }, "*");
        return;
      }
      rec = window.__poofRecorder.startRecorder({ sid: d.sid, surface: "chrome", src: location.href, send: send });
      window.postMessage({ __poof: true, type: "REC_READY" }, "*");
    } else if (d.type === "REC_STOP") {
      if (!rec) return;
      var r = rec;
      rec = null;
      r.stop();
      r.flush().then(function () {
        window.postMessage({ __poof: true, type: "REC_STOPPED" }, "*");
      });
    }
  });
})();
