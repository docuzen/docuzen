//! Paths delivered by macOS open-file events, held until the frontend
//! drains them. Drain semantics make duplicate opens impossible: a path
//! is handed out exactly once.

use std::sync::Mutex;

#[derive(Default)]
pub struct PendingOpens(Mutex<Vec<String>>);

impl PendingOpens {
    pub fn push_all<I: IntoIterator<Item = String>>(&self, paths: I) {
        self.0.lock().unwrap().extend(paths);
    }

    pub fn drain(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::PendingOpens;

    #[test]
    fn drain_returns_pushed_paths_once() {
        let q = PendingOpens::default();
        q.push_all(["/a.md".to_string(), "/b.hadz".to_string()]);
        assert_eq!(q.drain(), vec!["/a.md".to_string(), "/b.hadz".to_string()]);
        assert!(q.drain().is_empty(), "second drain must be empty");
    }

    #[test]
    fn push_after_drain_accumulates_fresh() {
        let q = PendingOpens::default();
        q.push_all(["/a.md".to_string()]);
        q.drain();
        q.push_all(["/c.md".to_string()]);
        assert_eq!(q.drain(), vec!["/c.md".to_string()]);
    }
}
