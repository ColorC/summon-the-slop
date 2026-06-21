// Multi-tab PTY terminal backend (ConPTY on Windows via portable-pty).
// Each tab = one PtySession keyed by a frontend-supplied id. Output streams to
// the frontend as `pty:data:<id>` events; xterm.js renders it.
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

/// Spawn a shell in a PTY tab. Startup commands (e.g. launching claude/codex) are
/// sent by the FRONTEND via pty_write once the shell is up — writing them here races
/// the shell's stdin and gets lost.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<PtyState>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty (ConPTY) failed — EDR may block: {e}"))?;

    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.args(["-NoLogo"]);
    // cwd: 优先用调用方给的工作目录(工作 agent 进对应项目主文件夹, 别把脏文件落在用户 home);
    // 给的目录不存在或没给 → 退回 USERPROFILE。
    let dir = cwd
        .filter(|d| !d.is_empty() && std::path::Path::new(d).is_dir())
        .or_else(|| std::env::var("USERPROFILE").ok());
    if let Some(d) = dir {
        cmd.cwd(d);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn powershell in PTY failed — EDR may block conhost: {e}"))?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let idc = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit(&format!("pty:data:{idc}"), chunk);
                }
                Err(_) => break,
            }
        }
        let _ = app.emit(&format!("pty:exit:{idc}"), ());
    });

    state.sessions.lock().unwrap().insert(
        id,
        PtySession { writer, master: pair.master, child },
    );
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get_mut(&id) {
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        let _ = s.writer.flush();
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(state: State<PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get(&id) {
        s.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: State<PtyState>, id: String) -> Result<(), String> {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}
