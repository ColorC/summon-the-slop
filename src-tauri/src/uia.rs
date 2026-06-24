//! UI Automation: the "computer inspector". Element under a point (hover/click)
//! and all elements inside a rectangle (box-select content list).
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use uiautomation::types::{Point, TreeScope};
use uiautomation::{UIAutomation, UIElement, UITreeWalker};

#[derive(Serialize, Clone)]
pub struct ElementInfo {
    pub name: String,
    pub control_type: String,
    pub class_name: String,
    pub automation_id: String,
    pub value: String,
    /// [left, top, right, bottom] in physical desktop coordinates.
    pub rect: [i32; 4],
    pub pid: i32,
}

fn value_of(e: &UIElement) -> String {
    use uiautomation::patterns::UIValuePattern;
    if let Ok(p) = e.get_pattern::<UIValuePattern>() {
        if let Ok(v) = p.get_value() {
            return v;
        }
    }
    String::new()
}

/// Lightweight info for the bulk snapshot: only the three fields hit-test + tooltip +
/// box-list need (bounds, name, control type). Skips classname/automation_id/value/pid,
/// which are ~4 extra cross-process UIA calls per element and only shown on click.
fn info_lite(e: &UIElement) -> ElementInfo {
    let rect = e
        .get_bounding_rectangle()
        .map(|r| [r.get_left(), r.get_top(), r.get_right(), r.get_bottom()])
        .unwrap_or([0, 0, 0, 0]);
    // Skip the name/type RPC for degenerate (occluded/offscreen) elements.
    if rect[2] <= rect[0] || rect[3] <= rect[1] {
        return ElementInfo { name: String::new(), control_type: String::new(), class_name: String::new(),
            automation_id: String::new(), value: String::new(), rect, pid: 0 };
    }
    ElementInfo {
        name: e.get_name().unwrap_or_default(),
        control_type: e.get_control_type().map(|c| format!("{:?}", c)).unwrap_or_default(),
        class_name: String::new(),
        automation_id: String::new(),
        value: String::new(),
        rect,
        pid: 0,
    }
}

fn info(e: &UIElement) -> ElementInfo {
    let rect = e
        .get_bounding_rectangle()
        .map(|r| [r.get_left(), r.get_top(), r.get_right(), r.get_bottom()])
        .unwrap_or([0, 0, 0, 0]);
    ElementInfo {
        name: e.get_name().unwrap_or_default(),
        control_type: e
            .get_control_type()
            .map(|c| format!("{:?}", c))
            .unwrap_or_default(),
        class_name: e.get_classname().unwrap_or_default(),
        automation_id: e.get_automation_id().unwrap_or_default(),
        value: value_of(e),
        rect,
        pid: e.get_process_id().unwrap_or(0) as i32,
    }
}

