//! Spawns and owns the packaged docd sidecar (node + main.cjs).
//! Not used in dev builds — `beforeDevCommand` runs the tsx-watch sidecar.

use std::fs::{create_dir_all, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const SPAWN_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESTARTS: u32 = 3;
/// A child that runs at least this long before exiting resets the consecutive-crash counter.
const STABLE_UPTIME: Duration = Duration::from_secs(60);

/// GUI apps launched from Finder inherit launchd's minimal PATH, which is
/// missing the shell-profile dirs (homebrew, bun, cargo, ...) where external
/// harness CLIs like codex are installed. Append the well-known ones so the
/// sidecar's CLI detection matches what the user's terminal sees.
fn augmented_path(current: &str, home: &Path) -> String {
    let mut path = current.to_string();
    let candidates = [
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".bun/bin"),
        home.join(".local/bin"),
        home.join(".cargo/bin"),
        home.join(".npm-global/bin"),
    ];
    for candidate in candidates {
        let entry = candidate.to_string_lossy();
        if !path.split(':').any(|p| p == entry) {
            path.push(':');
            path.push_str(&entry);
        }
    }
    path
}

pub struct SidecarHandle {
    port: u16,
    child: Arc<Mutex<Option<Child>>>,
    shutting_down: Arc<AtomicBool>,
    /// Set by `restart()` just before it kills the child, so the monitor can tell a
    /// requested bounce from a crash.
    restart_requested: Arc<AtomicBool>,
}

/// What the monitor does about a child exit. A requested restart is not a crash: it
/// never spends the crash budget and respawns without backoff. Without this, three
/// config-driven restarts inside `STABLE_UPTIME` exhausted `MAX_RESTARTS` and left the
/// app with no sidecar until relaunch.
#[derive(Debug, PartialEq)]
enum ExitAction {
    Respawn { restarts: u32, backoff: Duration },
    GiveUp,
}

fn on_child_exit(requested: bool, stable: bool, restarts: u32) -> ExitAction {
    if requested {
        return ExitAction::Respawn { restarts, backoff: Duration::ZERO };
    }
    // A previous incarnation that ran long enough makes this a fresh failure streak.
    let restarts = if stable { 0 } else { restarts };
    if restarts >= MAX_RESTARTS {
        return ExitAction::GiveUp;
    }
    let restarts = restarts + 1;
    ExitAction::Respawn { restarts, backoff: Duration::from_secs(1 << restarts.min(3)) }
}

pub fn parse_port_line(line: &str) -> Option<u16> {
    line.strip_prefix("DOCD_PORT=")?.trim().parse().ok()
}

fn log_path() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(".docuzen").join("logs").join("docd.log")
}

fn open_log() -> std::io::Result<std::fs::File> {
    let path = log_path();
    if let Some(dir) = path.parent() {
        create_dir_all(dir)?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}

/// Spawns one sidecar process. `port` 0 lets the sidecar pick a free port;
/// the chosen port is parsed from its `DOCD_PORT=` stdout line. All stdout
/// lines (and stderr, via redirection) are appended to ~/.docuzen/logs/docd.log.
fn spawn_once(sidecar_dir: &Path, port: u16) -> Result<(Child, u16), String> {
    let log = open_log().map_err(|e| format!("cannot open docd log: {e}"))?;
    let stderr_log = log.try_clone().map_err(|e| format!("cannot clone log handle: {e}"))?;
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let path = augmented_path(&std::env::var("PATH").unwrap_or_default(), &home);
    let mut child = Command::new(sidecar_dir.join("node"))
        .arg(sidecar_dir.join("main.cjs"))
        .arg("--port")
        .arg(port.to_string())
        .env("DOCD_NATIVE_BINDING", sidecar_dir.join("better_sqlite3.node"))
        .env("PATH", &path)
        // Finder/Dock launches don't carry the shell profile's exports (API keys a harness
        // CLI needs); the sidecar reads them from the login shell once at startup.
        .env("DOCD_LOAD_SHELL_ENV", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::from(stderr_log))
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar: {e}"))?;

    let stdout = child.stdout.take().ok_or("sidecar stdout not captured")?;
    let (tx, rx) = mpsc::channel::<u16>();
    thread::spawn(move || {
        let mut log = log;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = writeln!(log, "{line}");
            if let Some(p) = parse_port_line(&line) {
                let _ = tx.send(p);
            }
        }
    });

    match rx.recv_timeout(SPAWN_TIMEOUT) {
        Ok(actual_port) => Ok((child, actual_port)),
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!("sidecar did not report a port within {SPAWN_TIMEOUT:?} — see {}", log_path().display()))
        }
    }
}

