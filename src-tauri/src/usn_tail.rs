// 全盘实时新鲜度 —— NTFS USN Journal 增量监听(Everything/Listary 同款技术, mft.rs 全量枚举的姊妹
// 调用)。overlay-shell.exe --usn-daemon <主进程PID> 常驻运行: 每个固定盘一个线程, 开卷后先取
// journal 基线、再做一次 mft::scan 常驻表, 随后持续 FSCTL_READ_USN_JOURNAL 拉增量, 增量维护这份表、
// 算出受影响的完整路径, 批量 POST 给主进程(http_rec.rs 的 /usn/batch, 走它已有的 loopback+token)。
//
// 常驻表是纯内存的(不落盘), 所以任何重启(崩溃/被杀)都得重新 mft::scan 一遍 —— 既然重扫躲不掉,
// 干脆不做跨重启的 journal 断点续传: 每次都是"取新基线→重扫→从新基线往后 tail", 简单且天然不漏
// (扫描期间发生的变更最坏是被扫描快照和 tail 重放各碰一次, insert_path/rename_path 都是幂等的)。
//
// 只覆盖白名单目录之外的部分(watch_roots 已经在实时监听的地方, 这里重复推送也无妨, 幂等)。
// 提权失败/被 EDR 拦卷时, run_drive 里的重试循环会不断退避重试, 主进程一侧的旧机制(每 2 小时一次性
// 全量重建 + notify 白名单监听)原样保留, 不因这个daemon 拉不起来而退化。
#![cfg(windows)]

use crate::mft::{self, Nodes, MASK};
use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::read_unaligned;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Ioctl::{
    FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_USN_JOURNAL, READ_USN_JOURNAL_DATA_V0, USN_JOURNAL_DATA_V0,
    USN_RECORD_V2, USN_REASON_CLOSE, USN_REASON_FILE_DELETE, USN_REASON_RENAME_NEW_NAME,
    USN_REASON_RENAME_OLD_NAME,
};
use windows::Win32::System::IO::DeviceIoControl;
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const STILL_ACTIVE: u32 = 259;
const BATCH_INTERVAL: Duration = Duration::from_millis(500);
const PUSH_BACKOFF_MAX_SECS: u64 = 60;

// One reusable HTTP pool per drive thread. Building an Agent for every 500 ms
// batch disables keep-alive and left hundreds of loopback sockets in TIME_WAIT.
thread_local! {
    static PUSH_AGENT: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(800))
        .timeout_read(Duration::from_millis(2000))
        .build();
}

static PUSH_FAILURES: AtomicU32 = AtomicU32::new(0);
static PUSH_RETRY_AFTER_MS: AtomicU64 = AtomicU64::new(0);
static PUSH_LAST_ERROR_LOG_MS: AtomicU64 = AtomicU64::new(0);

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn push_backoff_secs(failures: u32) -> u64 {
    (1u64 << failures.saturating_sub(1).min(6)).min(PUSH_BACKOFF_MAX_SECS)
}

// 推给 /usn/batch 的一条变更, 序列化后要和 search.rs 的 UsnOp(内部标签 "op") 对得上。
#[derive(serde::Serialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Op {
    Upsert { path: String, dir: bool },
    Delete { path: String },
    Rename { old: String, new: String, dir: bool },
}

/// --usn-daemon <主进程PID> 入口。每个固定盘一个 tail 线程 + 一个主进程存活轮询线程; 阻塞到进程该
/// 退出为止(主进程消失时直接 std::process::exit, 避免留一个孤儿提权进程常驻)。
pub fn run(main_pid: u32) {
    crate::search::ilog(&format!("[usn] daemon 启动, 监视主进程 pid={main_pid}"));
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        if !process_alive(main_pid) {
            crate::search::ilog("[usn] 主进程已退出, daemon 跟着退出");
            std::process::exit(0);
        }
    });
    let mut handles = Vec::new();
    for root in crate::search::fixed_drive_roots() {
        let Some(letter) = root.to_str().and_then(|s| s.chars().next()) else {
            continue;
        };
        handles.push(std::thread::spawn(move || run_drive(letter)));
    }
    for h in handles {
        let _ = h.join();
    }
}

fn process_alive(pid: u32) -> bool {
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code);
        let _ = CloseHandle(h);
        ok.is_ok() && code == STILL_ACTIVE
    }
}

// 单盘常驻: 出错(卷句柄失效/journal 被删或重置/DeviceIoControl 失败)就整套重来 —— 重开卷、取新
// journal 基线、重扫常驻表, 而不是折腾"能不能续上旧断点"(反正常驻表是内存态, 重启就得重扫)。
fn run_drive(letter: char) {
    loop {
        if let Err(e) = drive_once(letter) {
            crate::search::ilog(&format!("[usn] {letter}: {e}, 5s 后重试"));
        }
        std::thread::sleep(Duration::from_secs(5));
    }
}

