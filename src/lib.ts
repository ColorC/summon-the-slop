import { invoke } from "@tauri-apps/api/core";

export interface CmdOut {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run `cmd /C <cmd>` with no console window. */
export const runShell = (cmd: string) => invoke<CmdOut>("run_shell", { cmd });

/** Ask the user's own AI (Claude Code headless). */
export const askAi = (prompt: string) => invoke<string>("ask_ai", { prompt });

/** Copy text to the Windows clipboard. */
export const copyText = (text: string) => invoke<void>("copy_text", { text });

// ---- search ----
export interface SearchHit {
  kind: string; // "app" | "folder" | "exe" | "file"
  name: string;
  path: string;
  score: number;
  tags: string[]; // 文件标签
  pinned: boolean; // 用户置顶(override=Pin)
}
export const search = (query: string, limit = 30) =>
  invoke<SearchHit[]>("search", { query, limit });
export const openPath = (path: string) => invoke<void>("open_path", { path });

export const revealPath = (path: string) => invoke<void>("reveal_path", { path });
/** 聚焦匹配 query(项目名/cwd basename)的已开窗口(如 vscode), 并隐藏 poof。返回是否命中。 */
export const focusWindow = (query: string) => invoke<boolean>("focus_window", { query });

// ---- ranking overrides / important folders / 空 query 常用面板 (M3/M4/M5) ----
/** level: 2=置顶 Pin / -1=降权 Demote / -2=隐藏 Hide / 0=清除 */
export const setOverride = (path: string, level: number) =>
  invoke<void>("set_override", { path, level });
export const getOverride = (path: string) => invoke<number>("get_override", { path });
/** 列出所有纠偏项 [path, level]，level: 2=置顶 / -1=降权 / -2=隐藏。 */
export const listOverrides = () => invoke<[string, number][]>("list_overrides");
export const toggleImportantFolder = (path: string) =>
  invoke<boolean>("toggle_important_folder", { path });
export const isImportantFolder = (path: string) =>
  invoke<boolean>("is_important_folder", { path });
/** 空搜索框：置顶 + frecency 常用文件（零索引依赖，极快）。 */
export const recentTop = (limit = 12) => invoke<SearchHit[]>("recent_top", { limit });

// ---- 文件标签 (M6/M7) ----
export interface TagDef {
  name: string;
  color: string;
  group: string | null;
  pin: boolean;
  created: number;
}
export const tagAdd = (path: string, tag: string) =>
  invoke<string[]>("tag_add", { path, tag });
export const tagRemove = (path: string, tag: string) =>
  invoke<string[]>("tag_remove", { path, tag });
export const tagsFor = (path: string) => invoke<string[]>("tags_for", { path });
export const tagDefs = () => invoke<TagDef[]>("tag_defs");
export const tagFiles = (tag: string) => invoke<string[]>("tag_files", { tag });
export const tagSetDef = (
  name: string,
  opts: { color?: string; group?: string; pin?: boolean }
) =>
  invoke<void>("tag_set_def", {
    name,
    color: opts.color ?? null,
    group: opts.group ?? null,
    pin: opts.pin ?? null,
  });
export const tagRename = (oldName: string, newName: string) =>
  invoke<void>("tag_rename", { old: oldName, new: newName });
export const tagDelete = (name: string) => invoke<void>("tag_delete", { name });
export const tagOrphans = () => invoke<string[]>("tag_orphans");
export const tagReassign = (oldPath: string, newPath: string) =>
  invoke<void>("tag_reassign", { oldPath, newPath });
/** FileId 救援：扫孤儿，能解析到新位置的自动改打标签，返回 [旧, 新] 列表。 */
export const tagRescue = () => invoke<[string, string][]>("tag_rescue");

// ---- 笔记「活文件块」: 文本读/写回 + 二进制 base64(图片/PDF 预览) ----
export const readFileText = (path: string) => invoke<string>("read_file_text", { path });
export const writeFileText = (path: string, content: string) =>
  invoke<void>("write_file_text", { path, content });
export const readFileB64 = (path: string) => invoke<string>("read_file_b64", { path });

// ---- 笔记落盘存储(docs/<id>.ydoc + blobs/<sha>, 搬出 WebView2 IndexedDB)----
export const notesRoot = () => invoke<string>("notes_root");
export const notesDocGet = (id: string) => invoke<string | null>("notes_doc_get", { id });
export const notesDocPut = (id: string, b64: string) =>
  invoke<void>("notes_doc_put", { id, b64 });
export const notesDocDel = (id: string) => invoke<void>("notes_doc_del", { id });
export const notesDocKeys = () => invoke<string[]>("notes_doc_keys");
export const notesBlobGet = (key: string) => invoke<string | null>("notes_blob_get", { key });
export const notesBlobPut = (key: string, b64: string) =>
  invoke<void>("notes_blob_put", { key, b64 });
export const notesBlobDel = (key: string) => invoke<void>("notes_blob_del", { key });
export const notesBlobKeys = () => invoke<string[]>("notes_blob_keys");
// 导出物: <id>.md + index.json(给 omni/人读)
export const notesMdPut = (id: string, content: string) =>
  invoke<void>("notes_md_put", { id, content });
export const notesMdDel = (id: string) => invoke<void>("notes_md_del", { id });
export const notesIndexPut = (json: string) => invoke<void>("notes_index_put", { json });
// 版本历史落盘: versions/<docId>/<ts>.json
export const notesVersionPut = (docId: string, ts: string, json: string) =>
  invoke<void>("notes_version_put", { docId, ts, json });
export const notesVersionAll = (docId: string) =>
  invoke<{ ts: string; json: string }[]>("notes_version_all", { docId });
export const notesVersionDelOne = (docId: string, ts: string) =>
  invoke<void>("notes_version_del_one", { docId, ts });
export const notesVersionDelAll = (docId: string) =>
  invoke<void>("notes_version_del_all", { docId });
/** Capture a screen rect (client coords == screen coords; window is fullscreen) to a PNG, returns its path. */
export const snapshotRegion = (x: number, y: number, w: number, h: number) =>
  invoke<string>("snapshot_region", { x, y, w, h });
/** Native Windows Properties dialog (v1 of the standard shell menu). */
export const shellMenu = (path: string, _x?: number, _y?: number) =>
  invoke<void>("shell_props", { path });

// ---- pty (terminal) ----
export const ptySpawn = (id: string, cols: number, rows: number, cwd?: string) =>
  invoke<void>("pty_spawn", { id, cols, rows, cwd: cwd ?? null });
export const ptyWrite = (id: string, data: string) => invoke<void>("pty_write", { id, data });
export const ptyResize = (id: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { id, cols, rows });
export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });

/** Open a heavy surface (terminal/project/review) as its own normal window. */
export const openView = (view: string) => invoke<void>("open_view", { view });

/** Start a new AI chat (opens/focuses the terminal window; queues provider+query). */
export const newChat = (provider: string, query?: string) =>
  invoke<void>("new_chat", { provider, query: query ?? null });
export const takeChatIntents = () =>
  invoke<[string, string | null][]>("take_chat_intents");
