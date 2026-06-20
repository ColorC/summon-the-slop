//! Screen capture via xcap. Returns RAW RGBA bytes (no PNG encode, no base64) so the
//! summon path skips a ~400ms PNG compression plus a webview image-decode — the
//! frontend putImageData's the bytes straight onto the canvas. v1 is the primary
//! monitor; multi-monitor compositing is a follow-up.

/// (rgba8, width, height, monitor_x, monitor_y, scale_factor)
pub fn capture_primary_raw() -> Result<(Vec<u8>, u32, u32, i32, i32, f32), String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("no monitor found".into());
    }
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .cloned()
        .unwrap_or_else(|| monitors[0].clone());

    let img = monitor.capture_image().map_err(|e| e.to_string())?;
    let (width, height) = (img.width(), img.height());
    Ok((
        img.into_raw(),
        width,
        height,
        monitor.x().unwrap_or(0),
        monitor.y().unwrap_or(0),
        monitor.scale_factor().unwrap_or(1.0),
    ))
}
