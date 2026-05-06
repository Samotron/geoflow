//! GeoFlow Desktop — AGS validator and file-management GUI.
//!
//! Feature parity with the Python AGS4 Validator Desktop App:
//!   • Open / drag-drop AGS files
//!   • Validate with built-in rule set, per-diagnostic display
//!   • SHA-256 hash generation + clipboard copy + comparison
//!   • Export AGS → XLSX (one sheet per group) or → CSV (one file per group)
//!   • Import XLSX → AGS (each sheet = group; rows: HEADING, UNIT, TYPE, DATA…)

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::mpsc;

use eframe::egui::{self, Color32, RichText, ScrollArea};
use geoflow_core::{ags, model::AgsFile, Diagnostic, Severity};
use sha2::{Digest, Sha256};

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("GeoFlow Desktop")
            .with_inner_size([900.0, 650.0])
            .with_min_inner_size([640.0, 480.0])
            .with_drag_and_drop(true),
        ..Default::default()
    };
    eframe::run_native(
        "GeoFlow Desktop",
        options,
        Box::new(|_cc| Ok(Box::new(GeoflowApp::default()))),
    )
}

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tab {
    Validate,
    Hash,
    Export,
    Import,
}

enum TaskResult {
    Validated(Vec<Diagnostic>),
    Exported(Result<PathBuf, String>),
    Imported(Result<PathBuf, String>),
}

struct LoadedFile {
    path: PathBuf,
    bytes: Vec<u8>,
    ags: AgsFile,
    parse_diags: Vec<Diagnostic>,
}

// ── App state ─────────────────────────────────────────────────────────────────

struct GeoflowApp {
    loaded: Option<LoadedFile>,
    load_error: Option<String>,

    tab: Tab,

    // Validate tab
    validation: Option<Vec<Diagnostic>>,
    /// User-supplied pack specs: either an absolute file path or a built-in
    /// reference such as `ice:mini@0.1`.
    rule_packs: Vec<String>,
    /// Built-in pack refs discovered at startup (may be empty in installed builds).
    builtin_packs: Vec<String>,

    // Hash tab
    file_hash: Option<String>,
    compare_input: String,
    hash_match: Option<bool>,

    // Export / Import tabs
    export_status: Option<Result<PathBuf, String>>,
    import_status: Option<Result<PathBuf, String>>,

    // At most one background task at a time.
    task_rx: Option<mpsc::Receiver<TaskResult>>,
}

impl Default for GeoflowApp {
    fn default() -> Self {
        Self {
            loaded: None,
            load_error: None,
            tab: Tab::Validate,
            validation: None,
            file_hash: None,
            compare_input: String::new(),
            hash_match: None,
            export_status: None,
            import_status: None,
            rule_packs: Vec::new(),
            builtin_packs: geoflow_core::dsl::installed_pack_refs(),
            task_rx: None,
        }
    }
}

// ── File loading ──────────────────────────────────────────────────────────────

impl GeoflowApp {
    fn open_dialog(&mut self) {
        if let Some(path) = rfd::FileDialog::new()
            .add_filter("AGS Files", &["ags"])
            .add_filter("All Files", &["*"])
            .pick_file()
        {
            self.load_file(path);
        }
    }

    fn load_file(&mut self, path: PathBuf) {
        match std::fs::read(&path) {
            Err(e) => {
                self.load_error = Some(format!("{}: {e}", path.display()));
                self.loaded = None;
            }
            Ok(bytes) => {
                let outcome = ags::parse_bytes(&bytes);
                self.loaded = Some(LoadedFile {
                    path,
                    bytes,
                    ags: outcome.file,
                    parse_diags: outcome.diagnostics,
                });
                self.load_error = None;
                self.validation = None;
                self.file_hash = None;
                self.hash_match = None;
                self.export_status = None;
                self.import_status = None;
                self.task_rx = None;
            }
        }
    }
}

// ── Background tasks ──────────────────────────────────────────────────────────

impl GeoflowApp {
    fn busy(&self) -> bool {
        self.task_rx.is_some()
    }

    fn poll(&mut self) {
        let result = self.task_rx.as_ref().and_then(|rx| rx.try_recv().ok());
        if let Some(r) = result {
            self.task_rx = None;
            match r {
                TaskResult::Validated(d) => self.validation = Some(d),
                TaskResult::Exported(r) => self.export_status = Some(r),
                TaskResult::Imported(r) => self.import_status = Some(r),
            }
        }
    }