fn drive_once(letter: char) -> Result<(), String> {
    let handle = mft::open_volume(letter).ok_or_else(|| "无法打开卷(非提权/EDR 拦卷)".to_string())?;
    let result = (|| -> Result<(), String> {
        // 先取 journal 基线再扫盘: 扫描期间发生的变更最坏是被"扫描快照"和"tail 重放"各碰一次,
        // insert_path/rename_path 都幂等, 不会因为顺序反过来漏掉扫描期间的变更。
        let (journal_id, start_usn) = query_journal(handle)?;
        let t = Instant::now();
        let mut nodes: Nodes = mft::scan(handle).ok_or_else(|| "MFT 扫描空结果(FSCTL 不支持)".to_string())?;
        crate::search::ilog(&format!(
            "[usn] {}: 常驻表就绪 {} 节点, {:?}",
            letter,
            nodes.len(),
            t.elapsed()
        ));
        tail(handle, letter, journal_id, start_usn, &mut nodes)
    })();
    unsafe {
        let _ = CloseHandle(handle);
    }
    result
}

fn query_journal(handle: HANDLE) -> Result<(u64, i64), String> {
    let mut data = USN_JOURNAL_DATA_V0::default();
    let mut bytes = 0u32;
    let ok = unsafe {
        DeviceIoControl(
            handle,
            FSCTL_QUERY_USN_JOURNAL,
            None,
            0,
            Some(&mut data as *mut _ as *mut c_void),
            std::mem::size_of::<USN_JOURNAL_DATA_V0>() as u32,
            Some(&mut bytes),
            None,
        )
    };
    if ok.is_err() {
        return Err("FSCTL_QUERY_USN_JOURNAL 失败(journal 未启用/不支持)".to_string());
    }
    Ok((data.UsnJournalID, data.NextUsn))
}

