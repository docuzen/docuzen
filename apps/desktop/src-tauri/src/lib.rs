mod pending;
mod sidecar;

use std::sync::Mutex;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

struct SidecarState(Mutex<Option<sidecar::SidecarHandle>>);

#[tauri::command]
fn get_docd_port(state: tauri::State<SidecarState>) -> Option<u16> {
    state.0.lock().unwrap().as_ref().map(|h| h.port())
}

#[tauri::command]
fn restart_sidecar(state: tauri::State<SidecarState>) {
    if let Some(h) = state.0.lock().unwrap().as_ref() {
        h.restart();
    }
}

#[tauri::command]
fn take_pending_opens(state: tauri::State<pending::PendingOpens>) -> Vec<String> {
    state.drain()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // macOS window restoration replays open-document events — including for
    // files that no longer exist, whose nil absoluteString panics tao 0.35.3
    // (app_delegate.rs:142) inside a nounwind FFI boundary: an app-killing
    // relaunch loop. We build our window fresh each launch and do our own
    // tab/session restore, so macOS saved state is pure liability — purge it
    // before AppKit starts.
    if let Some(home) = std::env::var_os("HOME") {
        let _ = std::fs::remove_dir_all(
            std::path::PathBuf::from(home)
                .join("Library/Saved Application State/com.docuzen.app.savedState"),
        );
    }

    tauri::Builder::default()
        .manage(pending::PendingOpens::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Packaged builds spawn the bundled sidecar and tell the webview
            // its port. Dev builds keep the beforeDevCommand tsx sidecar and
            // the VITE_DOCD_PORT path — state stays None.
            let mut init_script = String::new();
            if !cfg!(debug_assertions) {
                let dir = app.path().resource_dir()?.join("sidecar");
                match sidecar::start(&dir) {
                    Ok(h) => {
                        init_script = format!("window.__DOCD_PORT__ = {};", h.port());
                        app.manage(SidecarState(Mutex::new(Some(h))));
                    }
                    Err(e) => {
                        // Spec §4: fail visibly, pointing at the log.
                        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                        app.dialog()
                            .message(format!("docd failed to start: {e}\n\nSee ~/.docuzen/logs/docd.log"))
                            .kind(MessageDialogKind::Error)
                            .title("docuzen")
                            .blocking_show();
                        app.manage(SidecarState(Mutex::new(None)));
                    }
                }
            } else {
                app.manage(SidecarState(Mutex::new(None)));
            }

            let mut win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("docuzen")
            .inner_size(1100.0, 760.0)
            .center();
            if !init_script.is_empty() {
                win = win.initialization_script(&init_script);
            }
            win.build()?;

            let handle = app.handle();

            // App menu (Quit etc.) — keeps standard macOS behavior.
            let app_menu = SubmenuBuilder::new(handle, "docuzen")
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            // File menu — the home for document actions.
            let open = MenuItemBuilder::with_id("open", "Open…")
                .accelerator("CmdOrCtrl+O")
                .build(handle)?;
            let save = MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(handle)?;
            let export = MenuItemBuilder::with_id("export", "Export .hadz…")
                .accelerator("CmdOrCtrl+Shift+E")
                .build(handle)?;
            let close = MenuItemBuilder::with_id("close", "Close Document")
                .accelerator("CmdOrCtrl+W")
                .build(handle)?;
            let settings = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(handle)?;
            let resolve_directives =
                MenuItemBuilder::with_id("resolve-directives", "Resolve [[ ]]")
                    .accelerator("CmdOrCtrl+Shift+D")
                    .build(handle)?;
            let file_menu = SubmenuBuilder::new(handle, "File")
                .item(&open)
                .item(&save)
                .item(&export)
                .separator()
                .item(&resolve_directives)
                .separator()
                .item(&settings)
                .item(&close)
                .build()?;

            // Edit menu — copy/paste/undo for the editor.
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let reload = MenuItemBuilder::with_id("reload", "Reload Window")
                .accelerator("CmdOrCtrl+R")
                .build(handle)?;
            let shortcuts = MenuItemBuilder::with_id("shortcuts", "Keyboard Shortcuts")
                .accelerator("CmdOrCtrl+Shift+H")
                .build(handle)?;
            let view_menu = SubmenuBuilder::new(handle, "View")
                .item(&reload)
                .item(&shortcuts)
                .build()?;

            let menu = MenuBuilder::new(handle)
                .items(&[&app_menu, &file_menu, &edit_menu, &view_menu])
                .build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            // Forward custom menu clicks to the webview.
            let _ = app.emit("menu-action", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![get_docd_port, restart_sidecar, take_pending_opens])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // AppKit's application:openURLs: is a nounwind FFI boundary — ANY
            // panic reaching it aborts the app (v0.1.2 crashed on launch-by-
            // document). State is Builder-managed so it exists before the
            // event loop; try_state + catch_unwind keep this path panic-proof.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let paths: Vec<String> = urls
                        .iter()
                        .filter_map(|u| u.to_file_path().ok())
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect();
                    if paths.is_empty() {
                        eprintln!("docuzen: open event carried no usable file paths");
                    } else if let Some(q) = app.try_state::<pending::PendingOpens>() {
                        q.push_all(paths);
                        let _ = app.emit("open-pending", ());
                    } else {
                        eprintln!("docuzen: open event before state was managed — dropped");
                    }
                }));
                if handled.is_err() {
                    eprintln!("docuzen: panic in open-urls handler suppressed");
                }
            }
            if let tauri::RunEvent::Exit = event {
                if let Some(h) = app.state::<SidecarState>().0.lock().unwrap().take() {
                    h.stop();
                }
            }
        });
}
