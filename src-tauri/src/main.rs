// GUI subsystem ALWAYS (debug too), NOT just release. A console-subsystem debug build pops a
// console window; the user closes it mid-work → poof dies → `tauri dev` sees the app exit and the
// whole watch tears down → Rust stops auto-rebuilding. GUI subsystem = no console window ever, so
// nothing for the user to close. CLI flags (--bench-search / --test-capture) still print to a
// PIPED stdout (when launched from a shell that redirects), so their output is captured normally.
#![windows_subsystem = "windows"]

fn main() {
    poof_lib::run()
}
