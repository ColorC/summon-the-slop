// NTFS whole-disk enumeration via the Master File Table — the technique Everything / SwiftSearch
// use. We open the raw volume (\\.\C:) and call FSCTL_ENUM_USN_DATA, which streams a USN_RECORD
// for every file & directory on the volume in seconds (millions of entries), each carrying its
// own file-reference-number (FRN) + parent FRN + name + attributes. We reconstruct full paths by
// walking the parent-FRN chains. No directory walk, no content — just names+paths, returned in the
// SAME (name, path, is_dir) shape the walker produces so it drops straight into the search index.
//
// Opening \\.\C: needs admin (volume read). If it fails (not elevated / not NTFS / removable),
// enumerate_volume returns None and the caller falls back to the throttled directory walk.
#![cfg(windows)]
use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::read_unaligned;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};
use windows::Win32::System::Ioctl::{FSCTL_ENUM_USN_DATA, MFT_ENUM_DATA_V0, USN_RECORD_V2};
use windows::Win32::System::IO::DeviceIoControl;

const ROOT_RECORD: u64 = 5; // NTFS root directory is MFT record #5
const MASK: u64 = 0x0000_FFFF_FFFF_FFFF; // low 48 bits of an FRN = the MFT record number
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;

fn open_volume(letter: char) -> Option<HANDLE> {
    let wide: Vec<u16> = format!("\\\\.\\{}:", letter)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_GENERIC_READ.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
        .ok()
    }
}

// node = (name, parent_record, is_dir), keyed by this entry's MFT record number.
type Nodes = HashMap<u64, (String, u64, bool)>;

// full path of a record by walking its parent chain up to the volume root.
fn build_path(start: u64, nodes: &Nodes, letter: char) -> Option<String> {
    let mut names: Vec<&str> = Vec::new();
    let mut cur = start;
    let mut depth = 0;
    while cur != ROOT_RECORD {
        let n = nodes.get(&cur)?; // parent missing → orphan chain, skip this entry
        names.push(n.0.as_str());
        cur = n.1;
        depth += 1;
        if depth > 255 {
            break; // cycle guard
        }
    }
    let mut path = String::with_capacity(80);
    path.push(letter);
    path.push(':');
    for nm in names.iter().rev() {
        path.push('\\');
        path.push_str(nm);
    }
    Some(path)
}

/// Enumerate every file+dir on a drive via the MFT. None = couldn't (not elevated / not NTFS).
pub fn enumerate_volume(letter: char) -> Option<Vec<(String, String, bool)>> {
    let handle = open_volume(letter)?;
    let result = enumerate(handle, letter);
    unsafe {
        let _ = CloseHandle(handle);
    }
    result
}

fn enumerate(handle: HANDLE, letter: char) -> Option<Vec<(String, String, bool)>> {
    let mut med = MFT_ENUM_DATA_V0 {
        StartFileReferenceNumber: 0,
        LowUsn: 0,
        HighUsn: i64::MAX,
    };
    let mut buf = vec![0u8; 256 * 1024];
    let mut nodes: Nodes = HashMap::new();
    let mut any = false;

    loop {
        let mut bytes: u32 = 0;
        let ok = unsafe {
            DeviceIoControl(
                handle,
                FSCTL_ENUM_USN_DATA,
                Some(&med as *const _ as *const c_void),
                std::mem::size_of::<MFT_ENUM_DATA_V0>() as u32,
                Some(buf.as_mut_ptr() as *mut c_void),
                buf.len() as u32,
                Some(&mut bytes),
                None,
            )
        };
        // first call must succeed; ERROR_HANDLE_EOF (Err) afterwards = done
        if ok.is_err() || bytes <= 8 {
            break;
        }
        any = true;
        // first 8 bytes = the StartFileReferenceNumber for the next call
        let next = u64::from_ne_bytes(buf[0..8].try_into().unwrap());
        let limit = bytes as usize;
        let mut off = 8usize;
        while off + 4 <= limit {
            let rl = u32::from_ne_bytes(buf[off..off + 4].try_into().unwrap()) as usize;
            if rl < 60 || off + rl > limit {
                break;
            }
            // copy out the fixed header (unaligned-safe), then read the name from the buffer
            let rec = unsafe { read_unaligned(buf.as_ptr().add(off) as *const USN_RECORD_V2) };
            let no = rec.FileNameOffset as usize;
            let nl = rec.FileNameLength as usize / 2;
            if off + no + nl * 2 <= off + rl {
                let name = unsafe {
                    let p = buf.as_ptr().add(off + no) as *const u16;
                    String::from_utf16_lossy(std::slice::from_raw_parts(p, nl))
                };
                let is_dir = rec.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
                nodes.insert(
                    rec.FileReferenceNumber & MASK,
                    (name, rec.ParentFileReferenceNumber & MASK, is_dir),
                );
            }
            off += rl;
        }
        med.StartFileReferenceNumber = next;
    }

    if !any {
        return None; // FSCTL not supported / empty → let caller fall back to walk
    }

    let mut out: Vec<(String, String, bool)> = Vec::with_capacity(nodes.len());
    for (&key, (name, _parent, is_dir)) in &nodes {
        if key == ROOT_RECORD {
            continue;
        }
        if let Some(path) = build_path(key, &nodes, letter) {
            out.push((name.clone(), path, *is_dir));
        }
    }
    Some(out)
}