    fn run_validation(&mut self, ctx: egui::Context) {
        let Some(f) = &self.loaded else { return };
        let ags = f.ags.clone();
        let parse_diags = f.parse_diags.clone();
        let pack_specs = self.rule_packs.clone();
        let (tx, rx) = mpsc::sync_channel(1);
        self.task_rx = Some(rx);
        std::thread::spawn(move || {
            let registry = geoflow_core::Registry::standard();
            let mut diags = parse_diags;
            diags.extend(geoflow_core::validate(&ags, &registry));

            for spec in &pack_specs {
                match geoflow_core::dsl::RulePack::load_spec(spec) {
                    Ok(pack) => match geoflow_core::dsl::evaluate(&ags, &pack) {
                        Ok(pd) => diags.extend(pd),
                        Err(e) => diags.push(Diagnostic::new(
                            "RULE-PACK-ERR",
                            Severity::Error,
                            format!("pack {spec:?}: {e}"),
                        )),
                    },
                    Err(e) => diags.push(Diagnostic::new(
                        "RULE-PACK-ERR",
                        Severity::Error,
                        format!("could not load {spec:?}: {e}"),
                    )),
                }
            }

            let _ = tx.send(TaskResult::Validated(diags));
            ctx.request_repaint();
        });
    }

    fn compute_hash(&mut self) {
        let Some(f) = &self.loaded else { return };
        let mut h = Sha256::new();
        h.update(&f.bytes);
        self.file_hash = Some(hex::encode(h.finalize()));
    }

    fn start_export_xlsx(&mut self, ctx: egui::Context) {
        let Some(f) = &self.loaded else { return };
        let ags = f.ags.clone();
        let stem = f
            .path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("export")
            .to_owned();

        let Some(dest) = rfd::FileDialog::new()
            .add_filter("Excel Workbook", &["xlsx"])
            .set_file_name(format!("{stem}.xlsx"))
            .save_file()
        else {
            return;
        };

        let (tx, rx) = mpsc::sync_channel(1);
        self.task_rx = Some(rx);
        std::thread::spawn(move || {
            let r = write_xlsx(&ags, &dest).map(|_| dest).map_err(|e| e.to_string());
            let _ = tx.send(TaskResult::Exported(r));
            ctx.request_repaint();
        });
    }

    fn start_export_csv(&mut self, ctx: egui::Context) {
        let Some(f) = &self.loaded else { return };
        let ags = f.ags.clone();
        let stem = f
            .path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("export")
            .to_owned();

        let Some(dir) = rfd::FileDialog::new().pick_folder() else {
            return;
        };

        let (tx, rx) = mpsc::sync_channel(1);
        self.task_rx = Some(rx);
        std::thread::spawn(move || {
            let csvs = geoflow_core::export::to_csv(&ags);
            let mut last = dir.clone();
            for (group, csv) in &csvs {
                let p = dir.join(format!("{stem}_{group}.csv"));
                if let Err(e) = std::fs::write(&p, csv) {
                    let _ = tx.send(TaskResult::Exported(Err(e.to_string())));
                    ctx.request_repaint();
                    return;
                }
                last = p;
            }
            let _ = tx.send(TaskResult::Exported(Ok(last)));
            ctx.request_repaint();
        });
    }

    fn start_import_xlsx(&mut self, ctx: egui::Context) {
        let Some(src) = rfd::FileDialog::new()
            .add_filter("Excel Workbook", &["xlsx", "xls"])
            .pick_file()
        else {
            return;
        };
        let default_name = src
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| format!("{s}.ags"))
            .unwrap_or_else(|| "output.ags".into());
        let Some(dest) = rfd::FileDialog::new()
            .add_filter("AGS File", &["ags"])
            .set_file_name(default_name)
            .save_file()
        else {
            return;
        };

        let (tx, rx) = mpsc::sync_channel(1);
        self.task_rx = Some(rx);
        std::thread::spawn(move || {
            let r = xlsx_to_ags(&src, &dest).map(|_| dest).map_err(|e| e.to_string());
            let _ = tx.send(TaskResult::Imported(r));
            ctx.request_repaint();
        });
    }
}

