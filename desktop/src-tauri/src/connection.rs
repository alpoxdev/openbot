//! Where this desktop window should open OpenBot: this computer, or a site already running elsewhere.
//!
//! Stored under the app data directory, next to telemetry, not next to model credentials. Missing,
//! unreadable, and unknown versions are first launch. Never crash because a file is wrong.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::problem::Problem;

pub const FILE: &str = "connection.json";
pub const VERSION: u8 = 1;

const REFUSAL: &str =
    "Enter the https address you use in a browser. Only this computer can use http.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Local,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    version: u8,
    mode: Mode,
    #[serde(
        default,
        rename = "remoteUrl",
        skip_serializing_if = "Option::is_none"
    )]
    remote_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ConnectionMode {
    Unset,
    Local,
    Remote { #[serde(rename = "remoteUrl")] remote_url: String },
}

pub fn store_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

pub fn read(data_dir: &Path) -> ConnectionMode {
    let Ok(bytes) = fs::read(store_path(data_dir)) else {
        return ConnectionMode::Unset;
    };
    let Ok(record) = serde_json::from_slice::<Record>(&bytes) else {
        return ConnectionMode::Unset;
    };
    if record.version != VERSION {
        return ConnectionMode::Unset;
    }
    match record.mode {
        Mode::Local => ConnectionMode::Local,
        Mode::Remote => match record.remote_url.as_deref().map(openbot_site_url) {
            Some(Ok(url)) => ConnectionMode::Remote { remote_url: url },
            _ => ConnectionMode::Unset,
        },
    }
}

pub fn write_local(data_dir: &Path) -> Result<(), Problem> {
    write_record(
        data_dir,
        &Record {
            version: VERSION,
            mode: Mode::Local,
            remote_url: None,
        },
    )
}

pub fn write_remote(data_dir: &Path, url: &str) -> Result<String, Problem> {
    let url = openbot_site_url(url)?;
    write_record(
        data_dir,
        &Record {
            version: VERSION,
            mode: Mode::Remote,
            remote_url: Some(url.clone()),
        },
    )?;
    Ok(url)
}

pub fn clear(data_dir: &Path) -> Result<(), Problem> {
    let path = store_path(data_dir);
    if path.exists() {
        fs::remove_file(&path).map_err(|_| {
            Problem::plain("OpenBot could not forget the saved connection.")
        })?;
    }
    Ok(())
}

pub fn is_remote(data_dir: &Path) -> bool {
    matches!(read(data_dir), ConnectionMode::Remote { .. })
}

pub fn saved_remote_url(data_dir: &Path) -> Option<String> {
    match read(data_dir) {
        ConnectionMode::Remote { remote_url } => Some(remote_url),
        _ => None,
    }
}

/// Whether a later webview navigation (redirect, sign-in) may proceed.
///
/// Setup destinations and `about:blank` stay allowed. Everything else uses the OpenBot-site rule:
/// https, or http only on loopback. Sign-in cookies live on the pasted origin; a bounce through
/// Google is https and is allowed. `javascript:` and LAN http are not.
pub fn navigation_allowed(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed == "about:blank" || trimmed.starts_with("about:") {
        return true;
    }
    if trimmed.starts_with("tauri:") {
        return true;
    }
    if let Ok(parsed) = reqwest::Url::parse(trimmed) {
        if parsed.host_str() == Some("tauri.localhost") {
            return true;
        }
        if parsed.scheme() == "https" && parsed.host_str().is_some() {
            return parsed.username().is_empty() && parsed.password().is_none();
        }
    }
    openbot_site_url(trimmed).is_ok()
}

pub fn openbot_site_url(value: &str) -> Result<String, Problem> {
    if value.chars().any(char::is_control) {
        return Err(Problem::plain(REFUSAL));
    }
    let trimmed = value.trim();
    let parsed = reqwest::Url::parse(trimmed).map_err(|_| Problem::plain(REFUSAL))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(Problem::plain(REFUSAL));
    }
    if parsed.host_str().map(str::is_empty).unwrap_or(true) {
        return Err(Problem::plain(REFUSAL));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(Problem::plain(REFUSAL));
    }
    if parsed.scheme() == "http" && !is_loopback_host(parsed.host_str().unwrap_or("")) {
        return Err(Problem::plain(REFUSAL));
    }
    Ok(trimmed.to_string())
}

