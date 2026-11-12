// UNVERIFIED: never compiled (no Rust toolchain in the authoring sandbox). The whole native
// surface of XO Studio, deliberately small:
//   credential_load / credential_save / credential_clear  OS keychain, one opaque string
//   shell_config                                          validated launch configuration
//   login_begin / login_await / open_system_browser       system-browser OIDC login helpers
// No filesystem, shell, process or arbitrary-URL access is exposed to the webview.
// The desktop client is untrusted by the server: nothing here authorizes anything.
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const SERVICE: &str = "dev.xo.studio";
const ACCOUNT: &str = "access-credential";
// Holds a dev key or an OIDC refresh token (as a small JSON envelope).
const MAX_SECRET_LEN: usize = 16384;
const MAX_URL_LEN: usize = 4096;
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

// Error codes are fixed strings the frontend maps; they never contain secret material.
const E_UNAVAILABLE: &str = "unavailable";
const E_INVALID: &str = "invalid";

fn entry() -> Result<keyring::Entry, &'static str> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| E_UNAVAILABLE)
}

/// Validate before touching the keychain: non-empty, bounded, printable, no whitespace.
fn validate_secret(secret: &str) -> Result<(), &'static str> {
    if secret.is_empty() || secret.len() > MAX_SECRET_LEN {
        return Err(E_INVALID);
    }
    if secret.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(E_INVALID);
    }
    Ok(())
}

#[tauri::command]
fn credential_load() -> Result<Option<String>, &'static str> {
    match entry()?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(E_UNAVAILABLE),
    }
}

#[tauri::command]
fn credential_save(secret: String) -> Result<(), &'static str> {
    validate_secret(&secret)?;
    entry()?.set_password(&secret).map_err(|_| E_UNAVAILABLE)
}

#[tauri::command]
fn credential_clear() -> Result<(), &'static str> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(E_UNAVAILABLE),
    }
}

// ---- URL validation (shared by config and browser launch)

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// https, or http only to a loopback host; no embedded credentials; host required.
fn secure_or_loopback(u: &url::Url) -> bool {
    if !u.username().is_empty() || u.password().is_some() {
        return false;
    }
    let Some(host) = u.host_str() else { return false };
    match u.scheme() {
        "https" => true,
        "http" => is_loopback_host(host),
        _ => false,
    }
}

fn validated_api_url(raw: &str) -> Option<String> {
    let u = url::Url::parse(raw.trim()).ok()?;
    // Desktop has no same-origin proxy: the API must be https, or loopback http for local development.
    if !secure_or_loopback(&u) {
        return None;
    }
    if u.query().is_some() || u.fragment().is_some() {
        return None;
    }
    Some(u.as_str().trim_end_matches('/').to_string())
}

fn validated_issuer(raw: &str) -> Option<String> {
    let u = url::Url::parse(raw.trim()).ok()?;
    if !secure_or_loopback(&u) || u.query().is_some() || u.fragment().is_some() {
        return None;
    }
    // Keep the configured spelling: the frontend compares it exactly with the provider's claim.
    Some(raw.trim().to_string())
}