// ── eframe::App ───────────────────────────────────────────────────────────────

impl eframe::App for GeoflowApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll();

        // Accept drag-and-drop
        let dropped = ctx.input(|i| i.raw.dropped_files.clone());
        if let Some(f) = dropped.into_iter().next() {
            if let Some(path) = f.path {
                self.load_file(path);
            }
        }

        // ── Header strip ─────────────────────────────────────────────────────
        egui::TopBottomPanel::top("header").show(ctx, |ui| {
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                if ui.button("Open File…").clicked() {
                    self.open_dialog();
                }
                match &self.loaded {
                    Some(f) => {
                        ui.label(f.path.display().to_string());
                        if let Some(v) = &f.ags.ags_version {
                            ui.separator();
                            ui.label(format!("AGS {v}"));
                        }
                        let groups = f.ags.groups.len();
                        let rows: usize = f.ags.groups.values().map(|g| g.rows.len()).sum();
                        ui.separator();
                        ui.label(format!("{groups} groups · {rows} data rows"));
                    }
                    None => {
                        ui.label(
                            RichText::new("No file loaded — open or drop an AGS file here")
                                .color(Color32::GRAY),
                        );
                    }
                }
            });
            if let Some(err) = &self.load_error.clone() {
                ui.label(RichText::new(format!("Error: {err}")).color(Color32::RED));
            }
            ui.add_space(4.0);
        });

        // ── Tab bar ───────────────────────────────────────────────────────────
        egui::TopBottomPanel::top("tabs").show(ctx, |ui| {
            ui.add_space(2.0);
            ui.horizontal(|ui| {
                ui.selectable_value(&mut self.tab, Tab::Validate, "Validate");
                ui.selectable_value(&mut self.tab, Tab::Hash, "Hash");
                ui.selectable_value(&mut self.tab, Tab::Export, "Export");
                ui.selectable_value(&mut self.tab, Tab::Import, "Import from XLSX");
            });
            ui.add_space(2.0);
        });

        // ── Tab content ───────────────────────────────────────────────────────
        egui::CentralPanel::default().show(ctx, |ui| {
            let ctx2 = ctx.clone();
            match self.tab {
                Tab::Validate => self.tab_validate(ui, ctx2),
                Tab::Hash => self.tab_hash(ui, &ctx2),
                Tab::Export => self.tab_export(ui, ctx2),
                Tab::Import => self.tab_import(ui, ctx2),
            }
        });
    }
}

// ── Tab: Validate ─────────────────────────────────────────────────────────────