/// Starts the sidecar and a monitor thread that respawns it (same port, so
/// the frontend's reconnect finds it) up to MAX_RESTARTS consecutive crashes.
pub fn start(sidecar_dir: &Path) -> Result<SidecarHandle, String> {
    let (child, port) = spawn_once(sidecar_dir, 0)?;
    let child = Arc::new(Mutex::new(Some(child)));
    let shutting_down = Arc::new(AtomicBool::new(false));

    let monitor_child = Arc::clone(&child);
    let monitor_flag = Arc::clone(&shutting_down);
    let restart_requested = Arc::new(AtomicBool::new(false));
    let monitor_restart = Arc::clone(&restart_requested);
    let dir = sidecar_dir.to_path_buf();
    thread::spawn(move || {
        let mut restarts: u32 = 0;
        // Tracks when the current child was (re)spawned; used to reset the
        // consecutive-crash counter when the child was stable long enough.
        let mut last_spawn: Instant = Instant::now();
        loop {
            // Wait on the current child without holding the lock while blocked.
            let exited = {
                let mut guard = monitor_child.lock().unwrap();
                match guard.as_mut() {
                    // Finding 3: Ok(None) = still running; Ok(Some(_)) or Err(_) = gone.
                    Some(c) => !matches!(c.try_wait(), Ok(None)),
                    None => true,
                }
            };
            if !exited {
                thread::sleep(Duration::from_millis(500));
                continue;
            }
            if monitor_flag.load(Ordering::SeqCst) {
                return;
            }
            let requested = monitor_restart.swap(false, Ordering::SeqCst);
            let stable = last_spawn.elapsed() >= STABLE_UPTIME;
            match on_child_exit(requested, stable, restarts) {
                ExitAction::GiveUp => {
                    if let Ok(mut log) = open_log() {
                        let _ = writeln!(log, "docuzen: sidecar crashed {MAX_RESTARTS} times; giving up");
                    }
                    return;
                }
                ExitAction::Respawn { restarts: next, backoff } => {
                    restarts = next;
                    thread::sleep(backoff);
                }
            }
            // Finding 1: stop() may have fired during the backoff sleep.
            if monitor_flag.load(Ordering::SeqCst) {
                return;
            }
            match spawn_once(&dir, port) {
                Ok((new_child, _)) => {
                    let mut guard = monitor_child.lock().unwrap();
                    // Finding 1: stop() may have run while spawn_once was in
                    // flight — if so, kill the orphan and exit instead of
                    // storing a child that will never be reaped.
                    if monitor_flag.load(Ordering::SeqCst) {
                        let mut nc = new_child;
                        let _ = nc.kill();
                        let _ = nc.wait();
                        return;
                    }
                    *guard = Some(new_child);
                    last_spawn = Instant::now();
                }
                Err(e) => {
                    // A failed attempt starts a new unstable incarnation.
                    // Without this, persistent failure lets elapsed() creep
                    // past STABLE_UPTIME, resetting `restarts` and retrying
                    // forever — the MAX_RESTARTS guard would be unreachable.
                    last_spawn = Instant::now();
                    if let Ok(mut log) = open_log() {
                        let _ = writeln!(log, "docuzen: sidecar respawn failed: {e}");
                    }
                }
            }
        }
    });

    Ok(SidecarHandle { port, child, shutting_down, restart_requested })
}

impl SidecarHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Kill the child; the monitor thread respawns it on the same port.
    /// Used after config changes so the sidecar re-reads config.toml.
    pub fn restart(&self) {
        if let Some(c) = self.child.lock().unwrap().as_mut() {
            // Flag first: the monitor must see it by the time it observes the exit.
            self.restart_requested.store(true, Ordering::SeqCst);
            let _ = c.kill();
        }
    }

    /// Kill the child for good (app exit).
    pub fn stop(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Some(mut c) = self.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{augmented_path, on_child_exit, parse_port_line, ExitAction, MAX_RESTARTS};
    use std::path::Path;
    use std::time::Duration;

    #[test]
    fn requested_restarts_never_spend_the_crash_budget() {
        // Even with the budget already exhausted, a requested bounce respawns at once.
        assert_eq!(
            on_child_exit(true, false, MAX_RESTARTS),
            ExitAction::Respawn { restarts: MAX_RESTARTS, backoff: Duration::ZERO }
        );
    }

    #[test]
    fn crashes_back_off_then_give_up() {
        assert_eq!(
            on_child_exit(false, false, 0),
            ExitAction::Respawn { restarts: 1, backoff: Duration::from_secs(2) }
        );
        assert_eq!(
            on_child_exit(false, false, 2),
            ExitAction::Respawn { restarts: 3, backoff: Duration::from_secs(8) }
        );
        assert_eq!(on_child_exit(false, false, MAX_RESTARTS), ExitAction::GiveUp);
    }

    #[test]
    fn a_crash_after_a_stable_run_starts_a_new_streak() {
        assert_eq!(
            on_child_exit(false, true, MAX_RESTARTS),
            ExitAction::Respawn { restarts: 1, backoff: Duration::from_secs(2) }
        );
    }

    #[test]
    fn parses_the_port_line() {
        assert_eq!(parse_port_line("DOCD_PORT=8137"), Some(8137));
        assert_eq!(parse_port_line("DOCD_PORT=61234\n"), Some(61234));
    }

    #[test]
    fn ignores_other_lines() {
        assert_eq!(parse_port_line("docd: PiRunner (provider=litellm)"), None);
        assert_eq!(parse_port_line("PORT=8137"), None);
        assert_eq!(parse_port_line("DOCD_PORT=abc"), None);
    }

    #[test]
    fn appends_missing_wellknown_dirs() {
        let p = augmented_path("/usr/bin:/bin", Path::new("/Users/u"));
        assert!(p.starts_with("/usr/bin:/bin:"), "existing PATH stays first: {p}");
        assert!(p.contains(":/opt/homebrew/bin"));
        assert!(p.contains(":/Users/u/.bun/bin"));
        assert!(p.contains(":/Users/u/.cargo/bin"));
    }

    #[test]
    fn does_not_duplicate_entries_already_present() {
        let p = augmented_path("/opt/homebrew/bin:/usr/bin", Path::new("/Users/u"));
        assert_eq!(p.matches("/opt/homebrew/bin").count(), 1);
    }
}
