//! Spawns and owns the packaged docd sidecar (node + main.cjs).
//! Not used in dev builds — `beforeDevCommand` runs the tsx-watch sidecar.
//!
//! Lifecycle rules:
//! - A spawned child is registered (in `Shared::slot`) before its port is awaited, so
//!   `stop()` always finds the process it has to end — none can outlive the app.
//! - The sidecar leads its own process group. Stopping it sends SIGTERM to the group (docd's
//!   handler closes its databases; codex, MCP servers and other children go too), then
//!   SIGKILL if anything is still there after a short grace.
//! - The monitor thread lives as long as the app. After the crash limit it waits rather
//!   than exits, so an explicit `restart()` can still bring the sidecar back.

use std::fs::{create_dir_all, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const MAX_RESTARTS: u32 = 3;

/// How long things take. The app uses `TIMING`; tests shrink it.
#[derive(Clone, Copy, Debug)]
struct Timing {
    /// How long a new sidecar has to print its `DOCD_PORT=` line.
    spawn_timeout: Duration,
    /// How often the monitor checks on the child when nothing wakes it.
    poll: Duration,
    /// How long a SIGTERMed sidecar gets to shut down before SIGKILL.
    stop_grace: Duration,
    /// A child that runs at least this long before exiting resets the consecutive-crash counter.
    stable_uptime: Duration,
    /// Crash backoff is this × 2, 4, 8.
    backoff_unit: Duration,
}

const TIMING: Timing = Timing {
    spawn_timeout: Duration::from_secs(15),
    poll: Duration::from_millis(500),
    stop_grace: Duration::from_secs(3),
    stable_uptime: Duration::from_secs(60),
    backoff_unit: Duration::from_secs(1),
};

#[derive(Clone, Debug)]
struct Config {
    /// Holds `node`, `main.cjs` and `better_sqlite3.node`.
    dir: PathBuf,
    /// Where the sidecar's stdout and stderr are appended.
    log: PathBuf,
    timing: Timing,
}

/// A fresh launch token: 256 bits from the OS RNG, as lowercase hex. docd requires it on
/// every WebSocket and `/image` request; the webview gets it from `init_script`.
pub fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("cannot read the OS random number generator: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The webview's initialization script: where docd listens, and the token it requires. The
/// script runs on every top-level navigation of the main frame, so the token is only handed
/// to the app's own page (macOS/Linux `tauri://localhost`, Windows `http(s)://tauri.localhost`).
pub fn init_script(port: u16, token: &str) -> String {
    debug_assert!(token.chars().all(|c| c.is_ascii_hexdigit()), "token is spliced into JS");
    format!(
        "window.__DOCD_PORT__ = {port};\n\
         if ([\"tauri://localhost\", \"http://tauri.localhost\", \"https://tauri.localhost\"].includes(window.location.origin)) {{\n\
         \x20 window.__DOCD_TOKEN__ = \"{token}\";\n\
         }}\n"
    )
}

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

/// The current sidecar process, once spawned.
struct Running {
    child: Child,
    /// When `restart()` asked it to exit; the monitor SIGKILLs it once `stop_grace` has passed.
    term_sent: Option<Instant>,
}

/// State shared by the handle (the app's commands, app exit) and the monitor thread.
struct Shared {
    slot: Mutex<Option<Running>>,
    shutting_down: AtomicBool,
    /// Set by `restart()`, cleared when a process that started after it is registered, so
    /// the monitor can tell a requested bounce from a crash.
    restart_requested: AtomicBool,
    /// Wakes the monitor early (restart, stop) instead of waiting out a poll or a backoff.
    wake: mpsc::Sender<()>,
}

pub struct SidecarHandle {
    port: u16,
    token: String,
    shared: Arc<Shared>,
    timing: Timing,
}

/// What the monitor does about a child exit. A requested restart is not a crash: it
/// never spends the crash budget and respawns without backoff. Without this, three
/// config-driven restarts inside `STABLE_UPTIME` exhausted `MAX_RESTARTS` and left the
/// app with no sidecar until relaunch.
#[derive(Debug, PartialEq)]
enum ExitAction {
    Respawn { restarts: u32, backoff: Duration },
    /// Stop respawning on our own; wait for an explicit `restart()`.
    GiveUp,
}

fn on_child_exit(requested: bool, stable: bool, restarts: u32, unit: Duration) -> ExitAction {
    if requested {
        return ExitAction::Respawn { restarts, backoff: Duration::ZERO };
    }
    // A previous incarnation that ran long enough makes this a fresh failure streak.
    let restarts = if stable { 0 } else { restarts };
    if restarts >= MAX_RESTARTS {
        return ExitAction::GiveUp;
    }
    let restarts = restarts + 1;
    ExitAction::Respawn { restarts, backoff: unit * (1 << restarts.min(3)) }
}

pub fn parse_port_line(line: &str) -> Option<u16> {
    line.strip_prefix("DOCD_PORT=")?.trim().parse().ok()
}

fn log_path() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(".docuzen").join("logs").join("docd.log")
}

fn open_log(path: &Path) -> std::io::Result<std::fs::File> {
    if let Some(dir) = path.parent() {
        create_dir_all(dir)?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}

fn log_line(cfg: &Config, line: &str) {
    if let Ok(mut log) = open_log(&cfg.log) {
        let _ = writeln!(log, "{line}");
    }
}

/// True while the child has not been reaped. Only then is its pid (and so its process group
/// id) still ours to signal: once reaped, the number can belong to someone else.
fn running(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(None))
}

/// Send `signal` to the sidecar's process group. Callers check `running()` first.
#[cfg(unix)]
fn signal_group(child: &Child, signal: libc::c_int) {
    // SAFETY: kill(2) takes no pointers; a negative pid addresses the process group, which
    // the child leads (`process_group(0)` at spawn) and which is ours while it is unreaped.
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), signal);
    }
}