impl GeoflowApp {
    fn tab_validate(&mut self, ui: &mut egui::Ui, ctx: egui::Context) {
        let has_file = self.loaded.is_some();
        let busy = self.busy();

        ui.horizontal(|ui| {
            ui.add_enabled_ui(has_file && !busy, |ui| {
                if ui.button("Run Validation").clicked() {
                    self.run_validation(ctx);
                }
            });
            if busy {
                ui.spinner();
                ui.label("Validating…");
            }
        });

        // ── Rule packs ────────────────────────────────────────────────────────
        egui::CollapsingHeader::new("Rule packs")
            .default_open(!self.rule_packs.is_empty())
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    if ui.button("Add YAML file…").clicked() {
                        if let Some(path) = rfd::FileDialog::new()
                            .add_filter("YAML rule pack", &["yml", "yaml"])
                            .pick_file()
                        {
                            let spec = path.display().to_string();
                            if !self.rule_packs.contains(&spec) {
                                self.rule_packs.push(spec);
                                self.validation = None;
                            }
                        }
                    }

                    // Built-in packs combo (only shown when any exist)
                    if !self.builtin_packs.is_empty() {
                        egui::ComboBox::from_id_salt("builtin_packs")
                            .selected_text("Add built-in pack…")
                            .show_ui(ui, |ui| {
                                let packs = self.builtin_packs.clone();
                                for pack_ref in &packs {
                                    let already = self.rule_packs.contains(pack_ref);
                                    let mut selected = already;
                                    ui.toggle_value(&mut selected, pack_ref);
                                    if selected && !already {
                                        self.rule_packs.push(pack_ref.clone());
                                        self.validation = None;
                                    } else if !selected && already {
                                        self.rule_packs.retain(|r| r != pack_ref);
                                        self.validation = None;
                                    }
                                }
                            });
                    }
                });

                if self.rule_packs.is_empty() {
                    ui.label(
                        RichText::new("No custom packs — only built-in rules will run.")
                            .color(Color32::GRAY)
                            .small(),
                    );
                } else {
                    let mut to_remove: Option<usize> = None;
                    for (i, spec) in self.rule_packs.iter().enumerate() {
                        ui.horizontal(|ui| {
                            if ui.small_button("×").clicked() {
                                to_remove = Some(i);
                            }
                            ui.label(RichText::new(spec).monospace().small());
                        });
                    }
                    if let Some(i) = to_remove {
                        self.rule_packs.remove(i);
                        self.validation = None;
                    }
                }
            });

        ui.separator();

        if !has_file {
            ui.label("Open an AGS file to validate it.");
            return;
        }

        let Some(diags) = &self.validation else {
            ui.label("Click \"Run Validation\" to check the loaded file.");
            return;
        };

        // Summary bar
        let errors = diags.iter().filter(|d| d.severity == Severity::Error).count();
        let warnings = diags.iter().filter(|d| d.severity == Severity::Warning).count();
        let infos = diags.iter().filter(|d| d.severity == Severity::Info).count();

        ui.horizontal(|ui| {
            if errors == 0 && warnings == 0 {
                ui.label(RichText::new("✓ No issues found").color(Color32::GREEN).strong());
            } else {
                if errors > 0 {
                    ui.label(
                        RichText::new(format!("{errors} error(s)"))
                            .color(Color32::RED)
                            .strong(),
                    );
                }
                if warnings > 0 {
                    ui.label(
                        RichText::new(format!("{warnings} warning(s)"))
                            .color(Color32::from_rgb(220, 160, 0))
                            .strong(),
                    );
                }
                if infos > 0 {
                    ui.label(
                        RichText::new(format!("{infos} info"))
                            .color(Color32::from_rgb(80, 160, 220)),
                    );
                }
            }
        });
        ui.separator();

        let diags = diags.clone();
        ScrollArea::vertical().auto_shrink(false).show(ui, |ui| {
            for diag in &diags {
                let (icon, color) = match diag.severity {
                    Severity::Error => ("✗", Color32::RED),
                    Severity::Warning => ("⚠", Color32::from_rgb(220, 160, 0)),
                    Severity::Info => ("i", Color32::from_rgb(80, 160, 220)),
                };
                ui.horizontal_wrapped(|ui| {
                    ui.label(RichText::new(icon).color(color).strong().monospace());
                    ui.label(RichText::new(&diag.rule_id).monospace().color(Color32::GRAY));
                    ui.label(&diag.message);
                    if let Some(group) = &diag.location.group {
                        ui.label(
                            RichText::new(format!("[{group}]"))
                                .color(Color32::GRAY)
                                .small(),
                        );
                    }
                    if let Some(line) = diag.location.line {
                        ui.label(
                            RichText::new(format!("line {line}"))
                                .color(Color32::GRAY)
                                .small(),
                        );
                    }
                });
            }
        });
    }
}

// ── Tab: Hash ─────────────────────────────────────────────────────────────────

impl GeoflowApp {
    fn tab_hash(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        if self.loaded.is_none() {
            ui.label("Open an AGS file to compute its hash.");
            return;
        }

        ui.horizontal(|ui| {
            if ui.button("Compute SHA-256").clicked() {
                self.compute_hash();
            }
        });
        ui.separator();

        if let Some(hash) = self.file_hash.clone() {
            ui.label("File hash (SHA-256):");
            ui.horizontal(|ui| {
                ui.monospace(&hash);
                if ui.button("Copy to Clipboard").clicked() {
                    ctx.copy_text(hash.clone());
                }
            });

            ui.add_space(12.0);
            ui.separator();
            ui.strong("Verify Hash");
            ui.label("Paste a reference hash to confirm the file has not been modified:");
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.text_edit_singleline(&mut self.compare_input);
                if ui.button("Compare").clicked() {
                    let trimmed = self.compare_input.trim().to_lowercase();
                    self.hash_match = Some(trimmed == hash.to_lowercase());
                }
            });

