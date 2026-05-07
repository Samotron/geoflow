#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> eframe::Result<()> {
    let initial_file: Option<std::path::PathBuf> = std::env::args_os()
        .nth(1)
        .map(std::path::PathBuf::from)
        .filter(|p| p.exists());
    geoflow_desktop::run(initial_file)
}
