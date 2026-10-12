// UNVERIFIED. Registers the app's own commands so capabilities can grant them individually.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "credential_load",
                "credential_save",
                "credential_clear",
                "shell_config",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