            if let Some(matched) = self.hash_match {
                ui.add_space(8.0);
                if matched {
                    ui.label(
                        RichText::new("✓ Hashes match — file has not been modified")
                            .color(Color32::GREEN)
                            .strong(),
                    );
                } else {
                    ui.label(
                        RichText::new("✗ Hashes do not match — file may have been modified")
                            .color(Color32::RED)
                            .strong(),
                    );
                }
            }
        } else {
            ui.label("Click \"Compute SHA-256\" to generate the hash for this file.");
        }
    }
}

// ── Tab: Export ───────────────────────────────────────────────────────────────

impl GeoflowApp {
    fn tab_export(&mut self, ui: &mut egui::Ui, ctx: egui::Context) {
        if self.loaded.is_none() {
            ui.label("Open an AGS file to export it.");
            return;
        }
        let busy = self.busy();

        ui.label("Export the loaded AGS file to another format:");
        ui.add_space(8.0);

        ui.add_enabled_ui(!busy, |ui| {
            if ui.button("Export to XLSX…").clicked() {
                self.start_export_xlsx(ctx.clone());
            }
            ui.add_space(4.0);
            if ui.button("Export to CSV (choose folder)…").clicked() {
                self.start_export_csv(ctx);
            }
        });

        if busy {
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                ui.spinner();
                ui.label("Exporting…");
            });
        }

        if let Some(status) = &self.export_status {
            ui.separator();
            match status {
                Ok(p) => {
                    ui.label(
                        RichText::new(format!("✓ Saved: {}", p.display()))
                            .color(Color32::GREEN),
                    );
                }
                Err(e) => {
                    ui.label(
                        RichText::new(format!("✗ Export failed: {e}")).color(Color32::RED),
                    );
                }
            }
        }
    }
}

// ── Tab: Import ───────────────────────────────────────────────────────────────

impl GeoflowApp {
    fn tab_import(&mut self, ui: &mut egui::Ui, ctx: egui::Context) {
        let busy = self.busy();

        ui.label("Convert an XLSX file with AGS-structured sheets into an AGS 4 file.");
        ui.label(
            RichText::new(
                "Each sheet must have rows in order: HEADING, UNIT, TYPE, then DATA rows. \
                 The first column of each row should be the row type marker.",
            )
            .color(Color32::GRAY)
            .small(),
        );
        ui.add_space(8.0);

        ui.add_enabled_ui(!busy, |ui| {
            if ui.button("Open XLSX and Convert to AGS…").clicked() {
                self.start_import_xlsx(ctx.clone());
            }
        });

        if busy {
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                ui.spinner();
                ui.label("Converting…");
            });
        }

        if let Some(status) = self.import_status.clone() {
            ui.separator();
            match status {
                Ok(ref path) => {
                    ui.label(
                        RichText::new(format!("✓ Saved: {}", path.display()))
                            .color(Color32::GREEN),
                    );
                    if ui.button("Open converted file in GeoFlow").clicked() {
                        let p = path.clone();
                        self.load_file(p);
                        self.tab = Tab::Validate;
                    }
                }
                Err(ref e) => {
                    ui.label(
                        RichText::new(format!("✗ Conversion failed: {e}")).color(Color32::RED),
                    );
                }
            }
        }
    }
}

// ── XLSX export ───────────────────────────────────────────────────────────────

fn write_xlsx(file: &AgsFile, path: &Path) -> anyhow::Result<()> {
    use geoflow_core::model::AgsValue;
    use rust_xlsxwriter::Workbook;

    let mut workbook = Workbook::new();

    for (group_name, group) in &file.groups {
        let ws = workbook.add_worksheet();
        ws.set_name(group_name)?;

        let names: Vec<&str> = group.headings.iter().map(|h| h.name.as_str()).collect();

        // HEADING row: col-0 = "HEADING", then heading names
        ws.write(0, 0, "HEADING")?;
        for (c, n) in names.iter().enumerate() {
            ws.write(0, (c + 1) as u16, *n)?;
        }

        // UNIT row
        ws.write(1, 0, "UNIT")?;
        for (c, h) in group.headings.iter().enumerate() {
            ws.write(1, (c + 1) as u16, h.unit.as_str())?;
        }

        // TYPE row
        ws.write(2, 0, "TYPE")?;
        for (c, h) in group.headings.iter().enumerate() {
            ws.write(2, (c + 1) as u16, ags_type_str(&h.data_type).as_str())?;
        }

        // DATA rows
        for (r, row) in group.rows.iter().enumerate() {
            ws.write((r + 3) as u32, 0, "DATA")?;
            for (c, n) in names.iter().enumerate() {
                let cell = match row.get(*n) {
                    None | Some(AgsValue::Null) => String::new(),
                    Some(AgsValue::Number(f)) => fmt_f64(*f),
                    Some(AgsValue::Bool(true)) => "Y".into(),
                    Some(AgsValue::Bool(false)) => "N".into(),
                    Some(AgsValue::Text(s) | AgsValue::Raw(s)) => s.clone(),
                };
                ws.write((r + 3) as u32, (c + 1) as u16, cell.as_str())?;
            }
        }
    }

    workbook.save(path)?;
    Ok(())
}