fn write_record(data_dir: &Path, record: &Record) -> Result<(), Problem> {
    fs::create_dir_all(data_dir).map_err(|_| {
        Problem::plain("OpenBot could not save where it should open.")
    })?;
    let encoded = serde_json::to_vec(record).map_err(|_| {
        Problem::plain("OpenBot could not save where it should open.")
    })?;
    fs::write(store_path(data_dir), encoded).map_err(|_| {
        Problem::plain("OpenBot could not save where it should open.")
    })
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().trim_matches(|c| c == '[' || c == ']');
    let lower = host.to_ascii_lowercase();
    lower == "localhost" || lower == "127.0.0.1" || lower == "::1"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    #[test]
    fn https_company_host_is_accepted() {
        assert_eq!(
            openbot_site_url("https://openbot.example.com").unwrap(),
            "https://openbot.example.com"
        );
        assert_eq!(
            openbot_site_url("  https://openbot.example.com/app  ").unwrap(),
            "https://openbot.example.com/app"
        );
    }

    #[test]
    fn http_is_only_for_loopback() {
        assert!(openbot_site_url("http://127.0.0.1:3001").is_ok());
        assert!(openbot_site_url("http://localhost:3001").is_ok());
        assert!(openbot_site_url("http://[::1]:3001").is_ok());
        assert!(openbot_site_url("http://192.168.1.9").is_err());
        assert!(openbot_site_url("http://10.0.0.2").is_err());
        assert!(openbot_site_url("http://openbot.example.com").is_err());
    }

    #[test]
    fn javascript_file_data_and_credentials_are_refused() {
        assert!(openbot_site_url("javascript:alert(1)").is_err());
        assert!(openbot_site_url("file:///etc/passwd").is_err());
        assert!(openbot_site_url("data:text/html,hi").is_err());
        assert!(openbot_site_url("https://user:pass@openbot.example.com").is_err());
        assert!(openbot_site_url("  https://openbot.example.com  ").is_ok());
        assert!(openbot_site_url("https://openbot.example.com\u{0007}").is_err());
        assert!(openbot_site_url("").is_err());
        assert!(openbot_site_url("not a url").is_err());
    }

    #[test]
    fn missing_and_corrupt_files_are_first_launch() {
        let dir = temp_root("connection-missing");
        assert_eq!(read(&dir), ConnectionMode::Unset);
        fs::create_dir_all(&dir).unwrap();
        fs::write(store_path(&dir), "{ not json").unwrap();
        assert_eq!(read(&dir), ConnectionMode::Unset);
        fs::write(store_path(&dir), r#"{"version":2,"mode":"local"}"#).unwrap();
        assert_eq!(read(&dir), ConnectionMode::Unset);
        fs::write(
            store_path(&dir),
            r#"{"version":1,"mode":"local","extra":true}"#,
        )
        .unwrap();
        assert_eq!(read(&dir), ConnectionMode::Unset);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn remote_is_revalidated_on_read() {
        let dir = temp_root("connection-revalidate");
        write_remote(&dir, "https://openbot.example.com").unwrap();
        assert_eq!(
            read(&dir),
            ConnectionMode::Remote {
                remote_url: "https://openbot.example.com".into()
            }
        );
        fs::write(
            store_path(&dir),
            r#"{"version":1,"mode":"remote","remoteUrl":"http://192.168.0.9"}"#,
        )
        .unwrap();
        assert_eq!(read(&dir), ConnectionMode::Unset);
        clear(&dir).unwrap();
        assert_eq!(read(&dir), ConnectionMode::Unset);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn local_write_has_no_url() {
        let dir = temp_root("connection-local");
        write_local(&dir).unwrap();
        assert_eq!(read(&dir), ConnectionMode::Local);
        assert!(!is_remote(&dir));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn navigation_allow_list_matches_site_rule_and_setup() {
        assert!(navigation_allowed("about:blank"));
        assert!(navigation_allowed("tauri://localhost/"));
        assert!(navigation_allowed("http://tauri.localhost/"));
        assert!(navigation_allowed("https://accounts.google.com/o/oauth"));
        assert!(navigation_allowed("http://127.0.0.1:3010/"));
        assert!(!navigation_allowed("javascript:alert(1)"));
        assert!(!navigation_allowed("http://192.168.1.9/"));
        assert!(!navigation_allowed("file:///tmp/x"));
    }
}