/// Ask the sidecar to shut down (SIGTERM to its group).
fn request_exit(child: &mut Child) {
    #[cfg(unix)]
    signal_group(child, libc::SIGTERM);
    #[cfg(not(unix))]
    let _ = child.kill();
}

/// SIGKILL the sidecar's group (it ignored SIGTERM for longer than the grace).
fn force_kill(child: &mut Child) {
    #[cfg(unix)]
    signal_group(child, libc::SIGKILL);
    let _ = child.kill();
}

/// End the sidecar for good: SIGTERM, up to `grace` to exit, then SIGKILL. Blocks until the
/// child is reaped.
fn terminate(child: &mut Child, grace: Duration) {
    if !running(child) {
        return;
    }
    request_exit(child);
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if !running(child) {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    force_kill(child);
    let _ = child.wait();
}

/// Spawns one sidecar. `port` 0 lets the sidecar pick a free port; the chosen port is
/// parsed from its `DOCD_PORT=` stdout line. All stdout lines (and stderr, via redirection)
/// are appended to the log.
///
/// The child is registered in `shared.slot` before the port is awaited, under the same lock
/// `stop()` and `restart()` take: a stop that lands while it starts ends it, and a restart
/// requested before it existed is satisfied by it.
fn spawn_once(cfg: &Config, port: u16, token: &str, shared: &Shared) -> Result<u16, String> {
    let log = open_log(&cfg.log).map_err(|e| format!("cannot open docd log: {e}"))?;
    let stderr_log = log.try_clone().map_err(|e| format!("cannot clone log handle: {e}"))?;
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let path = augmented_path(&std::env::var("PATH").unwrap_or_default(), &home);
    let mut cmd = Command::new(cfg.dir.join("node"));
    cmd.arg(cfg.dir.join("main.cjs"))
        .arg("--port")
        .arg(port.to_string())
        .env("DOCD_NATIVE_BINDING", cfg.dir.join("better_sqlite3.node"))
        .env("PATH", &path)
        // Finder/Dock launches don't carry the shell profile's exports (API keys a harness
        // CLI needs); the sidecar reads them from the login shell once at startup.
        .env("DOCD_LOAD_SHELL_ENV", "1")
        // The same token every incarnation: the webview reconnects with the one it was given.
        .env("DOCD_TOKEN", token)
        .stdout(Stdio::piped())
        .stderr(Stdio::from(stderr_log));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let (pid, stdout) = {
        let mut slot = shared.slot.lock().unwrap();
        if shared.shutting_down.load(Ordering::SeqCst) {
            return Err("the app is shutting down".into());
        }
        let mut child = cmd.spawn().map_err(|e| format!("failed to spawn sidecar: {e}"))?;
        let stdout = child.stdout.take();
        let pid = child.id();
        *slot = Some(Running { child, term_sent: None });
        // Whoever asked for a restart before now gets this fresh process.
        shared.restart_requested.store(false, Ordering::SeqCst);
        (pid, stdout)
    };

    let (tx, rx) = mpsc::channel::<u16>();
    if let Some(stdout) = stdout {
        thread::spawn(move || {
            let mut log = log;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = writeln!(log, "{line}");
                if let Some(p) = parse_port_line(&line) {
                    let _ = tx.send(p);
                }
            }
        });
    }

    match rx.recv_timeout(cfg.timing.spawn_timeout) {
        Ok(actual_port) => Ok(actual_port),
        Err(e) => {
            // Still ours to end unless stop() (or a newer spawn) took the slot meanwhile.
            let mine = {
                let mut slot = shared.slot.lock().unwrap();
                if slot.as_ref().map(|r| r.child.id()) == Some(pid) {
                    slot.take()
                } else {
                    None
                }
            };
            if let Some(mut r) = mine {
                terminate(&mut r.child, cfg.timing.stop_grace);
            }
            Err(match e {
                mpsc::RecvTimeoutError::Timeout => format!(
                    "sidecar did not report a port within {:?} — see {}",
                    cfg.timing.spawn_timeout,
                    cfg.log.display()
                ),
                mpsc::RecvTimeoutError::Disconnected => {
                    format!("sidecar exited before reporting a port — see {}", cfg.log.display())
                }
            })
        }
    }
}