fn ags_type_str(t: &geoflow_core::model::AgsType) -> String {
    use geoflow_core::model::AgsType;
    match t {
        AgsType::X => "X".into(),
        AgsType::XN => "XN".into(),
        AgsType::MC => "MC".into(),
        AgsType::ID => "ID".into(),
        AgsType::PA => "PA".into(),
        AgsType::PT => "PT".into(),
        AgsType::PU => "PU".into(),
        AgsType::T => "T".into(),
        AgsType::DT => "DT".into(),
        AgsType::YN => "YN".into(),
        AgsType::RL => "RL".into(),
        AgsType::U => "U".into(),
        AgsType::RecordLink => "RECORD_LINK".into(),
        AgsType::Dp(n) => format!("{n}DP"),
        AgsType::Sf(n) => format!("{n}SF"),
        AgsType::Sci(n) => format!("{n}SCI"),
        AgsType::Other(s) => s.clone(),
    }
}

fn fmt_f64(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

// ── XLSX import ───────────────────────────────────────────────────────────────

fn xlsx_to_ags(src: &Path, dest: &Path) -> anyhow::Result<()> {
    use calamine::{Reader, open_workbook_auto};

    let mut wb = open_workbook_auto(src)?;
    let sheets = wb.sheet_names().to_vec();

    let mut out = String::new();

    for sheet in &sheets {
        let range = wb
            .worksheet_range(sheet)
            .map_err(|e| anyhow::anyhow!("sheet \"{sheet}\": {e}"))?;

        let rows: Vec<Vec<String>> = range
            .rows()
            .map(|row| row.iter().map(cell_str).collect())
            .collect();

        if rows.len() < 3 {
            continue; // need at least HEADING + UNIT + TYPE
        }

        // Detect whether col-0 carries the row-kind marker.
        let has_marker = matches!(
            rows[0].first().map(|s| s.to_ascii_uppercase()),
            Some(ref s) if s == "HEADING"
        );
        let col_start: usize = if has_marker { 1 } else { 0 };

        out.push_str(&format!("\"GROUP\",\"{}\"\n", esc(sheet)));

        for (kind, row) in [("HEADING", &rows[0]), ("UNIT", &rows[1]), ("TYPE", &rows[2])] {
            out.push_str(&format!("\"{}\"", kind));
            for cell in &row[col_start..] {
                out.push_str(&format!(",\"{}\"", esc(cell)));
            }
            out.push('\n');
        }

        for row in rows.iter().skip(3) {
            // Skip rows whose first cell is a section marker we don't understand.
            let first_up = row.first().map(|s| s.to_ascii_uppercase());
            if has_marker
                && matches!(first_up.as_deref(), Some("HEADING") | Some("UNIT") | Some("TYPE"))
            {
                continue;
            }
            out.push_str("\"DATA\"");
            for cell in &row[col_start..] {
                out.push_str(&format!(",\"{}\"", esc(cell)));
            }
            out.push('\n');
        }

        out.push('\n');
    }

    std::fs::write(dest, out)?;
    Ok(())
}

fn cell_str(cell: &calamine::Data) -> String {
    use calamine::Data;
    match cell {
        Data::String(s) => s.clone(),
        Data::Float(f) => fmt_f64(*f),
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => if *b { "Y" } else { "N" }.to_string(),
        Data::DateTime(dt) => dt.to_string(),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(_) | Data::Empty => String::new(),
    }
}

fn esc(s: &str) -> String {
    s.replace('"', "\"\"")
}
