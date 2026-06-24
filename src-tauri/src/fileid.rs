// NTFS FileId 冗余救援键(M7)。文件在「监视目录之外」被移动时, watch 的 rename 配对收不到, 标签会变孤儿。
// 打标签时顺手记一份 (卷根 + 128 位 FileId); 孤儿清理前用 OpenFileById 直接把 FileId 解析成「当前路径」
// —— 不枚举 MFT(避开 M0「MFT 不动」边界), 也不做主键(只在 rename-follow 失效时兜底)。
#[cfg(windows)]
mod imp {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandleEx, GetFinalPathNameByHandleW, OpenFileById,
        FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_128, FILE_ID_DESCRIPTOR,
        FILE_ID_DESCRIPTOR_0, FILE_ID_INFO, FILE_NAME_NORMALIZED, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FileIdInfo, OPEN_EXISTING,
    };
    use windows::Win32::Storage::FileSystem::FILE_ID_TYPE;

    fn drive_root(path: &str) -> Option<String> {
        let b = path.as_bytes();
        if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
            Some(format!("{}:\\", (b[0] as char).to_ascii_uppercase()))
        } else {
            None
        }
    }

    // 打标签时调: 返回 "C:\|<32 hex>"(卷根 + FileId), 失败 None(best-effort, 不影响打标签)。
    pub fn capture(path: &str) -> Option<String> {
        let root = drive_root(path)?;
        unsafe {
            let h = CreateFileW(
                &HSTRING::from(path),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS, // 目录也能开
                None,
            )
            .ok()?;
            let mut info = FILE_ID_INFO::default();
            let ok = GetFileInformationByHandleEx(
                h,
                FileIdInfo,
                &mut info as *mut _ as *mut core::ffi::c_void,
                core::mem::size_of::<FILE_ID_INFO>() as u32,
            )
            .is_ok();
            let _ = CloseHandle(h);
            if !ok {
                return None;
            }
            let hex: String = info
                .FileId
                .Identifier
                .iter()
                .map(|b| format!("{:02x}", b))
                .collect();
            Some(format!("{}|{}", root, hex))
        }
    }

    // 孤儿救援: 由 "C:\|<32 hex>" 解析出文件「当前」路径(移动后的新位置)。失败 None。
    pub fn resolve(stored: &str) -> Option<String> {
        let (root, hex) = stored.split_once('|')?;
        if hex.len() != 32 {
            return None;
        }
        let mut id = [0u8; 16];
        for i in 0..16 {
            id[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
        }
        unsafe {
            // 卷句柄提示: 开卷根目录(任意同卷句柄即可)
            let hvol = CreateFileW(
                &HSTRING::from(root),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                None,
            )
            .ok()?;
            let desc = FILE_ID_DESCRIPTOR {
                dwSize: core::mem::size_of::<FILE_ID_DESCRIPTOR>() as u32,
                Type: FILE_ID_TYPE(2), // ExtendedFileIdType
                Anonymous: FILE_ID_DESCRIPTOR_0 {
                    ExtendedFileId: FILE_ID_128 { Identifier: id },
                },
            };
            let hfile = OpenFileById(
                hvol,
                &desc,
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                FILE_FLAGS_AND_ATTRIBUTES(0),
            );
            let _ = CloseHandle(hvol);
            let hfile = hfile.ok()?;
            let mut buf = [0u16; 1024];
            let n = GetFinalPathNameByHandleW(hfile, &mut buf, FILE_NAME_NORMALIZED);
            let _ = CloseHandle(hfile);
            if n == 0 || n as usize >= buf.len() {
                return None;
            }
            let s = String::from_utf16_lossy(&buf[..n as usize]);
            // 去掉 \\?\ 前缀
            let s = s.strip_prefix("\\\\?\\").unwrap_or(&s).to_string();
            Some(s)
        }
    }
}

#[cfg(windows)]
pub fn capture(path: &str) -> Option<String> {
    imp::capture(path)
}
#[cfg(windows)]
pub fn resolve(stored: &str) -> Option<String> {
    imp::resolve(stored)
}
#[cfg(not(windows))]
pub fn capture(_path: &str) -> Option<String> {
    None
}
#[cfg(not(windows))]
pub fn resolve(_stored: &str) -> Option<String> {
    None
}