pub fn element_at(x: i32, y: i32) -> Result<ElementInfo, String> {
    let auto = UIAutomation::new().map_err(|e| e.to_string())?;
    let el = auto
        .element_from_point(Point::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(info(&el))
}

/// Reusable automation handle for the live inspector — build once, query many times,
/// so the per-cursor-move hover doesn't pay COM/CUIAutomation construction every call.
pub fn make_automation() -> Result<UIAutomation, String> {
    UIAutomation::new().map_err(|e| e.to_string())
}

pub fn element_at_with(auto: &UIAutomation, x: i32, y: i32) -> Result<ElementInfo, String> {
    let el = auto
        .element_from_point(Point::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(info(&el))
}

/// The UIA ancestry of the element under (x,y): (control_type, name) from the outermost
/// window down to the element — the native analogue of a web inspector's DOM/selector
/// path. Capped at 10 levels.
pub fn ancestry(auto: &UIAutomation, x: i32, y: i32) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let walker = match auto.get_control_view_walker() {
        Ok(w) => w,
        Err(_) => return out,
    };
    let mut cur = auto.element_from_point(Point::new(x, y)).ok();
    let mut depth = 0;
    while let Some(el) = cur {
        let ct = el.get_control_type().map(|c| format!("{:?}", c)).unwrap_or_default();
        let nm = el.get_name().unwrap_or_default();
        out.push((ct, nm));
        depth += 1;
        if depth >= 10 {
            break;
        }
        cur = walker.get_parent(&el).ok();
    }
    out.reverse(); // outermost (window) first → element last
    out
}

/// Walk every top-level window's UIA tree into a flat element list with bounds, SKIPPING the
/// given HWNDs (poof's own overlay windows). Used to resolve screenshot-annotation points to
/// "what UI element is here" WITHOUT element_from_point — the snap overlay sits on top, so a
/// hit-test would always return poof itself ("selecting self"). UIA tree enumeration is
/// occlusion-independent (covered windows still expose their tree), so this sees the real apps
/// underneath. Budget-limited (a single UIA call can block on a busy target).
pub fn elements_excluding(skip: &[isize], total: usize, budget_ms: u128) -> Vec<ElementInfo> {
    let out: Mutex<Vec<ElementInfo>> = Mutex::new(Vec::new());
    let auto = match UIAutomation::new() {
        Ok(a) => a,
        Err(_) => return Vec::new(),
    };
    let root = match auto.get_root_element() {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let walker = match auto.get_control_view_walker() {
        Ok(w) => w,
        Err(_) => return Vec::new(),
    };
    let start = Instant::now();
    let len = |o: &Mutex<Vec<ElementInfo>>| o.lock().map(|v| v.len()).unwrap_or(total);
    let mut win = walker.get_first_child(&root).ok();
    while let Some(w) = win {
        if len(&out) >= total || start.elapsed().as_millis() > budget_ms {
            break;
        }
        let hwnd: isize = w.get_native_window_handle().map(|h| h.into()).unwrap_or(0);
        if !skip.contains(&hwnd) {
            collect(&walker, &w, 0, &out, total, &start, budget_ms);
        }
        win = walker.get_next_sibling(&w).ok();
    }
    out.into_inner().unwrap_or_default()
}

/// Reuse an existing UIAutomation (for the live inspector's box-select, which already
/// holds one) to list named/valued elements intersecting a rect.
pub fn elements_in_rect_with(auto: &UIAutomation, l: i32, t: i32, r: i32, b: i32, max: usize) -> Vec<ElementInfo> {
    let (cx, cy) = ((l + r) / 2, (t + b) / 2);
    let container = match auto.element_from_point(Point::new(cx, cy)) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let cond = match auto.create_true_condition() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let all = match container.find_all(TreeScope::Subtree, &cond) {
        Ok(a) => a,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for e in all.iter() {
        if let Ok(rc) = e.get_bounding_rectangle() {
            let (el, et, er, eb) = (rc.get_left(), rc.get_top(), rc.get_right(), rc.get_bottom());
            if er > l && el < r && eb > t && et < b {
                let inf = info(e);
                if !inf.name.is_empty() || !inf.value.is_empty() {
                    out.push(inf);
                    if out.len() >= max {
                        break;
                    }
                }
            }
        }
    }
    out
}

pub fn elements_in_rect(
    l: i32,
    t: i32,
    r: i32,
    b: i32,
    max: usize,
) -> Result<Vec<ElementInfo>, String> {
    let auto = UIAutomation::new().map_err(|e| e.to_string())?;
    let (cx, cy) = ((l + r) / 2, (t + b) / 2);
    let container = auto
        .element_from_point(Point::new(cx, cy))
        .map_err(|e| e.to_string())?;
    let cond = auto.create_true_condition().map_err(|e| e.to_string())?;
    let all = container
        .find_all(TreeScope::Subtree, &cond)
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for e in all.iter() {
        if let Ok(rc) = e.get_bounding_rectangle() {
            let (el, et, er, eb) = (rc.get_left(), rc.get_top(), rc.get_right(), rc.get_bottom());
            // keep elements whose bounds intersect the selection rect
            if er > l && el < r && eb > t && et < b {
                let inf = info(e);
                if !inf.name.is_empty() || !inf.value.is_empty() {
                    out.push(inf);
                    if out.len() >= max {
                        break;
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Walk on-screen UIA element geometry at summon time into a shared buffer, skipping
/// our own overlay (by HWND). The frontend hit-tests against this list so hover/box
/// detection works though the overlay sits on top.
///
/// Writes incrementally into `out` (behind a Mutex) so the caller can read a PARTIAL
/// result if the walk overruns: a single UIA call blocks when a target app is busy and
/// can't be interrupted by the budget. `per_window` caps each top-level window so one
/// huge tree (Electron/Chromium apps expose enormous trees) can't starve the others.
pub fn walk(skip_hwnd: isize, per_window: usize, total: usize, budget_ms: u128, out: &Mutex<Vec<ElementInfo>>) {
    let auto = match UIAutomation::new() {
        Ok(a) => a,
        Err(_) => return,
    };
    let root = match auto.get_root_element() {
        Ok(r) => r,
        Err(_) => return,
    };
    let walker = match auto.get_control_view_walker() {
        Ok(w) => w,
        Err(_) => return,
    };
    let start = Instant::now();
    let len = |o: &Mutex<Vec<ElementInfo>>| o.lock().map(|v| v.len()).unwrap_or(total);

    let mut win = walker.get_first_child(&root).ok();
    while let Some(w) = win {
        if len(out) >= total || start.elapsed().as_millis() > budget_ms {
            break;
        }
        let hwnd: isize = w.get_native_window_handle().map(|h| h.into()).unwrap_or(0);
        if hwnd != skip_hwnd {
            let cap = (len(out) + per_window).min(total);
            collect(&walker, &w, 0, out, cap, &start, budget_ms);
        }
        win = walker.get_next_sibling(&w).ok();
    }
}

fn collect(walker: &UITreeWalker, el: &UIElement, depth: usize, out: &Mutex<Vec<ElementInfo>>,
           cap: usize, start: &Instant, budget_ms: u128) {
    let len = || out.lock().map(|v| v.len()).unwrap_or(cap);
    // Cap depth: useful hover targets (buttons, tabs, menu items, list rows) live near
    // the top; deep nodes are mostly text spans that cost RPC without being hoverable.
    if len() >= cap || depth > 9 || start.elapsed().as_millis() > budget_ms {
        return;
    }
    let inf = info_lite(el);
    if inf.rect[2] > inf.rect[0] && inf.rect[3] > inf.rect[1] {
        if let Ok(mut v) = out.lock() {
            v.push(inf);
        }
    }
    let mut child = walker.get_first_child(el).ok();
    while let Some(c) = child {
        if len() >= cap || start.elapsed().as_millis() > budget_ms {
            break;
        }
        collect(walker, &c, depth + 1, out, cap, start, budget_ms);
        child = walker.get_next_sibling(&c).ok();
    }
}