fn validated_client_id(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() || t.len() > 256 || t.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    Some(t.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OidcShellConfig {
    issuer: String,
    client_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    audience: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellConfig {
    api_base_url: Option<String>,
    oidc: Option<OidcShellConfig>,
    dev_sign_in: bool,
    /// Set when a variable was present but invalid, so the UI can fail visibly instead of guessing.
    config_error: Option<String>,
}

/// Launch configuration from the environment. Present-but-invalid values are reported, never
/// silently dropped. No secrets are accepted or returned (a client secret is never configurable).
#[tauri::command]
fn shell_config() -> ShellConfig {
    let mut err: Option<String> = None;
    let api_base_url = match std::env::var("XO_API_URL") {
        Ok(v) => validated_api_url(&v).or_else(|| {
            err = Some("XO_API_URL is not a valid http(s) address".into());
            None
        }),
        Err(_) => None,
    };
    let issuer = std::env::var("XO_OIDC_ISSUER").ok();
    let client = std::env::var("XO_OIDC_CLIENT_ID").ok();
    let oidc = match (issuer, client) {
        (None, None) => None,
        (Some(i), Some(c)) => match (validated_issuer(&i), validated_client_id(&c)) {
            (Some(issuer), Some(client_id)) => Some(OidcShellConfig {
                issuer,
                client_id,
                audience: std::env::var("XO_OIDC_AUDIENCE").ok().filter(|a| !a.trim().is_empty()),
            }),
            _ => {
                err = Some("XO_OIDC_ISSUER or XO_OIDC_CLIENT_ID is invalid".into());
                None
            }
        },
        _ => {
            err = Some("XO_OIDC_ISSUER and XO_OIDC_CLIENT_ID must be set together".into());
            None
        }
    };
    let dev_sign_in = std::env::var("XO_DEV_SIGN_IN").map(|v| v != "0").unwrap_or(true);
    ShellConfig { api_base_url, oidc, dev_sign_in, config_error: err }
}

// ---- system-browser login helpers

/// Only an http(s) page the user will see in their browser: https, or loopback http. The
/// frontend (our own code, under a strict CSP) builds the URL; this is defence in depth.
fn validate_browser_url(raw: &str) -> Result<url::Url, &'static str> {
    if raw.len() > MAX_URL_LEN {
        return Err(E_INVALID);
    }
    let u = url::Url::parse(raw).map_err(|_| E_INVALID)?;
    if !secure_or_loopback(&u) || u.fragment().is_some() {
        return Err(E_INVALID);
    }
    Ok(u)
}

#[tauri::command]
fn open_system_browser(url: String) -> Result<(), &'static str> {
    let u = validate_browser_url(&url)?;
    open::that(u.as_str()).map_err(|_| E_UNAVAILABLE)
}

struct LoginState(Mutex<Option<TcpListener>>);

/// Bind a one-shot loopback listener on an OS-chosen port (RFC 8252 §7.3).
#[tauri::command]
fn login_begin(state: tauri::State<LoginState>) -> Result<String, &'static str> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| E_UNAVAILABLE)?;
    listener.set_nonblocking(true).map_err(|_| E_UNAVAILABLE)?;
    let port = listener.local_addr().map_err(|_| E_UNAVAILABLE)?.port();
    *state.0.lock().map_err(|_| E_UNAVAILABLE)? = Some(listener); // drops any previous listener
    Ok(format!("http://127.0.0.1:{port}/callback"))
}

/// Wait (bounded) for exactly the callback request and return its raw query string. The result
/// is UNTRUSTED: the frontend must match its `state` to the attempt in progress.
#[tauri::command]
async fn login_await(state: tauri::State<'_, LoginState>) -> Result<String, &'static str> {
    let listener = state.0.lock().map_err(|_| E_UNAVAILABLE)?.take().ok_or(E_INVALID)?;
    tauri::async_runtime::spawn_blocking(move || wait_for_callback(listener, LOGIN_TIMEOUT))
        .await
        .map_err(|_| E_UNAVAILABLE)?
}

fn wait_for_callback(listener: TcpListener, timeout: Duration) -> Result<String, &'static str> {
    let port = listener.local_addr().map_err(|_| E_UNAVAILABLE)?.port();
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let head = read_head(&mut stream);
                match head.as_deref().and_then(|h| parse_callback_request(h, port)) {
                    Some(query) => {
                        respond(&mut stream, 200, "Signed in. You can close this window and return to XO Studio.");
                        return Ok(query);
                    }
                    // A stray or malicious local request cannot end the wait or inject a result.
                    None => respond(&mut stream, 400, "Unexpected request."),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return Err(E_UNAVAILABLE),
        }
    }
    Err("timeout")
}

fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while buf.len() < 8192 {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8(buf).ok()
}

fn respond(stream: &mut TcpStream, status: u16, text: &str) {
    let reason = if status == 200 { "OK" } else { "Bad Request" };
    let body = format!("<!doctype html><meta charset=utf-8><title>XO Studio</title><p>{text}</p>");
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
}

