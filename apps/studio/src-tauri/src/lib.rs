// UNVERIFIED: never compiled. The only native surface of XO Studio:
// credential load/save/clear (OS keychain) and shell config. No filesystem, shell or
// process access is exposed to the webview.
use serde::Serialize;

const SERVICE: &str = "dev.xo.studio";
const ACCOUNT: &str = "access-credential";
const MAX_SECRET_LEN: usize = 4096;

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| "credential store unavailable".to_string())
}

/// Validate before touching the keychain: non-empty, bounded, printable, no whitespace.
fn validate_secret(secret: &str) -> Result<(), String> {
    if secret.is_empty() || secret.len() > MAX_SECRET_LEN {
        return Err("credential has an invalid length".into());
    }
    if secret.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("credential contains invalid characters".into());
    }
    Ok(())
}

#[tauri::command]
fn credential_load() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("credential store unavailable".into()),
    }
}

#[tauri::command]
fn credential_save(secret: String) -> Result<(), String> {
    validate_secret(&secret)?;
    entry()?.set_password(&secret).map_err(|_| "credential store unavailable".to_string())
}

#[tauri::command]
fn credential_clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("credential store unavailable".into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellConfig {
    api_base_url: Option<String>,
}

/// API address comes from the environment at launch (a config file is a reasonable
/// extension). Only absolute http(s) URLs without credentials/query/fragment pass.
fn validated_api_url(raw: &str) -> Option<String> {
    let u = url::Url::parse(raw.trim()).ok()?;
    let ok_scheme = matches!(u.scheme(), "http" | "https");
    if !ok_scheme || u.host_str().is_none() || !u.username().is_empty() || u.password().is_some()
        || u.query().is_some() || u.fragment().is_some()
    {
        return None;
    }
    Some(u.as_str().trim_end_matches('/').to_string())
}

#[tauri::command]
fn shell_config() -> ShellConfig {
    let api_base_url = std::env::var("XO_API_URL").ok().and_then(|v| validated_api_url(&v));
    ShellConfig { api_base_url }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            credential_load,
            credential_save,
            credential_clear,
            shell_config
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
        assert!(validated_api_url("/api").is_none());
    }
}