/// Starts the sidecar and a monitor thread that respawns it (same port and token, so the
/// frontend's reconnect finds it) up to MAX_RESTARTS consecutive crashes.
pub fn start(sidecar_dir: &Path) -> Result<SidecarHandle, String> {
    start_with(Config { dir: sidecar_dir.to_path_buf(), log: log_path(), timing: TIMING })
}

fn start_with(cfg: Config) -> Result<SidecarHandle, String> {
    let token = new_token()?;
    let (wake, wake_rx) = mpsc::channel();
    let shared = Arc::new(Shared {
        slot: Mutex::new(None),
        shutting_down: AtomicBool::new(false),
        restart_requested: AtomicBool::new(false),
        wake,
    });
    let port = spawn_once(&cfg, 0, &token, &shared)?;
    let timing = cfg.timing;
    let (monitor_shared, monitor_token) = (Arc::clone(&shared), token.clone());
    thread::spawn(move || monitor(cfg, port, monitor_token, monitor_shared, wake_rx));
    Ok(SidecarHandle { port, token, shared, timing })
}

/// Watches the child; respawns it after a crash (with backoff) or a requested restart.
fn monitor(cfg: Config, port: u16, token: String, shared: Arc<Shared>, wake: mpsc::Receiver<()>) {
    let stopping = || shared.shutting_down.load(Ordering::SeqCst);
    let mut restarts: u32 = 0;
    // When the current child was (re)spawned; a child that ran long enough resets the
    // consecutive-crash counter.
    let mut last_spawn = Instant::now();
    loop {
        if stopping() {
            return;
        }
        let exited = {
            let mut slot = shared.slot.lock().unwrap();
            match slot.as_mut() {
                None => true,
                Some(r) => {
                    let alive = running(&mut r.child);
                    if alive && r.term_sent.is_some_and(|at| at.elapsed() >= cfg.timing.stop_grace) {
                        force_kill(&mut r.child); // ignored a restart's SIGTERM
                    }
                    !alive
                }
            }
        };
        if !exited {
            let _ = wake.recv_timeout(cfg.timing.poll);
            continue;
        }
        if stopping() {
            return;
        }
        // Consumed here: if the respawn below fails before a process is registered, the next
        // exit is judged as a crash again (no zero-backoff loop on a broken install).
        let requested = shared.restart_requested.swap(false, Ordering::SeqCst);
        let stable = last_spawn.elapsed() >= cfg.timing.stable_uptime;
        match on_child_exit(requested, stable, restarts, cfg.timing.backoff_unit) {
            ExitAction::GiveUp => {
                log_line(&cfg, &format!("docuzen: sidecar crashed {MAX_RESTARTS} times; waiting for a restart"));
                // Stay alive: a restart (Settings, after fixing the config) brings it back.
                while !shared.restart_requested.load(Ordering::SeqCst) {
                    if stopping() {
                        return;
                    }
                    let _ = wake.recv_timeout(cfg.timing.poll);
                }
                restarts = 0;
            }
            ExitAction::Respawn { restarts: next, backoff } => {
                restarts = next;
                // A restart request (or stop) cuts the backoff short.
                let deadline = Instant::now() + backoff;
                while !shared.restart_requested.load(Ordering::SeqCst) && !stopping() {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    let _ = wake.recv_timeout(left);
                }
            }
        }
        if stopping() {
            return;
        }
        if let Err(e) = spawn_once(&cfg, port, &token, &shared) {
            log_line(&cfg, &format!("docuzen: sidecar respawn failed: {e}"));
        }
        // A failed attempt starts a new unstable incarnation too. Without this, persistent
        // failure lets elapsed() creep past STABLE_UPTIME, resetting `restarts` and
        // retrying forever — the MAX_RESTARTS guard would be unreachable.
        last_spawn = Instant::now();
    }
}