// 阻塞 tail: FSCTL_READ_USN_JOURNAL 用 Timeout+BytesToWaitFor 让内核帮忙等, 没有变更时不忙轮询,
// 有变更立刻返回。攒够 BATCH_INTERVAL 就 POST 一次给主进程。
fn tail(handle: HANDLE, letter: char, journal_id: u64, mut start_usn: i64, nodes: &mut Nodes) -> Result<(), String> {
    let mut pending_renames: HashMap<u64, String> = HashMap::new();
    let mut batch: Vec<Op> = Vec::new();
    let mut last_flush = Instant::now();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let rjd = READ_USN_JOURNAL_DATA_V0 {
            StartUsn: start_usn,
            ReasonMask: u32::MAX,
            ReturnOnlyOnClose: 0,
            Timeout: 2, // 秒: 没变更时内核帮忙等 2s 再返回一个空结果, 借这个节拍顺手 flush 攒的批次
            BytesToWaitFor: 1,
            UsnJournalID: journal_id,
        };
        let mut bytes: u32 = 0;
        let ok = unsafe {
            DeviceIoControl(
                handle,
                FSCTL_READ_USN_JOURNAL,
                Some(&rjd as *const _ as *const c_void),
                std::mem::size_of::<READ_USN_JOURNAL_DATA_V0>() as u32,
                Some(buf.as_mut_ptr() as *mut c_void),
                buf.len() as u32,
                Some(&mut bytes),
                None,
            )
        };
        if ok.is_err() {
            return Err("FSCTL_READ_USN_JOURNAL 失败(journal 被重置/卷句柄失效)".to_string());
        }
        if bytes >= 8 {
            let next = i64::from_ne_bytes(buf[0..8].try_into().unwrap());
            let limit = bytes as usize;
            let mut off = 8usize;
            while off + 60 <= limit {
                let rl = u32::from_ne_bytes(buf[off..off + 4].try_into().unwrap()) as usize;
                if rl < 60 || off + rl > limit {
                    break;
                }
                let rec = unsafe { read_unaligned(buf.as_ptr().add(off) as *const USN_RECORD_V2) };
                let no = rec.FileNameOffset as usize;
                let nl = rec.FileNameLength as usize / 2;
                if off + no + nl * 2 <= off + rl {
                    let name = unsafe {
                        let p = buf.as_ptr().add(off + no) as *const u16;
                        String::from_utf16_lossy(std::slice::from_raw_parts(p, nl))
                    };
                    apply_record(
                        letter,
                        rec.FileReferenceNumber & MASK,
                        rec.ParentFileReferenceNumber & MASK,
                        rec.Reason,
                        rec.FileAttributes,
                        name,
                        nodes,
                        &mut pending_renames,
                        &mut batch,
                    );
                }
                off += rl;
            }
            start_usn = next;
        }
        if !batch.is_empty() && last_flush.elapsed() >= BATCH_INTERVAL {
            flush(&mut batch);
            last_flush = Instant::now();
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn apply_record(
    letter: char,
    frn: u64,
    parent_frn: u64,
    reason: u32,
    attrs: u32,
    name: String,
    nodes: &mut Nodes,
    pending_renames: &mut HashMap<u64, String>,
    batch: &mut Vec<Op>,
) {
    let is_dir = attrs & FILE_ATTRIBUTE_DIRECTORY != 0;
    if reason & USN_REASON_FILE_DELETE != 0 {
        if let Some(old) = mft::build_path(frn, nodes, letter) {
            batch.push(Op::Delete { path: old });
        }
        nodes.remove(&frn);
        pending_renames.remove(&frn);
        return;
    }
    if reason & USN_REASON_RENAME_OLD_NAME != 0 {
        // 改名前的路径必须现在就算 —— 下一条 NEW_NAME 记录一到, 表里存的就是新名/新父了。
        if let Some(old) = mft::build_path(frn, nodes, letter) {
            pending_renames.insert(frn, old);
        }
        return;
    }
    if reason & USN_REASON_RENAME_NEW_NAME != 0 {
        nodes.insert(frn, (name, parent_frn, is_dir));
        if let Some(new) = mft::build_path(frn, nodes, letter) {
            match pending_renames.remove(&frn) {
                Some(old) if old != new => batch.push(Op::Rename { old, new, dir: is_dir }),
                _ => batch.push(Op::Upsert { path: new, dir: is_dir }),
            }
        }
        return;
    }
    // 普通创建/写入: 等 CLOSE 落地才当数(reason 是这次打开-关闭期间累积的位或, 常见的"建了就关"
    // 一步到位就已经带着 CLOSE; 只在文件还开着连续写的中间状态跳过, 避免反复 upsert 抖动)。
    if reason & USN_REASON_CLOSE != 0 {
        nodes.insert(frn, (name, parent_frn, is_dir));
        if let Some(path) = mft::build_path(frn, nodes, letter) {
            batch.push(Op::Upsert { path, dir: is_dir });
        }
    }
}

fn flush(batch: &mut Vec<Op>) {
    if batch.is_empty() {
        return;
    }
    let now_ms = unix_millis();
    if now_ms < PUSH_RETRY_AFTER_MS.load(Ordering::Relaxed) {
        // The periodic full rebuild is the recovery path. Do not retain an
        // unbounded change backlog while the collector is unavailable.
        batch.clear();
        return;
    }
    let ops = std::mem::take(batch);
    let n = ops.len();
    let Some(token) = read_token() else {
        crate::search::ilog("[usn] 找不到 rec_token, 丢弃这批变更(靠周期全量重建自愈)");
        return;
    };
    let body = match serde_json::to_string(&ops) {
        Ok(s) => s,
        Err(_) => return,
    };
    let result = PUSH_AGENT.with(|agent| {
        agent
            .post("http://127.0.0.1:8732/usn/batch")
            .set("Content-Type", "application/json")
            .set("Authorization", &format!("Bearer {token}"))
            .send_string(&body)
    });
    if let Err(e) = result {
        let failures = PUSH_FAILURES.fetch_add(1, Ordering::Relaxed) + 1;
        let retry_secs = push_backoff_secs(failures);
        PUSH_RETRY_AFTER_MS.store(now_ms + retry_secs * 1000, Ordering::Relaxed);

        let last_log = PUSH_LAST_ERROR_LOG_MS.load(Ordering::Relaxed);
        if last_log == 0 || now_ms.saturating_sub(last_log) >= 30_000 {
            PUSH_LAST_ERROR_LOG_MS.store(now_ms, Ordering::Relaxed);
            crate::search::ilog(&format!(
                "[usn] 推送 {n} 条变更失败: {e}; {retry_secs}s 后重试(期间合并批次)"
            ));
        }
    } else {
        PUSH_FAILURES.store(0, Ordering::Relaxed);
        PUSH_RETRY_AFTER_MS.store(0, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::push_backoff_secs;

    #[test]
    fn push_failures_back_off_and_cap() {
        assert_eq!(push_backoff_secs(1), 1);
        assert_eq!(push_backoff_secs(2), 2);
        assert_eq!(push_backoff_secs(7), 60);
        assert_eq!(push_backoff_secs(99), 60);
    }
}

// 和 http_rec.rs 的 token() 读同一份文件(同用户下不同提权等级都能读, 鉴权边界不变); 只读不生成 ——
// 生成交给主进程的 http server, 这里只是启动时和它有一点先后竞态, 短暂重试等它写好。
fn read_token() -> Option<String> {
    let p = std::path::Path::new(&std::env::var("USERPROFILE").ok()?)
        .join(".overlay-shell")
        .join("rec_token");
    for _ in 0..10 {
        if let Ok(t) = std::fs::read_to_string(&p) {
            let t = t.trim().to_string();
            if !t.is_empty() {
                return Some(t);
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    None
}
