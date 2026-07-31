// overlay-shell 录像 — popup. Start/stop toggle + the one-time port/token config (token is read from
// %USERPROFILE%\.overlay-shell\rec_token by the user and pasted here; extensions can't read disk).
const $ = (id) => document.getElementById(id);
let recording = false;

function refresh() {
  chrome.runtime.sendMessage({ type: "STATUS" }, (r) => {
    recording = !!(r && r.recording);
    $("toggle").textContent = recording ? "停止并保存" : "开始录制";
  });
}

chrome.storage.local.get(["port", "token"], (c) => {
  $("port").value = c.port || 8732;
  $("token").value = c.token || "";
});

$("save").addEventListener("click", () => {
  chrome.storage.local.set(
    { port: parseInt($("port").value, 10) || 8732, token: $("token").value.trim() },
    () => { $("status").textContent = "设置已保存"; }
  );
});

$("toggle").addEventListener("click", () => {
  if (!recording) {
    chrome.runtime.sendMessage({ type: "START", title: $("title").value }, (r) => {
      $("status").textContent = r && r.ok ? "● 录制中" : "失败: " + (r && r.error);
      refresh();
    });
  } else {
    chrome.runtime.sendMessage({ type: "STOP" }, () => {
      $("status").textContent = "✓ 已停止并保存";
      refresh();
    });
  }
});

refresh();