impl SidecarHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// Ask the sidecar to exit; the monitor respawns it on the same port and token. Used
    /// after config changes so the sidecar re-reads config.toml. Returns at once: the
    /// monitor SIGKILLs a sidecar that ignores the SIGTERM, and respawns one that is
    /// starting up, or none at all after the crash limit.
    pub fn restart(&self) {
        {
            let mut slot = self.shared.slot.lock().unwrap();
            // Flag first: the monitor must see it by the time it observes the exit.
            self.shared.restart_requested.store(true, Ordering::SeqCst);
            if let Some(r) = slot.as_mut() {
                if r.term_sent.is_none() && running(&mut r.child) {
                    request_exit(&mut r.child);
                    r.term_sent = Some(Instant::now());
                }
            }
        }
        let _ = self.shared.wake.send(());
    }

    /// End the sidecar for good (app exit): SIGTERM, then SIGKILL after the grace. Blocks
    /// until it is gone, so nothing outlives the app.
    pub fn stop(&self) {
        self.shared.shutting_down.store(true, Ordering::SeqCst);
        let current = self.shared.slot.lock().unwrap().take();
        let _ = self.shared.wake.send(());
        if let Some(mut r) = current {
            terminate(&mut r.child, self.timing.stop_grace);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{augmented_path, init_script, new_token, on_child_exit, parse_port_line, ExitAction, MAX_RESTARTS};
    use std::path::Path;
    use std::time::Duration;

    const UNIT: Duration = Duration::from_secs(1);

    #[test]
    fn requested_restarts_never_spend_the_crash_budget() {
        // Even with the budget already exhausted, a requested bounce respawns at once.
        assert_eq!(
            on_child_exit(true, false, MAX_RESTARTS, UNIT),
            ExitAction::Respawn { restarts: MAX_RESTARTS, backoff: Duration::ZERO }
        );
    }

    #[test]
    fn crashes_back_off_then_give_up() {
        assert_eq!(
            on_child_exit(false, false, 0, UNIT),
            ExitAction::Respawn { restarts: 1, backoff: Duration::from_secs(2) }
        );
        assert_eq!(
            on_child_exit(false, false, 2, UNIT),
            ExitAction::Respawn { restarts: 3, backoff: Duration::from_secs(8) }
        );
        assert_eq!(on_child_exit(false, false, MAX_RESTARTS, UNIT), ExitAction::GiveUp);
    }

    #[test]
    fn a_crash_after_a_stable_run_starts_a_new_streak() {
        assert_eq!(
            on_child_exit(false, true, MAX_RESTARTS, UNIT),
            ExitAction::Respawn { restarts: 1, backoff: Duration::from_secs(2) }
        );
    }

    #[test]
    fn tokens_are_256_random_bits_in_hex() {
        let (a, b) = (new_token().unwrap(), new_token().unwrap());
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        assert_ne!(a, b);
    }

    #[test]
    fn the_init_script_gives_the_token_to_the_app_origin_only() {
        let s = init_script(61234, "ab12");
        assert!(s.starts_with("window.__DOCD_PORT__ = 61234;\n"), "{s}");
        assert!(s.contains(r#"["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"].includes(window.location.origin)"#), "{s}");
        assert!(s.contains(r#"window.__DOCD_TOKEN__ = "ab12";"#), "{s}");
        // The token assignment sits inside the origin check.
        let guard = s.find("if (").unwrap();
        let assign = s.find("__DOCD_TOKEN__").unwrap();
        let close = s.rfind('}').unwrap();
        assert!(guard < assign && assign < close, "{s}");
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

/// Lifecycle tests against real processes: a shell script stands in for `node main.cjs`.
#[cfg(all(test, unix))]
mod lifecycle_tests {
    use super::{start_with, Config, Timing};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::thread;
    use std::time::{Duration, Instant};

    const FAST: Timing = Timing {
        spawn_timeout: Duration::from_secs(30),
        poll: Duration::from_millis(20),
        stop_grace: Duration::from_millis(400),
        stable_uptime: Duration::from_secs(60),
        backoff_unit: Duration::from_millis(5),
    };

    /// A sidecar dir whose `node` runs `body` (after recording its pid and token).
    fn fake_sidecar(body: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "docuzen-sidecar-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let node = dir.join("node");
        fs::write(
            &node,
            format!("#!/bin/sh\nD=$(dirname \"$0\")\necho $$ >> \"$D/pids\"\necho \"$DOCD_TOKEN\" >> \"$D/tokens\"\n{body}\n"),
        )
        .unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        dir
    }

    fn cfg(dir: &Path) -> Config {
        Config { dir: dir.to_path_buf(), log: dir.join("docd.log"), timing: FAST }
    }

    fn lines(dir: &Path, name: &str) -> Vec<String> {
        fs::read_to_string(dir.join(name)).unwrap_or_default().lines().map(str::to_string).collect()
    }

    fn pids(dir: &Path) -> Vec<i32> {
        lines(dir, "pids").iter().filter_map(|l| l.trim().parse().ok()).collect()
    }

    fn alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn wait_until(what: &str, timeout: Duration, mut ok: impl FnMut() -> bool) {
        let end = Instant::now() + timeout;
        while !ok() {
            assert!(Instant::now() < end, "timed out waiting for: {what}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// Kill whatever a failed test left running, and drop its dir.
    fn cleanup(dir: &Path) {
        for pid in pids(dir).into_iter().chain(lines(dir, "grandchildren").iter().filter_map(|l| l.parse().ok())) {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        let _ = fs::remove_dir_all(dir);
    }

    const RUN_FOREVER: &str = "echo DOCD_PORT=4242\nwhile :; do sleep 0.05; done";

    #[test]
    fn passes_one_token_to_every_incarnation() {
        let dir = fake_sidecar(&format!(
            "if [ \"$(wc -l < \"$D/pids\")\" -le 1 ]; then echo DOCD_PORT=4242; sleep 0.1; exit 1; fi\n{RUN_FOREVER}"
        ));
        let h = start_with(cfg(&dir)).unwrap();
        wait_until("a respawn", Duration::from_secs(5), || lines(&dir, "tokens").len() >= 2);
        h.stop();
        let tokens = lines(&dir, "tokens");
        cleanup(&dir);
        assert_eq!(h.port(), 4242);
        assert_eq!(h.token().len(), 64);
        assert!(h.token().chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(tokens, vec![h.token().to_string(), h.token().to_string()]);
    }

    #[test]
    fn stop_asks_the_whole_process_group_to_exit() {
        let dir = fake_sidecar(&format!(
            // The grandchild records itself from a fresh `sh -c` (no inherited TERM trap), so
            // once its pid is on file a SIGTERM to the group is fatal to it.
            "trap 'echo term >> \"$D/events\"; exit 0' TERM\n\
             sh -c 'echo $$ >> \"$1/grandchildren\"; exec sleep 30' sh \"$D\" &\n{RUN_FOREVER}"
        ));
        let h = start_with(cfg(&dir)).unwrap();
        wait_until("the grandchild", Duration::from_secs(5), || !lines(&dir, "grandchildren").is_empty());
        let grandchild: i32 = lines(&dir, "grandchildren")[0].parse().unwrap();
        let pid = pids(&dir)[0];
        h.stop();
        let events = lines(&dir, "events");
        let leader_alive = alive(pid);
        let grandchild_gone = {
            let end = Instant::now() + Duration::from_secs(2);
            while alive(grandchild) && Instant::now() < end {
                thread::sleep(Duration::from_millis(10));
            }
            !alive(grandchild)
        };
        cleanup(&dir);
        assert_eq!(events, vec!["term"], "docd gets SIGTERM (its shutdown closes the databases), not SIGKILL");
        assert!(!leader_alive, "the sidecar is gone (and reaped) when stop() returns");
        assert!(grandchild_gone, "processes the sidecar started go with it");
    }

    #[test]
    fn stop_kills_a_sidecar_that_ignores_sigterm_after_the_grace() {
        let dir = fake_sidecar(&format!("trap '' TERM\n{RUN_FOREVER}"));
        let h = start_with(cfg(&dir)).unwrap();
        let pid = pids(&dir)[0];
        let t0 = Instant::now();
        h.stop();
        let took = t0.elapsed();
        let leader_alive = alive(pid);
        cleanup(&dir);
        assert!(!leader_alive);
        assert!(took >= FAST.stop_grace, "it was given the grace period first ({took:?})");
        assert!(took < FAST.stop_grace + Duration::from_secs(2), "then killed ({took:?})");
    }

    #[test]
    fn stop_during_a_respawn_ends_the_new_child_too() {
        // The first incarnation crashes; the second never reports a port, so the monitor is
        // still waiting for it when the app exits.
        let dir = fake_sidecar(
            "if [ \"$(wc -l < \"$D/pids\")\" -le 1 ]; then echo DOCD_PORT=4242; sleep 0.1; exit 1; fi\nwhile :; do sleep 0.05; done",
        );
        let h = start_with(cfg(&dir)).unwrap();
        wait_until("the respawn", Duration::from_secs(5), || pids(&dir).len() >= 2);
        thread::sleep(Duration::from_millis(100));
        let respawned = pids(&dir)[1];
        h.stop();
        let orphaned = alive(respawned);
        cleanup(&dir);
        assert!(!orphaned, "the half-started sidecar must not outlive the app");
    }

    #[test]
    fn restart_brings_the_sidecar_back_after_the_crash_limit() {
        // Start + MAX_RESTARTS respawns all crash; the monitor gives up. A restart (Settings
        // after a config fix) must still work.
        let dir = fake_sidecar(&format!(
            "if [ \"$(wc -l < \"$D/pids\")\" -le 4 ]; then echo DOCD_PORT=4242; sleep 0.05; exit 1; fi\n{RUN_FOREVER}"
        ));
        let h = start_with(cfg(&dir)).unwrap();
        wait_until("the crash limit", Duration::from_secs(5), || pids(&dir).len() >= 4);
        thread::sleep(Duration::from_millis(300));
        let before = pids(&dir).len();
        h.restart();
        let came_back = {
            let end = Instant::now() + Duration::from_secs(3);
            while pids(&dir).len() <= before && Instant::now() < end {
                thread::sleep(Duration::from_millis(10));
            }
            pids(&dir).len() > before
        };
        h.stop();
        cleanup(&dir);
        assert_eq!(before, 4, "gave up after the start and {} respawns", super::MAX_RESTARTS);
        assert!(came_back, "restart() after the crash limit respawns the sidecar");
    }

    #[test]
    fn restart_while_a_respawn_is_starting_restarts_that_new_sidecar() {
        // #1 crashes; #2 is slow to report its port. A restart requested meanwhile (config just
        // changed) must not be spent on the dead #1: #2 started before the request, so it goes.
        let dir = fake_sidecar(&format!(
            "n=$(wc -l < \"$D/pids\")\n\
             if [ \"$n\" -le 1 ]; then echo DOCD_PORT=4242; sleep 0.1; exit 1; fi\n\
             if [ \"$n\" -eq 2 ]; then sleep 0.6; fi\n{RUN_FOREVER}"
        ));
        let h = start_with(cfg(&dir)).unwrap();
        wait_until("the slow respawn", Duration::from_secs(5), || pids(&dir).len() >= 2);
        thread::sleep(Duration::from_millis(100));
        let second = pids(&dir)[1];
        h.restart();
        let third = {
            let end = Instant::now() + Duration::from_secs(3);
            while pids(&dir).len() < 3 && Instant::now() < end {
                thread::sleep(Duration::from_millis(10));
            }
            pids(&dir).len() >= 3
        };
        thread::sleep(Duration::from_millis(200));
        let second_alive = alive(second);
        let count = pids(&dir).len();
        h.stop();
        cleanup(&dir);
        assert!(third, "the restart produced a sidecar that started after it");
        assert!(!second_alive, "the pre-request sidecar was replaced");
        assert_eq!(count, 3, "and exactly once: the request is not left pending");
    }
}