/// Accept only `GET /callback?<query>` addressed to our own loopback host:port (rebinding defence).
fn parse_callback_request(head: &str, port: u16) -> Option<String> {
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    if first.next()? != "GET" {
        return None;
    }
    let target = first.next()?;
    let (path, query) = target.split_once('?')?;
    if path != "/callback" || query.is_empty() || query.len() > 4096 {
        return None;
    }
    if query.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let host_ok = lines.any(|l| {
        l.split_once(':').map_or(false, |(k, v)| {
            k.eq_ignore_ascii_case("host") && {
                let v = v.trim();
                v == format!("127.0.0.1:{port}") || v == format!("localhost:{port}")
            }
        })
    });
    host_ok.then(|| query.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(LoginState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            credential_load,
            credential_save,
            credential_clear,
            shell_config,
            login_begin,
            login_await,
            open_system_browser
        ])
        .run(tauri::generate_context!())
        .expect("error while running XO Studio");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_validated() {
        assert!(validate_secret("xoak_abc").is_ok());
        assert!(validate_secret(r#"{"v":1,"kind":"dev-key","key":"x"}"#).is_ok());
        assert!(validate_secret("").is_err());
        assert!(validate_secret("a b").is_err());
        assert!(validate_secret("a\nb").is_err());
        assert!(validate_secret(&"x".repeat(MAX_SECRET_LEN + 1)).is_err());
    }

    #[test]
    fn api_urls_are_validated() {
        assert_eq!(validated_api_url("https://xo.example.com/api/").as_deref(), Some("https://xo.example.com/api"));
        assert!(validated_api_url("file:///etc/passwd").is_none());
        assert!(validated_api_url("https://u:p@h/").is_none());
        assert!(validated_api_url("https://h/api?x=1").is_none());
        assert!(validated_api_url("/api").is_none());
    }

    #[test]
    fn issuers_and_clients_are_validated() {
        assert!(validated_issuer("https://idp.example.com/realm").is_some());
        assert!(validated_issuer("http://127.0.0.1:8081/r").is_some());
        assert!(validated_issuer("http://idp.example.com").is_none());
        assert!(validated_issuer("https://u:p@idp.example.com").is_none());
        assert!(validated_client_id("studio").is_some());
        assert!(validated_client_id("a b").is_none());
        assert!(validated_client_id("").is_none());
    }

    #[test]
    fn browser_urls_are_restricted() {
        assert!(validate_browser_url("https://idp.example.com/authorize?x=1").is_ok());
        assert!(validate_browser_url("http://127.0.0.1:9/x").is_ok());
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "http://evil.example.com/", "https://u:p@h/", "ms-msdt:/x", "https://h/#f"] {
            assert!(validate_browser_url(bad).is_err(), "{bad}");
        }
        assert!(validate_browser_url(&format!("https://h/{}", "a".repeat(MAX_URL_LEN))).is_err());
    }

    #[test]
    fn callback_requests_are_strictly_matched() {
        let ok = "GET /callback?code=a&state=b HTTP/1.1\r\nHost: 127.0.0.1:5000\r\n\r\n";
        assert_eq!(parse_callback_request(ok, 5000).as_deref(), Some("code=a&state=b"));
        assert!(parse_callback_request("GET /callback?code=a HTTP/1.1\r\nHost: localhost:5000\r\n\r\n", 5000).is_some());
        // wrong method, path, host (DNS rebinding), port, or missing query
        assert!(parse_callback_request("POST /callback?a=b HTTP/1.1\r\nHost: 127.0.0.1:5000\r\n\r\n", 5000).is_none());
        assert!(parse_callback_request("GET /other?a=b HTTP/1.1\r\nHost: 127.0.0.1:5000\r\n\r\n", 5000).is_none());
        assert!(parse_callback_request("GET /callback?a=b HTTP/1.1\r\nHost: evil.example.com:5000\r\n\r\n", 5000).is_none());
        assert!(parse_callback_request("GET /callback?a=b HTTP/1.1\r\nHost: 127.0.0.1:5001\r\n\r\n", 5000).is_none());
        assert!(parse_callback_request("GET /callback HTTP/1.1\r\nHost: 127.0.0.1:5000\r\n\r\n", 5000).is_none());
    }
}
