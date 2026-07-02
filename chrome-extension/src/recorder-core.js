// poof 录像 — shared recorder core (page main world). Produces the same schema envelope as
// poof's other recording surfaces. Transport is injected as `send(batch)`. Redaction runs
// HERE (page world, where rrweb lives) so secrets are masked BEFORE they ever cross the
// bridge or hit the wire.
// MUST stay in sync with the canonical envelope/kind definition in
// src-tauri/src/record_cmd.rs (top-of-file doc comment) — the masking is load-bearing.
(function () {
  function maskInput(text, el) {
    var type = (el && el.getAttribute && el.getAttribute("type")) || "";
    if (type === "password") return "*".repeat(text.length);
    var hay = "";
    try {
      if (el && el.attributes) {
        for (var i = 0; i < el.attributes.length; i++) {
          var a = el.attributes[i];
          hay += " " + a.name + "=" + a.value;
        }
      }
      if (el && el.className) hay += " " + el.className;
    } catch (e) {}
    if (/secret|password|token|api.?key|auth|credential|otp|cvv|card|私钥|密码|密钥/i.test(hay)) {
      return String(text.length); // schema: 键入默认只记字数
    }
    return text;
  }

  // returns { stop(), flush() }; send(batch) is the transport (e.g. postMessage -> fetch)
  function startRecorder(o) {
    var seq = o.startSeq || 0;
    var buffer = [];
    var timer = null;
    var inflight = Promise.resolve();

    function flush() {
      if (!buffer.length) return inflight;
      var batch = buffer;
      buffer = [];
      inflight = inflight
        .then(function () { return o.send(batch); })
        .catch(function () {}); // never let one failed batch wedge the chain
      return inflight;
    }
    function schedule() {
      if (timer != null) return;
      timer = setTimeout(function () { timer = null; flush(); }, 250);
    }

    var stopFn = window.rrweb.record({
      emit: function (ev) {
        buffer.push({ sid: o.sid, seq: seq++, ts: Date.now(), surface: o.surface, src: o.src, kind: "rrweb", p: { ev: ev } });
        if (buffer.length >= 50) flush(); else schedule();
      },
      maskAllInputs: true, // so maskInputFn runs on EVERY input (rrweb 2.x passes the element)
      maskInputOptions: { password: true },
      maskTextClass: "rr-mask",
      blockClass: "rr-block",
      maskInputFn: maskInput,
      checkoutEveryNth: 100,
    });

    return {
      stop: function () {
        try { if (stopFn) stopFn(); } catch (e) {}
        if (timer != null) { clearTimeout(timer); timer = null; }
      },
      flush: function () { return flush().then(function () { return inflight; }); },
    };
  }

  window.__poofRecorder = { maskInput: maskInput, startRecorder: startRecorder };
})();
