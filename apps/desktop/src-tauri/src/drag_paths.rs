//! Paths of the files in the most recent drag.
//!
//! lib.rs turns off Tauri's native drop handler: it takes every drag away from the page,
//! including text and images dragged inside a document. The page's drop event still
//! carries each dropped file's name and bytes, but never its path, so the page cannot open
//! a dropped document by itself. macOS keeps a drag's items on the drag pasteboard until
//! the next drag starts, so the page's drop handler asks for them here, and opens only
//! the paths whose names match the files it was handed (doc-drop.ts).

#[cfg(target_os = "macos")]
pub fn last_drag_file_paths() -> Vec<String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag};
    // SAFETY: an AppKit constant, initialised before any code of ours runs.
    let pb = NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag });
    file_paths_on(&pb)
}

#[cfg(not(target_os = "macos"))]
pub fn last_drag_file_paths() -> Vec<String> {
    Vec::new()
}

/// The file paths on a pasteboard, in its order. Finder writes file *reference* URLs
/// (`file:///.file/id=…`); `filePathURL` turns those back into paths.
#[cfg(target_os = "macos")]
fn file_paths_on(pb: &objc2_app_kit::NSPasteboard) -> Vec<String> {
    use objc2_app_kit::NSPasteboardTypeFileURL;
    use objc2_foundation::NSURL;

    let Some(items) = pb.pasteboardItems() else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for i in 0..items.count() {
        let item = items.objectAtIndex(i);
        // SAFETY: an AppKit constant, as above.
        let Some(url) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) else {
            continue;
        };
        let path = NSURL::URLWithString(&url)
            .and_then(|u| u.filePathURL())
            .and_then(|u| u.path());
        if let Some(path) = path {
            paths.push(path.to_string());
        }
    }
    paths
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::file_paths_on;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};
    use std::path::{Path, PathBuf};

    /// Free a test pasteboard (objc2-app-kit does not bind `releaseGlobally`).
    fn release(pb: &NSPasteboard) {
        // SAFETY: `releaseGlobally` takes no arguments and returns void.
        let _: () = unsafe { objc2::msg_send![pb, releaseGlobally] };
    }

    fn canonical(p: impl AsRef<Path>) -> PathBuf {
        std::fs::canonicalize(p).unwrap()
    }

    #[test]
    fn reads_plain_and_finder_reference_file_urls_in_order() {
        let dir = std::env::temp_dir().join(format!("docuzen-drag-paths-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("notes.md");
        let b = dir.join("café report.html");
        std::fs::write(&a, "# a\n").unwrap();
        std::fs::write(&b, "<p>b</p>\n").unwrap();

        let pb = NSPasteboard::pasteboardWithUniqueName();
        pb.clearContents();
        let url_a = NSURL::fileURLWithPath(&NSString::from_str(a.to_str().unwrap()));
        // What Finder actually puts on the drag pasteboard.
        let url_b = NSURL::fileURLWithPath(&NSString::from_str(b.to_str().unwrap()))
            .fileReferenceURL()
            .expect("a file reference URL for an existing file");
        assert!(url_b.absoluteString().unwrap().to_string().contains("/.file/id="));
        let objects: [objc2::rc::Retained<ProtocolObject<dyn NSPasteboardWriting>>; 2] =
            [ProtocolObject::from_retained(url_a), ProtocolObject::from_retained(url_b)];
        assert!(pb.writeObjects(&NSArray::from_retained_slice(&objects)));

        let got: Vec<PathBuf> = file_paths_on(&pb).iter().map(canonical).collect();
        assert_eq!(got, vec![canonical(&a), canonical(&b)]);

        release(&pb);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pasteboard_without_files_gives_no_paths() {
        let pb = NSPasteboard::pasteboardWithUniqueName();
        pb.clearContents();
        let text: [objc2::rc::Retained<ProtocolObject<dyn NSPasteboardWriting>>; 1] =
            [ProtocolObject::from_retained(NSString::from_str("/etc/hosts"))];
        assert!(pb.writeObjects(&NSArray::from_retained_slice(&text)));
        assert!(file_paths_on(&pb).is_empty(), "a dragged string that looks like a path is not a file");
        release(&pb);
    }
}
