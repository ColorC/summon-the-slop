# poof 剪贴板接口规范

> 蓝本 = PasteBar(已克隆到 `vendor/pastebar`,gitignore 不上传)。本文件 = poof 自己的剪贴板接口定义。
> **暂时仅做接口**:定义形态,不接进 poof 运行(符合需求)。
> ⚠ **PasteBar 是 Tauri 1.x,poof 是 Tauri 2** —— 后台捕获核心(`arboard` + `clipboard-master`)可直接移植;
> 但 clipboard / 全局快捷键的 Tauri API 在 v2 已变,需按 v2 适配。

## 存储(SQLite,2 张表起步)

`clipboard_history`(精简列即可起步):
`history_id TEXT PK(nanoid)`、`value TEXT`、`value_hash TEXT(SHA1,文本去重键,建索引)`、
`is_image BOOL`、`image_path_full_res TEXT`、`image_hash TEXT(感知哈希,图片去重键)`、
`is_pinned BOOL`、`is_favorite BOOL`、`copied_from_app TEXT`、`created_at/updated_at BIGINT(ms)`、`created_date/updated_date TIMESTAMP`
索引:`idx_value_hash`、`idx_image_hash`

`settings`:`name TEXT PK, value_text TEXT, value_bool BOOL, value_int INT` —— 至少放 `isHistoryEnabled`。

> PasteBar 还有 collections/items/tabs/link_metadata 等(固定收藏夹/看板功能),poof 只做"历史"可全跳过。

## 去重(照搬 PasteBar)

- 文本:`value_hash = SHA1(text)`;图片:`image_hash = 感知哈希`。各带索引。
- 插入前查最近 N 条同 hash,命中只 UPDATE 时间戳(并实现"双拷自动收藏")。
- 图片**不进 DB 正文**:落盘 `clipboard-images/`,DB 存 `{{base_folder}}/...` 相对路径占位 + 低分缩略 BLOB。

## 后台捕获(Tauri plugin,无 command)

`clipboard::init() -> TauriPlugin`,内挂 `clipboard-master` 监听 + `arboard` 读写。
`ClipboardManager` 原语:`read_text / write_text / read_image / write_image / read_image_binary`。
`on_clipboard_change`:读 `settings` 闸门(enabled/长度/排除清单)→ 落库 → `emit_all("clipboard://clipboard-monitor/update")` 通知前端刷新。

## 对外 Tauri command(~15,分两层:`commands/` 薄绑定 ↔ `services/` 厚 DB 逻辑)

写回系统剪贴板:`copy_text(text)` · `copy_paste(text, delay)` · `copy_history_item(history_id)`
读历史:`get_clipboard_history(limit, offset)` · `get_recent_clipboard_histories(limit)` · `get_clipboard_history_by_id(id)` · `count_clipboard_histories()` · `search_clipboard_histories_by_value_or_filters(query, filters)`
写/管理:`insert_clipboard_history(h)` · `update_clipboard_history_by_id(id, data)` · `delete_clipboard_history_by_ids(ids)` · `update_pinned_clipboard_history_by_ids(ids, is_pinned)` · `clear_clipboard_history_older_than(...)`
设置:`get_app_settings()` · `update_setting(setting)`

## 依赖(Cargo,按 Tauri v2 适配)

`arboard` · `clipboard-master` · `image` · `image_hasher` · `sha1` · `nanoid` · `diesel{sqlite,r2d2,chrono}` · `diesel_migrations` · `libsqlite3-sys{bundled}` · `r2d2` · `chrono` · `serde/serde_json`
Windows 额外:`clipboard-win`(PNG/DIB 安全取图) · `inputbot`(模拟 Ctrl+V 粘贴)

## 后续(非现在)

- 接 poof 笔记空间(BlockSuite 画布)+ 快速选中剪切。
- 与资源登记册(#3)解耦:剪贴板是 poof 自有能力,不进登记册真源。
