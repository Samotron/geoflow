//! `geoflow` CLI entry point.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use geoflow_core::{
    ags, describe,
    render::{self, Format},
    validate, Registry, Severity,
};

#[derive(Debug, Parser)]
#[command(
    name = "geoflow",
    version,
    about = "Geotechnical data toolkit (AGS, DIGGS, validation)"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,

    /// Reduce log output.
    #[arg(long, global = true)]
    quiet: bool,

    /// Increase log output (repeatable).
    #[arg(short, long, global = true, action = clap::ArgAction::Count)]
    verbose: u8,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Print a quick summary of an AGS file.
    Info {
        /// Path to the AGS file.
        file: PathBuf,
    },
    /// Validate an AGS file against the built-in rules.
    Validate {
        /// AGS files to validate.
        #[arg(required = true)]
        files: Vec<PathBuf>,
        /// Custom rule packs (YAML) or built-in references like ice:mini@0.1.
        #[arg(short, long)]
        rules: Vec<String>,
        /// Output format.
        #[arg(long, default_value = "text")]
        format: String,
        /// Exit non-zero if any diagnostic at or above this severity fires.
        #[arg(long, default_value = "error")]
        fail_on: String,
        /// Path to a custom dictionary YAML (merged with the standard AGS dict).
        #[arg(long)]
        dict: Option<PathBuf>,
        /// Also run cross-file consistency checks when multiple files are given.
        #[arg(long)]
        cross_file: bool,
    },
    /// Inspect the built-in rule registry.
    Rules {
        #[command(subcommand)]
        action: RulesAction,
    },
    /// Automatically fix safe issues in an AGS file.
    Fix {
        /// Path to the AGS file.
        file: PathBuf,
        /// Apply changes to the file.
        #[arg(long, conflicts_with = "dry_run")]
        write: bool,
        /// Preview changes without writing them.
        #[arg(long)]
        dry_run: bool,
        /// Custom rule packs (YAML) or built-in references like ice:mini@0.1.
        #[arg(short, long)]
        rules: Vec<String>,
    },
    /// Convert geotechnical data between formats (AGS/DIGGS/GeoJSON/KML).
    Convert {
        /// Input file.
        input: PathBuf,
        /// Output file.
        output: PathBuf,
        /// Target format: ags, diggs, json, geojson, kml.
        #[arg(long)]
        to: String,
        /// Source format override: ags3 to parse an AGS 3 input file.
        #[arg(long)]
        from: Option<String>,
        /// Path to write a lossy-conversion report.
        #[arg(long)]
        report: Option<PathBuf>,
        /// Convert depth columns to Reduced Level using LOCA_GL.
        #[arg(long)]
        datum_rl: bool,
    },
    /// Upgrade an AGS 3 file to AGS 4 format.
    UpgradeFormat {
        /// AGS 3 input file.
        input: PathBuf,
        /// AGS 4 output file.
        output: PathBuf,
        /// Print migration notes.
        #[arg(long)]
        notes: bool,
    },
    /// Compare two AGS files and report differences.
    Diff {
        /// First AGS file (a).
        file_a: PathBuf,
        /// Second AGS file (b).
        file_b: PathBuf,
        /// Output format: text or json.
        #[arg(long, default_value = "text")]
        format: String,
    },
    /// Export AGS data to CSV or JSON.
    Export {
        /// Path to the AGS file.
        file: PathBuf,
        /// Output directory (default: current directory).
        #[arg(short, long)]
        out: Option<PathBuf>,
        /// Print a single group to stdout instead of writing files.
        #[arg(long)]
        group: Option<String>,
        /// Output format: csv (default) or json.
        #[arg(long, default_value = "csv")]
        format: String,
        /// Comma-separated list of groups to export (default: all groups).
        #[arg(long)]
        groups: Option<String>,
    },
    /// Interactively explore an AGS file in the browser.
    Explore {
        /// AGS files to explore.
        #[arg(required = true)]
        files: Vec<PathBuf>,
        /// Directory to export static site to.
        #[arg(short, long)]
        out: Option<PathBuf>,
        /// Start a live web server.
        #[arg(long)]
        serve: bool,
        /// Port for the live server.
        #[arg(long, default_value = "8080")]
        port: u16,
    },
    /// Manage a local GeoPackage ground investigation database.
    Db {
        #[command(subcommand)]
        action: DbAction,
    },
    /// Parse a single free-text soil description into structured fields.
    Describe {
        /// Soil description text (e.g. "Soft grey CLAY").
        text: String,
        /// Output format: text or json.
        #[arg(long, default_value = "text")]
        format: String,
    },
    /// Enhance GEOL_DESC rows in an AGS file with structured description data.
    Enhance {
        /// Path to the AGS file.
        file: PathBuf,
        /// Output format: text, json, or csv.
        #[arg(long, default_value = "text")]
        format: String,
    },
    /// Validate multiple AGS files and emit an aggregate summary report.
    Batch {
        /// AGS files or directories to process.
        #[arg(required = true)]
        inputs: Vec<PathBuf>,
        /// Custom rule packs (YAML) or built-in references.
        #[arg(short, long)]
        rules: Vec<String>,
        /// Output format: text (default), json, or csv.
        #[arg(long, default_value = "text")]
        format: String,
        /// Exit non-zero if any file has errors at or above this severity.
        #[arg(long, default_value = "error")]
        fail_on: String,
    },
    /// Find potential duplicate boreholes within or across AGS files.
    Dedupe {
        /// AGS files to check (multiple files enable cross-file detection).
        #[arg(required = true)]
        files: Vec<PathBuf>,
        /// Spatial tolerance in coordinate units (metres).  Boreholes within
        /// this distance are flagged as potential duplicates.  Use 0 to disable
        /// coordinate-based detection.
        #[arg(long, default_value = "1.0")]
        tolerance: f64,
        /// Output format: text (default) or json.
        #[arg(long, default_value = "text")]
        format: String,
    },
    /// Score AGS file data quality (completeness, type validity, cross-references).
    Score {
        /// AGS file to score.
        file: PathBuf,
        /// Output format: text (default) or json.
        #[arg(long, default_value = "text")]
        format: String,
        /// Exit non-zero if the overall score is below this threshold (0–100).
        #[arg(long)]
        min_score: Option<f64>,
    },
    /// Launch the GeoFlow desktop GUI application.
    Gui {
        /// AGS file to open on launch (passed to geoflow-desktop if supported).
        file: Option<PathBuf>,
    },
    /// Upgrade geoflow to the latest release from GitHub.
    Upgrade {
        /// Only report whether an upgrade is available; do not install.
        #[arg(long)]
        check: bool,
        /// Install even if the local version matches the latest release.
        #[arg(long)]
        force: bool,
    },
}

#[derive(Debug, Subcommand)]
enum DbAction {
    /// Create a new GeoPackage database file.
    Init {
        /// Path to the new GeoPackage (e.g. site.gpkg).
        path: PathBuf,
    },
    /// Import one or more AGS files into a GeoPackage.
    Import {
        /// AGS files to import.
        #[arg(required = true)]
        files: Vec<PathBuf>,
        /// Path to the target GeoPackage (created if absent with --create).
        #[arg(short, long)]
        db: PathBuf,
        /// Create the GeoPackage if it does not exist yet.
        #[arg(long)]
        create: bool,
    },
    /// Query LOCA records within a bounding box.
    Query {
        /// Path to the GeoPackage.
        db: PathBuf,
        /// Bounding box as min_e,min_n,max_e,max_n (WGS 84 degrees or BNG metres).
        #[arg(long)]
        bbox: Option<String>,
        /// AGS group to query (e.g. GEOL, SAMP).
        #[arg(long)]
        group: Option<String>,
        /// Filter group rows by LOCA_ID.
        #[arg(long)]
        loca: Option<String>,
        /// Coordinate system for bbox input: wgs84 (default) or bng.
        #[arg(long, default_value = "wgs84")]
        crs: String,
        /// Output format: text (default) or json.
        #[arg(long, default_value = "text")]
        format: String,
    },
    /// Export records from a GeoPackage back to an AGS file.
    Export {
        /// Path to the GeoPackage.
        db: PathBuf,
        /// Output AGS file.
        out: PathBuf,
        /// Comma-separated LOCA_IDs to export (omit for all).
        #[arg(long)]
        loca: Option<String>,
    },
    /// List imports recorded in a GeoPackage.
    Imports {
        /// Path to the GeoPackage.
        db: PathBuf,
    },
}

#[derive(Debug, Subcommand)]
enum RulesAction {
    /// List every built-in rule.
    List,
    /// Show details for a single rule.
    Show {
        /// Rule id (e.g. AGS-STRUCT-001).
        id: String,
    },
}

fn main() -> ExitCode {
    // No arguments + not running in a terminal = launched by double-click / file
    // manager. Open the embedded GUI instead of printing help and exiting.
    #[cfg(feature = "gui")]
    if std::env::args_os().len() == 1 && !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        return match geoflow_desktop::run(None) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("GUI error: {e}");
                ExitCode::from(2)
            }
        };
    }

    let cli = Cli::parse();
    init_tracing(cli.quiet, cli.verbose);

    let result = match cli.command {
        Command::Info { file } => cmd_info(&file),
        Command::Validate {
            files,
            rules,
            format,
            fail_on,
            dict,
            cross_file,
        } => cmd_validate(
            &files,
            &rules,
            &format,
            &fail_on,
            dict.as_deref(),
            cross_file,
        ),
        Command::Rules { action } => match action {
            RulesAction::List => cmd_rules_list(),
            RulesAction::Show { id } => cmd_rules_show(&id),
        },
        Command::Fix {
            file,
            write,
            dry_run,
            rules,
        } => cmd_fix(&file, write, dry_run, &rules),
        Command::Convert {
            input,
            output,
            to,
            from,
            report,
            datum_rl,
        } => cmd_convert(&input, &output, &to, from.as_deref(), report, datum_rl),
        Command::UpgradeFormat {
            input,
            output,
            notes,
        } => cmd_upgrade_format(&input, &output, notes),
        Command::Diff {
            file_a,
            file_b,
            format,
        } => cmd_diff(&file_a, &file_b, &format),
        Command::Export {
            file,
            out,
            group,
            format,
            groups,
        } => cmd_export(
            &file,
            out.as_deref(),
            group.as_deref(),
            &format,
            groups.as_deref(),
        ),
        Command::Explore {
            files,
            out,
            serve,
            port,
        } => cmd_explore(&files, out.as_ref(), serve, port),
        Command::Db { action } => match action {
            DbAction::Init { path } => cmd_db_init(&path),
            DbAction::Import { files, db, create } => cmd_db_import(&files, &db, create),
            DbAction::Query {
                db,
                bbox,
                group,
                loca,
                crs,
                format,
            } => cmd_db_query(
                &db,
                bbox.as_deref(),
                group.as_deref(),
                loca.as_deref(),
                &crs,
                &format,
            ),
            DbAction::Export { db, out, loca } => cmd_db_export(&db, &out, loca.as_deref()),
            DbAction::Imports { db } => cmd_db_imports(&db),
        },
        Command::Batch {
            inputs,
            rules,
            format,
            fail_on,
        } => cmd_batch(&inputs, &rules, &format, &fail_on),
        Command::Dedupe {
            files,
            tolerance,
            format,
        } => cmd_dedupe(&files, tolerance, &format),
        Command::Score {
            file,
            format,
            min_score,
        } => cmd_score(&file, &format, min_score),
        Command::Describe { text, format } => cmd_describe(&text, &format),
        Command::Enhance { file, format } => cmd_enhance(&file, &format),
        Command::Gui { file } => cmd_gui(file.as_deref()),
        Command::Upgrade { check, force } => cmd_upgrade(check, force),
    };

    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(2)
        }
    }
}

fn init_tracing(quiet: bool, verbose: u8) {
    use tracing_subscriber::EnvFilter;
    let level = if quiet {
        "warn"
    } else {
        match verbose {
            0 => "info",
            1 => "debug",
            _ => "trace",
        }
    };
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(level));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .without_time()
        .init();
}

fn cmd_info(path: &std::path::Path) -> Result<ExitCode> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let outcome = ags::parse_bytes(&bytes);
    let f = &outcome.file;

    println!("file: {}", path.display());
    if let Some(v) = &f.ags_version {
        println!("ags version: {v}");
    }
    println!("groups: {}", f.groups.len());
    let total_rows: usize = f.groups.values().map(|g| g.rows.len()).sum();
    println!("rows: {total_rows}");

    if let Some(loca) = f.group("LOCA") {
        println!("locations: {}", loca.rows.len());
    }
    if let Some(proj) = f.group("PROJ") {
        if let Some(name) = proj
            .rows
            .first()
            .and_then(|r| r.get("PROJ_NAME"))
            .and_then(|v| v.as_text())
        {
            println!("project: {name}");
        }
    }
    if let Some((min_depth, max_depth)) = geol_depth_range(f) {
        println!("depth range: {min_depth}..{max_depth} m");
    }

    if !outcome.diagnostics.is_empty() {
        println!("diagnostics: {}", outcome.diagnostics.len());
    }

    Ok(ExitCode::SUCCESS)
}

fn geol_depth_range(file: &geoflow_core::model::AgsFile) -> Option<(String, String)> {
    let geol = file.group("GEOL")?;
    let mut min_top: Option<f64> = None;
    let mut max_base: Option<f64> = None;

    for row in &geol.rows {
        if let Some(top) = row.get("GEOL_TOP").and_then(|v| v.as_number()) {
            min_top = Some(match min_top {
                Some(current) => current.min(top),
                None => top,
            });
        }
        if let Some(base) = row.get("GEOL_BASE").and_then(|v| v.as_number()) {
            max_base = Some(match max_base {
                Some(current) => current.max(base),
                None => base,
            });
        }
    }

    match (min_top, max_base) {
        (Some(min_top), Some(max_base)) => Some((format_number(min_top), format_number(max_base))),
        _ => None,
    }
}

fn format_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e16 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn cmd_validate(
    files: &[PathBuf],
    rules: &[String],
    format: &str,
    fail_on: &str,
    dict: Option<&std::path::Path>,
    cross_file: bool,
) -> Result<ExitCode> {
    let format = Format::parse(format)
        .ok_or_else(|| anyhow::anyhow!("unknown format {format:?} (text|json|junit)"))?;
    let threshold = parse_severity(fail_on)?;

    if let Some(dict_path) = dict {
        geoflow_core::dict::activate_custom_dict(dict_path)?;
    }

    let registry = Registry::standard();

    let mut packs = Vec::new();
    for rule_spec in rules {
        packs.push(
            geoflow_core::dsl::RulePack::load_spec(rule_spec)
                .with_context(|| format!("loading rule pack {rule_spec}"))?,
        );
    }

    let mut all_diagnostics = Vec::new();
    let mut parsed_files = Vec::new();

    for path in files {
        let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        let parsed = ags::parse_bytes(&bytes);
        let mut diagnostics = parsed.diagnostics;
        diagnostics.extend(validate::validate(&parsed.file, &registry));

        for pack in &packs {
            match geoflow_core::dsl::evaluate(&parsed.file, pack) {
                Ok(pd) => diagnostics.extend(pd),
                Err(e) => {
                    diagnostics.push(geoflow_core::Diagnostic::new(
                        "RULE-PACK-ERR".to_string(),
                        geoflow_core::Severity::Error,
                        format!("failed to evaluate pack: {e}"),
                    ));
                }
            }
        }

        for d in &mut diagnostics {
            d.location.file = Some(path.display().to_string());
        }
        all_diagnostics.extend(diagnostics);
        parsed_files.push((path.display().to_string(), parsed.file));
    }

    if cross_file && parsed_files.len() > 1 {
        let file_refs: Vec<&geoflow_core::model::AgsFile> =
            parsed_files.iter().map(|(_, f)| f).collect();
        let labels: Vec<&str> = parsed_files.iter().map(|(l, _)| l.as_str()).collect();
        let xf = geoflow_core::crossfile::validate_cross_file(&file_refs, &labels);
        all_diagnostics.extend(xf.into_iter().map(|d| d.diagnostic));
    }

    println!("{}", render::render(&all_diagnostics, format));

    if dict.is_some() {
        geoflow_core::dict::deactivate_custom_dict();
    }

    let exceeded = all_diagnostics
        .iter()
        .any(|d| severity_rank(d.severity) >= severity_rank(threshold));
    Ok(if exceeded {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    })
}

fn cmd_rules_list() -> Result<ExitCode> {
    let registry = Registry::standard();
    for rule in registry.all_rules() {
        println!(
            "{:<20} {:<8} {}",
            rule.id,
            rule.severity.to_string(),
            rule.description
        );
    }
    for pack_ref in geoflow_core::dsl::installed_pack_refs() {
        println!("PACK {:<15} installed rule pack", pack_ref);
    }
    Ok(ExitCode::SUCCESS)
}

fn cmd_rules_show(id: &str) -> Result<ExitCode> {
    if let Ok(pack) = geoflow_core::dsl::RulePack::load_spec(id) {
        println!("pack:        {}", id);
        println!("name:        {}", pack.pack.name.as_deref().unwrap_or("-"));
        println!(
            "version:     {}",
            pack.pack.pack_version.as_deref().unwrap_or("-")
        );
        println!("rules:       {}", pack.pack.rules.len());
        println!("codelists:   {}", pack.pack.codelists.len());
        return Ok(ExitCode::SUCCESS);
    }
    let registry = Registry::standard();
    match registry.find(id) {
        Some(rule) => {
            println!("id:          {}", rule.id);
            println!("severity:    {}", rule.severity);
            println!("description: {}", rule.description);
            Ok(ExitCode::SUCCESS)
        }
        None => {
            eprintln!("unknown rule id {id:?}");
            Ok(ExitCode::from(1))
        }
    }
}

fn parse_severity(s: &str) -> Result<Severity> {
    match s {
        "info" => Ok(Severity::Info),
        "warning" | "warn" => Ok(Severity::Warning),
        "error" => Ok(Severity::Error),
        other => Err(anyhow::anyhow!(
            "unknown severity {other:?} (info|warning|error)"
        )),
    }
}

fn severity_rank(s: Severity) -> u8 {
    match s {
        Severity::Info => 0,
        Severity::Warning => 1,
        Severity::Error => 2,
    }
}

fn cmd_fix(
    path: &std::path::Path,
    write: bool,
    _dry_run: bool,
    rule_specs: &[String],
) -> Result<ExitCode> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let original_text = ags::decode_bytes(&bytes);
    let parsed = ags::parse_bytes(&bytes);
    let mut file = parsed.file;

    let mut applied: Vec<String> = Vec::new();

    let inspection = geoflow_core::fix::inspect_bytes(&bytes);
    applied.extend(inspection.findings.iter().map(|s| s.to_string()));

    let fixer = geoflow_core::fix::Fixer::standard();
    for name in fixer.apply_all(&mut file) {
        applied.push(name.to_string());
    }

    for rule_spec in rule_specs {
        let pack = geoflow_core::dsl::RulePack::load_spec(rule_spec)
            .with_context(|| format!("loading rule pack {rule_spec}"))?;
        let pd = geoflow_core::dsl::fix(&mut file, &pack)
            .with_context(|| format!("applying rule pack {rule_spec}"))?;
        applied.extend(pd);
    }

    let out_text = ags::serialize(&file);
    if out_text != original_text && applied.is_empty() {
        applied.push("canonicalize-ags-format".to_string());
    }

    if applied.is_empty() {
        println!("no fixes applied to {}", path.display());
    } else {
        applied.sort();
        applied.dedup();
        println!("applied fixes to {}: {:?}", path.display(), applied);
        if write {
            std::fs::write(path, out_text.as_bytes())?;
            println!("changes written to disk.");
        } else {
            println!("dry-run: no changes written. Use --write to apply.");
            println!("{}", render_unified_diff(path, &original_text, &out_text));
        }
    }

    Ok(ExitCode::SUCCESS)
}

// ── gui ───────────────────────────────────────────────────────────────────────

fn cmd_gui(file: Option<&std::path::Path>) -> Result<ExitCode> {
    #[cfg(feature = "gui")]
    {
        geoflow_desktop::run(file.map(|p| p.to_path_buf()))
            .map_err(|e| anyhow::anyhow!("GUI error: {e}"))?;
        Ok(ExitCode::SUCCESS)
    }

    #[cfg(not(feature = "gui"))]
    {
        let exe_name = if cfg!(windows) {
            "geoflow-desktop.exe"
        } else {
            "geoflow-desktop"
        };

        let candidate = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(exe_name)))
            .filter(|p| p.exists());

        let desktop = candidate.unwrap_or_else(|| std::path::PathBuf::from(exe_name));

        let mut cmd = std::process::Command::new(&desktop);
        if let Some(f) = file {
            cmd.arg(f);
        }

        let status = cmd.status().with_context(|| {
            format!(
                "launching {}; install geoflow-desktop and make sure it is on PATH",
                desktop.display()
            )
        })?;

        Ok(if status.success() {
            ExitCode::SUCCESS
        } else {
            ExitCode::from(status.code().map(|c| c as u8).unwrap_or(1))
        })
    }
}

// ── upgrade ───────────────────────────────────────────────────────────────────

/// Returns the Rust target triple for the running binary (compile-time constant).
fn platform_target() -> &'static str {
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else {
        "unknown"
    }
}

fn cmd_upgrade(check: bool, force: bool) -> Result<ExitCode> {
    use std::io::Read;

    let current = env!("CARGO_PKG_VERSION");
    let api_url = "https://api.github.com/repos/samotron/geoflow/releases/latest";

    println!("current version: {current}");
    println!("fetching latest release…");

    let body: serde_json::Value = {
        let resp = ureq::get(api_url)
            .set("User-Agent", &format!("geoflow/{current}"))
            .set("Accept", "application/vnd.github+json")
            .call()
            .context("fetching release info from GitHub")?;
        serde_json::from_reader(resp.into_reader()).context("parsing GitHub release JSON")?
    };

    let tag = body["tag_name"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches('v');
    anyhow::ensure!(!tag.is_empty(), "no tag_name in GitHub response");

    println!("latest version:  {tag}");

    if !force && current == tag {
        println!("already up to date.");
        return Ok(ExitCode::SUCCESS);
    }

    if check {
        println!("upgrade available: run `geoflow upgrade` to install.");
        // Exit 1 so scripts can detect that an update is available.
        return Ok(ExitCode::from(1));
    }

    let target = platform_target();
    anyhow::ensure!(
        target != "unknown",
        "unsupported platform — download manually from https://github.com/samotron/geoflow/releases"
    );

    let assets = body["assets"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("release has no assets"))?;

    // Collect asset names → download URLs for quick lookup.
    let asset_map: std::collections::HashMap<&str, &str> = assets
        .iter()
        .filter_map(|a| Some((a["name"].as_str()?, a["browser_download_url"].as_str()?)))
        .collect();

    let (download_url, asset_name) = asset_map
        .iter()
        .find(|(name, _)| name.contains(target))
        .map(|(name, url)| ((*url).to_owned(), (*name).to_owned()))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no release asset for platform {target} in v{tag}; \
                 download manually from https://github.com/samotron/geoflow/releases"
            )
        })?;

    // Try to fetch the checksums file so we can verify the download.
    let checksums_name = format!("geoflow-{tag}-checksums.txt");
    let expected_hash: Option<String> = asset_map.get(checksums_name.as_str()).and_then(|url| {
        let mut buf = String::new();
        ureq::get(url)
            .set("User-Agent", &format!("geoflow/{current}"))
            .call()
            .ok()?
            .into_reader()
            .read_to_string(&mut buf)
            .ok()?;
        // Lines: "{hash}  {filename}"
        buf.lines()
            .find(|l| l.ends_with(&asset_name))
            .and_then(|l| l.split_whitespace().next())
            .map(str::to_owned)
    });

    if expected_hash.is_some() {
        println!("checksums file found — download will be verified.");
    }

    println!("downloading {asset_name}…");

    let mut compressed = Vec::<u8>::new();
    ureq::get(&download_url)
        .set("User-Agent", &format!("geoflow/{current}"))
        .call()
        .context("downloading release asset")?
        .into_reader()
        .read_to_end(&mut compressed)
        .context("reading download")?;

    if let Some(ref expected) = expected_hash {
        use sha2::{Digest, Sha256};
        let actual = hex::encode(Sha256::digest(&compressed));
        anyhow::ensure!(
            actual.eq_ignore_ascii_case(expected),
            "checksum mismatch — download may be corrupt or tampered\n  expected {expected}\n  got      {actual}"
        );
        println!("checksum verified.");
    }

    println!("extracting…");

    let exe_name = if cfg!(windows) {
        "geoflow.exe"
    } else {
        "geoflow"
    };
    let binary = extract_binary(&compressed, &asset_name, exe_name)
        .context("extracting geoflow binary from archive")?;

    let current_exe = std::env::current_exe().context("resolving current executable path")?;
    let tmp_path = current_exe.with_extension("new");

    std::fs::write(&tmp_path, &binary)
        .with_context(|| format!("writing new binary to {}", tmp_path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755))?;
    }

    std::fs::rename(&tmp_path, &current_exe)
        .context("replacing current executable (try running with elevated permissions)")?;

    println!("upgraded to v{tag} — restart geoflow to use the new version.");
    Ok(ExitCode::SUCCESS)
}

/// Extract the named binary from a `.tar.gz` or bare `.gz` archive byte slice.
fn extract_binary(data: &[u8], asset_name: &str, exe_name: &str) -> Result<Vec<u8>> {
    use std::io::{Cursor, Read};

    if asset_name.ends_with(".tar.gz") || asset_name.ends_with(".tgz") {
        let gz = flate2::read::GzDecoder::new(Cursor::new(data));
        let mut archive = tar::Archive::new(gz);
        for entry in archive.entries().context("reading tar entries")? {
            let mut entry = entry.context("reading tar entry")?;
            let path = entry.path().context("tar entry path")?;
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if file_name == exe_name {
                let mut buf = Vec::new();
                entry
                    .read_to_end(&mut buf)
                    .context("reading binary from tar")?;
                return Ok(buf);
            }
        }
        anyhow::bail!("binary {exe_name} not found inside {asset_name}");
    } else if asset_name.ends_with(".gz") {
        // Bare gzip (single file compressed).
        let mut gz = flate2::read::GzDecoder::new(Cursor::new(data));
        let mut buf = Vec::new();
        gz.read_to_end(&mut buf).context("decompressing .gz")?;
        Ok(buf)
    } else {
        // Assume it is a raw binary.
        Ok(data.to_vec())
    }
}

fn render_unified_diff(path: &std::path::Path, before: &str, after: &str) -> String {
    let before_lines: Vec<&str> = before.lines().collect();
    let after_lines: Vec<&str> = after.lines().collect();

    let mut out = String::new();
    out.push_str(&format!("--- {}\n", path.display()));
    out.push_str(&format!("+++ {}\n", path.display()));
    out.push_str(&format!(
        "@@ -1,{} +1,{} @@\n",
        before_lines.len(),
        after_lines.len()
    ));

    let shared = before_lines.len().min(after_lines.len());
    for idx in 0..shared {
        if before_lines[idx] == after_lines[idx] {
            out.push(' ');
            out.push_str(before_lines[idx]);
            out.push('\n');
        } else {
            out.push('-');
            out.push_str(before_lines[idx]);
            out.push('\n');
            out.push('+');
            out.push_str(after_lines[idx]);
            out.push('\n');
        }
    }
    for line in &before_lines[shared..] {
        out.push('-');
        out.push_str(line);
        out.push('\n');
    }
    for line in &after_lines[shared..] {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn cmd_convert(
    input: &std::path::Path,
    output: &std::path::Path,
    to: &str,
    from: Option<&str>,
    _report: Option<PathBuf>,
    datum_rl: bool,
) -> Result<ExitCode> {
    let bytes = std::fs::read(input).with_context(|| format!("reading {}", input.display()))?;

    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mut file = match from.map(|s| s.to_lowercase()).as_deref() {
        Some("ags3") => {
            geoflow_core::ags3::migrate_bytes(&bytes)
                .ok_or_else(|| anyhow::anyhow!("input does not appear to be an AGS 3 file"))?
                .file
        }
        _ if ext == "xml" || ext == "diggs" => geoflow_core::diggs::read(&bytes)?,
        _ => geoflow_core::ags::parse_bytes(&bytes).file,
    };

    if datum_rl {
        let n =
            geoflow_core::datum::apply_datum(&mut file, geoflow_core::datum::DatumMode::DepthToRl);
        if n > 0 {
            println!("datum: converted {n} depth values to Reduced Level");
        } else {
            eprintln!("datum: no LOCA_GL values found; depths unchanged");
        }
    }

    let out_text = match to.to_lowercase().as_str() {
        "ags" => geoflow_core::ags::serialize(&file),
        "diggs" => {
            let (xml, report) = geoflow_core::diggs::write(&file)?;
            if let Some(r_path) = _report {
                let json = serde_json::to_string_pretty(&report)?;
                std::fs::write(r_path, json)?;
            }
            xml
        }
        "json" => {
            let json = geoflow_core::export::to_json(&file);
            serde_json::to_string_pretty(&json)?
        }
        "geojson" => {
            let gj = geoflow_core::export::to_geojson(&file)
                .ok_or_else(|| anyhow::anyhow!("no LOCA rows with coordinates found"))?;
            serde_json::to_string_pretty(&gj)?
        }
        "kml" => geoflow_core::export::to_kml(&file)
            .ok_or_else(|| anyhow::anyhow!("no LOCA rows with coordinates found"))?,
        other => anyhow::bail!("unknown target format {other:?} (ags|diggs|json|geojson|kml)"),
    };
    std::fs::write(output, out_text.as_bytes())
        .with_context(|| format!("writing {}", output.display()))?;

    println!("converted {} to {}", input.display(), output.display());
    Ok(ExitCode::SUCCESS)
}

fn cmd_diff(path_a: &std::path::Path, path_b: &std::path::Path, format: &str) -> Result<ExitCode> {
    let bytes_a = std::fs::read(path_a).with_context(|| format!("reading {}", path_a.display()))?;
    let bytes_b = std::fs::read(path_b).with_context(|| format!("reading {}", path_b.display()))?;

    let file_a = ags::parse_bytes(&bytes_a).file;
    let file_b = ags::parse_bytes(&bytes_b).file;

    let result = geoflow_core::diff::diff(&file_a, &file_b);
    let identical = result.is_identical();

    match format {
        "json" => println!("{}", serde_json::to_string_pretty(&result.to_summary())?),
        _ => print!("{result}"),
    }

    Ok(if identical {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    })
}

fn cmd_export(
    path: &std::path::Path,
    out: Option<&std::path::Path>,
    group: Option<&str>,
    format: &str,
    groups: Option<&str>,
) -> Result<ExitCode> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let file = ags::parse_bytes(&bytes).file;

    // Build optional group filter.
    let filter: Option<std::collections::HashSet<&str>> = groups.map(|g| {
        g.split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect()
    });

    match format {
        "geojson" => {
            let gj = geoflow_core::export::to_geojson(&file)
                .ok_or_else(|| anyhow::anyhow!("no LOCA rows with coordinates found"))?;
            let out_path = out
                .map(|d| d.join("locations.geojson"))
                .unwrap_or_else(|| std::path::PathBuf::from("locations.geojson"));
            std::fs::write(&out_path, serde_json::to_string_pretty(&gj)?)
                .with_context(|| format!("writing {}", out_path.display()))?;
            println!("exported GeoJSON to {}", out_path.display());
        }
        "kml" => {
            let kml = geoflow_core::export::to_kml(&file)
                .ok_or_else(|| anyhow::anyhow!("no LOCA rows with coordinates found"))?;
            let out_path = out
                .map(|d| d.join("locations.kml"))
                .unwrap_or_else(|| std::path::PathBuf::from("locations.kml"));
            std::fs::write(&out_path, kml.as_bytes())
                .with_context(|| format!("writing {}", out_path.display()))?;
            println!("exported KML to {}", out_path.display());
        }
        "json" => {
            let mut json_val = geoflow_core::export::to_json(&file);
            // Apply group filter to the JSON object.
            if let (Some(filter), Some(obj)) = (&filter, json_val.as_object_mut()) {
                obj.retain(|k, _| filter.contains(k.as_str()));
            }
            // Apply single-group selection.
            if let Some(g) = group {
                if let Some(val) = json_val.get(g) {
                    println!("{}", serde_json::to_string_pretty(val)?);
                } else {
                    eprintln!("group {g:?} not found in file");
                    return Ok(ExitCode::from(1));
                }
            } else {
                let out_path = out
                    .map(|d| d.join("export.json"))
                    .unwrap_or_else(|| std::path::PathBuf::from("export.json"));
                std::fs::write(&out_path, serde_json::to_string_pretty(&json_val)?)
                    .with_context(|| format!("writing {}", out_path.display()))?;
                println!("exported JSON to {}", out_path.display());
            }
        }
        _ => {
            // CSV (default)
            let mut csvs = geoflow_core::export::to_csv(&file);
            if let Some(ref filter) = filter {
                csvs.retain(|k, _| filter.contains(k.as_str()));
            }
            if let Some(g) = group {
                match csvs.get(g) {
                    Some(csv) => print!("{csv}"),
                    None => {
                        eprintln!("group {g:?} not found in file");
                        return Ok(ExitCode::from(1));
                    }
                }
                return Ok(ExitCode::SUCCESS);
            }
            let out_dir = out.unwrap_or(std::path::Path::new("."));
            std::fs::create_dir_all(out_dir)?;
            let mut count = 0;
            for (name, csv) in &csvs {
                let dest = out_dir.join(format!("{name}.csv"));
                std::fs::write(&dest, csv.as_bytes())
                    .with_context(|| format!("writing {}", dest.display()))?;
                count += 1;
            }
            println!("exported {count} CSV file(s) to {}", out_dir.display());
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn collect_ags_paths(inputs: &[PathBuf]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for input in inputs {
        if input.is_dir() {
            if let Ok(entries) = std::fs::read_dir(input) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.extension().and_then(|e| e.to_str()) == Some("ags") {
                        paths.push(p);
                    }
                }
            }
        } else {
            paths.push(input.clone());
        }
    }
    paths.sort();
    paths
}

#[derive(Debug)]
struct BatchRow {
    file: String,
    groups: usize,
    rows: usize,
    errors: usize,
    warnings: usize,
    infos: usize,
    score: f64,
    grade: String,
}

fn cmd_batch(
    inputs: &[PathBuf],
    rule_specs: &[String],
    format: &str,
    fail_on: &str,
) -> Result<ExitCode> {
    let threshold = parse_severity(fail_on)?;
    let registry = Registry::standard();

    let mut packs = Vec::new();
    for spec in rule_specs {
        packs.push(
            geoflow_core::dsl::RulePack::load_spec(spec)
                .with_context(|| format!("loading rule pack {spec}"))?,
        );
    }

    let paths = collect_ags_paths(inputs);
    if paths.is_empty() {
        eprintln!("no AGS files found");
        return Ok(ExitCode::from(2));
    }

    let mut batch_rows: Vec<BatchRow> = Vec::new();
    let mut any_exceeded = false;

    for path in &paths {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("skipping {}: {e}", path.display());
                continue;
            }
        };

        let parsed = ags::parse_bytes(&bytes);
        let mut diagnostics = parsed.diagnostics;
        diagnostics.extend(validate::validate(&parsed.file, &registry));

        for pack in &packs {
            match geoflow_core::dsl::evaluate(&parsed.file, pack) {
                Ok(pd) => diagnostics.extend(pd),
                Err(e) => eprintln!("rule pack error for {}: {e}", path.display()),
            }
        }

        let errors = diagnostics
            .iter()
            .filter(|d| d.severity == geoflow_core::Severity::Error)
            .count();
        let warnings = diagnostics
            .iter()
            .filter(|d| d.severity == geoflow_core::Severity::Warning)
            .count();
        let infos = diagnostics
            .iter()
            .filter(|d| d.severity == geoflow_core::Severity::Info)
            .count();

        let qs = geoflow_core::score::score(&parsed.file);
        let groups = parsed.file.groups.len();
        let total_rows: usize = parsed.file.groups.values().map(|g| g.rows.len()).sum();

        if diagnostics
            .iter()
            .any(|d| severity_rank(d.severity) >= severity_rank(threshold))
        {
            any_exceeded = true;
        }

        batch_rows.push(BatchRow {
            file: path.display().to_string(),
            groups,
            rows: total_rows,
            errors,
            warnings,
            infos,
            score: qs.overall,
            grade: qs.grade,
        });
    }

    match format {
        "json" => {
            let json: Vec<serde_json::Value> = batch_rows
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "file": r.file,
                        "groups": r.groups,
                        "rows": r.rows,
                        "errors": r.errors,
                        "warnings": r.warnings,
                        "infos": r.infos,
                        "score": r.score,
                        "grade": r.grade,
                    })
                })
                .collect();
            println!("{}", serde_json::to_string_pretty(&json)?);
        }
        "csv" => {
            println!("file,groups,rows,errors,warnings,infos,score,grade");
            for r in &batch_rows {
                println!(
                    "{},{},{},{},{},{},{:.1},{}",
                    r.file, r.groups, r.rows, r.errors, r.warnings, r.infos, r.score, r.grade
                );
            }
        }
        _ => {
            let total_files = batch_rows.len();
            let total_errors: usize = batch_rows.iter().map(|r| r.errors).sum();
            let total_warnings: usize = batch_rows.iter().map(|r| r.warnings).sum();
            let avg_score: f64 = if total_files > 0 {
                batch_rows.iter().map(|r| r.score).sum::<f64>() / total_files as f64
            } else {
                0.0
            };

            println!(
                "{:<50}  {:>6}  {:>6}  {:>6}  {:>7}  {:>7}  {:>6}  {:>5}",
                "file", "groups", "rows", "errors", "warnings", "infos", "score", "grade"
            );
            println!("{}", "-".repeat(100));
            for r in &batch_rows {
                let short = if r.file.len() > 50 {
                    format!("…{}", &r.file[r.file.len() - 49..])
                } else {
                    r.file.clone()
                };
                println!(
                    "{:<50}  {:>6}  {:>6}  {:>6}  {:>7}  {:>7}  {:>5.1}  {:>5}",
                    short, r.groups, r.rows, r.errors, r.warnings, r.infos, r.score, r.grade
                );
            }
            println!("{}", "-".repeat(100));
            println!(
                "total: {} files  {} errors  {} warnings  avg score {:.1}",
                total_files, total_errors, total_warnings, avg_score
            );
        }
    }

    Ok(if any_exceeded {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    })
}

fn cmd_upgrade_format(
    input: &std::path::Path,
    output: &std::path::Path,
    show_notes: bool,
) -> Result<ExitCode> {
    let bytes = std::fs::read(input).with_context(|| format!("reading {}", input.display()))?;
    let outcome = geoflow_core::ags3::migrate_bytes(&bytes).ok_or_else(|| {
        anyhow::anyhow!("input does not appear to be an AGS 3 file (no ** group headers found)")
    })?;

    let ags4 = geoflow_core::ags::serialize(&outcome.file);
    std::fs::write(output, ags4.as_bytes())
        .with_context(|| format!("writing {}", output.display()))?;

    let groups = outcome.file.groups.len();
    let rows: usize = outcome.file.groups.values().map(|g| g.rows.len()).sum();
    println!(
        "upgraded {} → {} ({} groups, {} rows)",
        input.display(),
        output.display(),
        groups,
        rows,
    );

    if show_notes && !outcome.notes.is_empty() {
        println!("migration notes:");
        for note in &outcome.notes {
            println!("  • {note}");
        }
    }

    Ok(ExitCode::SUCCESS)
}

fn cmd_dedupe(files: &[PathBuf], tolerance: f64, format: &str) -> Result<ExitCode> {
    let mut parsed: Vec<(String, geoflow_core::model::AgsFile)> = Vec::new();
    for path in files {
        let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        parsed.push((path.display().to_string(), ags::parse_bytes(&bytes).file));
    }

    let file_refs: Vec<&geoflow_core::model::AgsFile> = parsed.iter().map(|(_, f)| f).collect();
    let labels: Vec<&str> = parsed.iter().map(|(l, _)| l.as_str()).collect();
    let pairs = geoflow_core::dedupe::find_duplicates(&file_refs, &labels, tolerance);

    match format {
        "json" => println!("{}", serde_json::to_string_pretty(&pairs)?),
        _ => {
            if pairs.is_empty() {
                println!("no duplicate boreholes found (tolerance {tolerance} m)");
            } else {
                println!(
                    "found {} potential duplicate{}:",
                    pairs.len(),
                    if pairs.len() == 1 { "" } else { "s" }
                );
                for p in &pairs {
                    let dist = p
                        .distance_m
                        .map(|d| format!("{d:.1} m"))
                        .unwrap_or_else(|| "n/a".into());
                    println!(
                        "  {:?} (file {}) ↔ {:?} (file {})  reason={:?}  distance={}",
                        p.loca_id_a,
                        p.file_a + 1,
                        p.loca_id_b,
                        p.file_b + 1,
                        p.reason,
                        dist
                    );
                }
            }
        }
    }

    Ok(if pairs.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    })
}

fn cmd_score(path: &std::path::Path, format: &str, min_score: Option<f64>) -> Result<ExitCode> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let file = ags::parse_bytes(&bytes).file;
    let result = geoflow_core::score::score(&file);

    match format {
        "json" => println!("{}", serde_json::to_string_pretty(&result)?),
        _ => {
            println!("file:    {}", path.display());
            println!("overall: {:.1} / 100  ({})", result.overall, result.grade);
            println!();
            println!(
                "{:<12}  {:>5}  {:>14}  {:>14}  {:>13}  {:>11}  {:>7}",
                "group",
                "rows",
                "completeness",
                "type-validity",
                "cross-refs",
                "structural",
                "total"
            );
            println!("{}", "-".repeat(90));
            for g in &result.groups {
                println!(
                    "{:<12}  {:>5}  {:>13.1}%  {:>13.1}%  {:>12.1}%  {:>10.1}%  {:>6.1}",
                    g.group,
                    g.rows,
                    g.completeness,
                    g.type_validity,
                    g.cross_reference,
                    g.structural,
                    g.total,
                );
            }
        }
    }

    let threshold = min_score.unwrap_or(0.0);
    Ok(if result.overall < threshold {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    })
}

fn cmd_describe(text: &str, format: &str) -> Result<ExitCode> {
    let d = describe::parse_description(text);
    match format {
        "json" => println!("{}", serde_json::to_string_pretty(&d)?),
        _ => {
            println!("raw:          {}", d.raw);
            println!("material:     {:?}", d.material_type);
            if let Some(st) = &d.primary_soil_type {
                println!("soil type:    {st:?}");
            }
            if let Some(rt) = &d.rock_type {
                println!("rock type:    {rt:?}");
            }
            if let Some(c) = &d.consistency {
                println!("consistency:  {c:?}");
            }
            if let Some(d2) = &d.density {
                println!("density:      {d2:?}");
            }
            if !d.colours.is_empty() {
                println!("colours:      {}", d.colours.join(", "));
            }
            if let Some(m) = &d.moisture {
                println!("moisture:     {m:?}");
            }
            if let Some(ps) = &d.particle_size {
                println!("particle:     {ps:?}");
            }
            if let Some(sp) = &d.strength_params {
                if let (Some(lo), Some(hi)) = (sp.cu_min_kpa, sp.cu_max_kpa) {
                    println!("cu (kPa):     {lo}–{hi}");
                } else if let Some(lo) = sp.cu_min_kpa {
                    println!("cu (kPa):     >{lo}");
                }
                if let (Some(lo), Some(hi)) = (sp.spt_n_min, sp.spt_n_max) {
                    println!("SPT N:        {lo}–{hi}");
                }
            }
            println!("confidence:   {:.0}%", d.confidence * 100.0);
            if !d.warnings.is_empty() {
                println!("warnings:     {}", d.warnings.join(", "));
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn cmd_enhance(path: &std::path::Path, format: &str) -> Result<ExitCode> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let file = ags::parse_bytes(&bytes).file;
    let rows = describe::enhance_geol(&file);

    if rows.is_empty() {
        eprintln!("no GEOL_DESC rows found in {}", path.display());
        return Ok(ExitCode::from(1));
    }

    match format {
        "json" => println!("{}", serde_json::to_string_pretty(&rows)?),
        "csv" => {
            println!("loca_id,geol_top,geol_base,material_type,primary_soil_type,rock_type,consistency,density,colours,confidence,raw");
            for r in &rows {
                let p = &r.parsed;
                println!(
                    "{},{},{},{},{},{},{},{},{},{:.2},\"{}\"",
                    r.loca_id,
                    r.geol_top.map(|v| v.to_string()).unwrap_or_default(),
                    r.geol_base.map(|v| v.to_string()).unwrap_or_default(),
                    serde_json::to_value(&p.material_type)
                        .unwrap()
                        .as_str()
                        .unwrap_or(""),
                    p.primary_soil_type
                        .as_ref()
                        .map(|v| serde_json::to_value(v)
                            .unwrap()
                            .as_str()
                            .unwrap_or("")
                            .to_string())
                        .unwrap_or_default(),
                    p.rock_type
                        .as_ref()
                        .map(|v| serde_json::to_value(v)
                            .unwrap()
                            .as_str()
                            .unwrap_or("")
                            .to_string())
                        .unwrap_or_default(),
                    p.consistency
                        .as_ref()
                        .map(|v| serde_json::to_value(v)
                            .unwrap()
                            .as_str()
                            .unwrap_or("")
                            .to_string())
                        .unwrap_or_default(),
                    p.density
                        .as_ref()
                        .map(|v| serde_json::to_value(v)
                            .unwrap()
                            .as_str()
                            .unwrap_or("")
                            .to_string())
                        .unwrap_or_default(),
                    p.colours.join(";"),
                    p.confidence,
                    r.geol_desc.replace('"', "\"\""),
                );
            }
        }
        _ => {
            for r in &rows {
                let p = &r.parsed;
                let depth = match (r.geol_top, r.geol_base) {
                    (Some(t), Some(b)) => format!("{t}–{b} m"),
                    (Some(t), None) => format!("{t} m"),
                    _ => String::new(),
                };
                let material = if let Some(st) = &p.primary_soil_type {
                    format!("{st:?}")
                } else if let Some(rt) = &p.rock_type {
                    format!("{rt:?}")
                } else {
                    format!("{:?}", p.material_type)
                };
                println!(
                    "[{}] {} | {} | confidence {:.0}% | \"{}\"",
                    r.loca_id,
                    depth,
                    material,
                    p.confidence * 100.0,
                    r.geol_desc,
                );
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn cmd_db_init(path: &std::path::Path) -> Result<ExitCode> {
    geoflow_core::db::GpkgDb::create(path)?;
    println!("created GeoPackage: {}", path.display());
    Ok(ExitCode::SUCCESS)
}

fn cmd_db_import(files: &[PathBuf], db_path: &std::path::Path, create: bool) -> Result<ExitCode> {
    let mut db = if create && !db_path.exists() {
        geoflow_core::db::GpkgDb::create(db_path)
            .with_context(|| format!("creating {}", db_path.display()))?
    } else {
        geoflow_core::db::GpkgDb::open(db_path)
            .with_context(|| format!("opening {}", db_path.display()))?
    };

    for path in files {
        let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        let file = ags::parse_bytes(&bytes).file;
        let report = db
            .import(&file, Some(&path.display().to_string()))
            .with_context(|| format!("importing {}", path.display()))?;
        println!(
            "imported {} — {} LOCA records, {} groups",
            path.display(),
            report.loca_count,
            report.groups_imported.len(),
        );
    }
    Ok(ExitCode::SUCCESS)
}

fn cmd_db_query(
    db_path: &std::path::Path,
    bbox: Option<&str>,
    group: Option<&str>,
    loca_id: Option<&str>,
    crs: &str,
    format: &str,
) -> Result<ExitCode> {
    let db = geoflow_core::db::GpkgDb::open(db_path)?;

    if let Some(bbox_str) = bbox {
        let parts: Vec<f64> = bbox_str
            .split(',')
            .map(|s| s.trim().parse::<f64>())
            .collect::<std::result::Result<_, _>>()
            .with_context(|| format!("bbox must be four comma-separated numbers: {bbox_str}"))?;
        if parts.len() != 4 {
            anyhow::bail!("bbox requires exactly four values: min_e,min_n,max_e,max_n");
        }
        let (min_lon, min_lat, max_lon, max_lat) = if crs == "bng" {
            use geoflow_core::spatial::{reproject, Crs};
            let (min_lon, min_lat) = reproject((parts[0], parts[1]), Crs::Bng, Crs::Wgs84);
            let (max_lon, max_lat) = reproject((parts[2], parts[3]), Crs::Bng, Crs::Wgs84);
            (min_lon, min_lat, max_lon, max_lat)
        } else {
            (parts[0], parts[1], parts[2], parts[3])
        };

        let records = db.query_bbox(min_lon, min_lat, max_lon, max_lat)?;
        if format == "json" {
            let json: Vec<serde_json::Value> = records
                .iter()
                .map(|r| {
                    let mut m = serde_json::Map::new();
                    m.insert("loca_id".into(), r.loca_id.clone().into());
                    m.insert("lon".into(), r.lon.into());
                    m.insert("lat".into(), r.lat.into());
                    for (k, v) in &r.attrs {
                        m.insert(
                            k.clone(),
                            v.clone().map(Into::into).unwrap_or(serde_json::Value::Null),
                        );
                    }
                    serde_json::Value::Object(m)
                })
                .collect();
            println!("{}", serde_json::to_string_pretty(&json)?);
        } else {
            println!("{:<20} {:>12} {:>12}", "LOCA_ID", "LON", "LAT");
            println!("{}", "-".repeat(46));
            for r in &records {
                println!("{:<20} {:>12.6} {:>12.6}", r.loca_id, r.lon, r.lat);
            }
            println!("\n{} location(s) found", records.len());
        }
        return Ok(ExitCode::SUCCESS);
    }

    if let Some(grp) = group {
        let result = db.query_group(grp, loca_id)?;
        if format == "json" {
            let rows: Vec<serde_json::Value> = result
                .rows
                .iter()
                .map(|row| {
                    let mut m = serde_json::Map::new();
                    for (col, val) in result.columns.iter().zip(row) {
                        m.insert(
                            col.clone(),
                            val.clone()
                                .map(Into::into)
                                .unwrap_or(serde_json::Value::Null),
                        );
                    }
                    serde_json::Value::Object(m)
                })
                .collect();
            println!("{}", serde_json::to_string_pretty(&rows)?);
        } else {
            println!("{}", result.columns.join("\t"));
            println!("{}", "-".repeat(result.columns.len() * 12));
            for row in &result.rows {
                let cells: Vec<&str> = row.iter().map(|v| v.as_deref().unwrap_or("")).collect();
                println!("{}", cells.join("\t"));
            }
            println!("\n{} row(s)", result.rows.len());
        }
        return Ok(ExitCode::SUCCESS);
    }

    anyhow::bail!("specify --bbox or --group");
}

fn cmd_db_export(
    db_path: &std::path::Path,
    out: &std::path::Path,
    loca_filter: Option<&str>,
) -> Result<ExitCode> {
    let db = geoflow_core::db::GpkgDb::open(db_path)?;
    let ids: Vec<&str> = loca_filter
        .map(|s| s.split(',').map(str::trim).collect())
        .unwrap_or_default();
    let file = db.export_ags(&ids)?;
    let text = geoflow_core::ags::serialize(&file);
    std::fs::write(out, text.as_bytes()).with_context(|| format!("writing {}", out.display()))?;
    let total: usize = file.groups.values().map(|g| g.rows.len()).sum();
    println!(
        "exported {} groups / {} rows to {}",
        file.groups.len(),
        total,
        out.display()
    );
    Ok(ExitCode::SUCCESS)
}

fn cmd_db_imports(db_path: &std::path::Path) -> Result<ExitCode> {
    let db = geoflow_core::db::GpkgDb::open(db_path)?;
    let imports = db.list_imports()?;
    if imports.is_empty() {
        println!("no imports recorded in {}", db_path.display());
        return Ok(ExitCode::SUCCESS);
    }
    println!("{:>4}  {:<40} {:>6}  IMPORTED AT", "ID", "FILE", "LOCA");
    println!("{}", "-".repeat(72));
    for imp in &imports {
        println!(
            "{:>4}  {:<40} {:>6}  {}",
            imp.id, imp.source_file, imp.loca_count, imp.imported_at,
        );
    }
    Ok(ExitCode::SUCCESS)
}

fn cmd_explore(
    files: &[PathBuf],
    out: Option<&PathBuf>,
    serve: bool,
    port: u16,
) -> Result<ExitCode> {
    let path = files
        .first()
        .ok_or_else(|| anyhow::anyhow!("no files provided"))?;
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let parsed = geoflow_core::ags::parse_bytes(&bytes);

    if let Some(out_dir) = out {
        let explorer = geoflow_core::explorer::Explorer::new();
        let pages = explorer.render_all(&parsed.file)?;
        for (rel_path, html) in pages {
            let full_path = out_dir.join(rel_path);
            if let Some(parent) = full_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&full_path, html)?;
        }
        println!("exported static site to {}", out_dir.display());
    }

    if serve {
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file.ags")
            .to_string();
        run_server(parsed.file, file_name, port)?;
    } else if out.is_none() {
        anyhow::bail!("provide --out DIR or --serve (or both)");
    }

    Ok(ExitCode::SUCCESS)
}

#[tokio::main]
async fn run_server(
    file: geoflow_core::model::AgsFile,
    file_name: String,
    port: u16,
) -> Result<()> {
    use axum::{
        body::Bytes,
        extract::{Path, Query, State},
        http::header,
        routing::{get, post},
        Router,
    };
    use std::sync::Arc;

    // Served as /pkg/geoflow_wasm.js — same interface as the real WASM module
    // but proxies all calls to the local JSON API via synchronous XHR.
    const WASM_SHIM: &str = r#"
function apiGet(url) {
  const r = new XMLHttpRequest(); r.open('GET', url, false); r.send(null); return r.responseText;
}
function apiPost(url, body) {
  const r = new XMLHttpRequest(); r.open('POST', url, false);
  r.setRequestHeader('Content-Type', 'text/plain'); r.send(body); return r.responseText;
}
export async function init() {}
export function validate_ags(_b)               { return apiGet('/api/validate'); }
export function validate_ags_with_rules(_b, y) { return apiPost('/api/validate-with-rules', y); }
export function fix_ags(_b)                    { return new TextEncoder().encode(apiGet('/api/fix')); }
export function convert_to_diggs(_b)           { return apiGet('/api/diggs'); }
export function list_locations(_b)             { return apiGet('/api/locations'); }
export function render_borehole_svg(_b, id)    { return apiGet('/api/borehole-svg/' + encodeURIComponent(id)); }
export function ags_info(_b)                   { return apiGet('/api/info'); }
export function diff_ags(_a, _b)               { return '[]'; }
export function get_all_groups_data(_b)        { return apiGet('/api/groups'); }
export function get_all_groups_meta(_b)        { return apiGet('/api/groups-meta'); }
export function get_group_rows(_b, g)          { return apiGet('/api/group/' + encodeURIComponent(g)); }
export function parse_description(t)           { return apiGet('/api/parse-description?text=' + encodeURIComponent(t)); }
export function enhance_ags(_b)                { return apiGet('/api/enhance'); }
"#;

    const INDEX_HTML: &str = include_str!("../../../web/index.html");

    struct AppState {
        file: geoflow_core::model::AgsFile,
        explorer: geoflow_core::explorer::Explorer,
    }

    // Inject the CLI mode flag before the module script tag
    let cli_script = format!(
        "<script>window.__GEOFLOW_CLI__ = {{ file: {} }};</script>\n<script type=\"module\">",
        serde_json::to_string(&file_name).unwrap_or_else(|_| "\"file.ags\"".into())
    );
    let index_html = Arc::new(INDEX_HTML.replacen(r#"<script type="module">"#, &cli_script, 1));

    let state = Arc::new(AppState {
        file,
        explorer: geoflow_core::explorer::Explorer::new(),
    });

    #[derive(serde::Deserialize)]
    struct DescribeQuery {
        text: Option<String>,
    }

    let app = Router::new()
        // ── SPA shell ────────────────────────────────────────────────────
        .route("/", {
            let html = index_html.clone();
            get(move || {
                let html = html.clone();
                async move {
                    (
                        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                        (*html).clone(),
                    )
                }
            })
        })
        .route(
            "/pkg/geoflow_wasm.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/javascript")],
                    WASM_SHIM,
                )
            }),
        )
        // ── JSON API ─────────────────────────────────────────────────────
        .route(
            "/api/info",
            get(|State(s): State<Arc<AppState>>| async move {
                let f = &s.file;
                let total_rows: usize = f.groups.values().map(|g| g.rows.len()).sum();
                let groups: Vec<&str> = f.groups.keys().map(|k| k.as_str()).collect();
                let locations = f.group("LOCA").map(|g| g.rows.len()).unwrap_or(0);
                let project = f
                    .group("PROJ")
                    .and_then(|g| g.rows.first())
                    .and_then(|r| r.get("PROJ_NAME"))
                    .and_then(|v| v.as_text())
                    .unwrap_or("")
                    .to_string();
                let body = serde_json::json!({
                    "ags_version": f.ags_version,
                    "groups": groups,
                    "group_count": groups.len(),
                    "total_rows": total_rows,
                    "locations": locations,
                    "project": project,
                })
                .to_string();
                ([(header::CONTENT_TYPE, "application/json")], body)
            }),
        )
        .route(
            "/api/locations",
            get(|State(s): State<Arc<AppState>>| async move {
                let locs: Vec<_> = s
                    .file
                    .group("LOCA")
                    .map(|g| {
                        g.rows
                            .iter()
                            .filter_map(|r| {
                                let id = r.get("LOCA_ID")?.as_text()?.to_string();
                                Some(serde_json::json!({
                                    "id": id,
                                    "depth":    r.get("LOCA_FDEP").and_then(|v| v.as_number()),
                                    "easting":  r.get("LOCA_NATE").and_then(|v| v.as_number()),
                                    "northing": r.get("LOCA_NATN").and_then(|v| v.as_number()),
                                }))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    serde_json::to_string(&locs).unwrap_or_default(),
                )
            }),
        )
        .route(
            "/api/groups",
            get(|State(s): State<Arc<AppState>>| async move {
                let mut obj = serde_json::Map::new();
                for (name, group) in &s.file.groups {
                    obj.insert(
                        name.clone(),
                        serde_json::to_value(&group.rows)
                            .unwrap_or(serde_json::Value::Array(vec![])),
                    );
                }
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    serde_json::to_string(&obj).unwrap_or_default(),
                )
            }),
        )
        .route(
            "/api/groups-meta",
            get(|State(s): State<Arc<AppState>>| async move {
                use geoflow_core::model::AgsType;
                let mut obj = serde_json::Map::new();
                for (name, group) in &s.file.groups {
                    let headings: Vec<_> = group
                        .headings
                        .iter()
                        .map(|h| {
                            serde_json::json!({
                                "name":  h.name,
                                "unit":  h.unit,
                                "is_id": matches!(h.data_type, AgsType::ID),
                            })
                        })
                        .collect();
                    obj.insert(name.clone(), serde_json::Value::Array(headings));
                }
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    serde_json::to_string(&obj).unwrap_or_default(),
                )
            }),
        )
        .route(
            "/api/group/:name",
            get(
                |State(s): State<Arc<AppState>>, Path(name): Path<String>| async move {
                    let body = match s.file.group(&name) {
                        Some(g) => serde_json::to_string(&g.rows).unwrap_or_default(),
                        None => "[]".to_string(),
                    };
                    ([(header::CONTENT_TYPE, "application/json")], body)
                },
            ),
        )
        .route(
            "/api/validate",
            get(|State(s): State<Arc<AppState>>| async move {
                let registry = geoflow_core::validate::Registry::standard();
                let diags = geoflow_core::validate::validate(&s.file, &registry);
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    serde_json::to_string(&diags).unwrap_or_default(),
                )
            }),
        )
        .route(
            "/api/validate-with-rules",
            post(|State(s): State<Arc<AppState>>, body: Bytes| async move {
                let yaml = String::from_utf8_lossy(&body).into_owned();
                let pack =
                    match geoflow_core::dsl::RulePack::parse(&yaml).and_then(|p| p.into_loaded()) {
                        Ok(p) => p,
                        Err(e) => {
                            return (
                                [(header::CONTENT_TYPE, "application/json")],
                                serde_json::json!({"error": e.to_string()}).to_string(),
                            )
                        }
                    };
                let registry = geoflow_core::validate::Registry::standard();
                let mut diags = geoflow_core::validate::validate(&s.file, &registry);
                match geoflow_core::dsl::evaluate(&s.file, &pack) {
                    Ok(extra) => diags.extend(extra),
                    Err(e) => {
                        return (
                            [(header::CONTENT_TYPE, "application/json")],
                            serde_json::json!({"error": format!("Evaluation error: {e}")})
                                .to_string(),
                        )
                    }
                }
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    serde_json::to_string(&diags).unwrap_or_default(),
                )
            }),
        )
        .route(
            "/api/borehole-svg/:id",
            get(
                |State(s): State<Arc<AppState>>, Path(id): Path<String>| async move {
                    let svg = s
                        .explorer
                        .render_borehole_svg(&s.file, &id)
                        .unwrap_or_default();
                    ([(header::CONTENT_TYPE, "image/svg+xml")], svg)
                },
            ),
        )
        .route(
            "/api/fix",
            get(|State(s): State<Arc<AppState>>| async move {
                let mut file = s.file.clone();
                let fixer = geoflow_core::fix::Fixer::standard();
                fixer.apply_all(&mut file);
                let text = geoflow_core::ags::serialize(&file);
                ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text)
            }),
        )
        .route(
            "/api/diggs",
            get(|State(s): State<Arc<AppState>>| async move {
                let xml = geoflow_core::diggs::write(&s.file)
                    .map(|(x, _)| x)
                    .unwrap_or_default();
                ([(header::CONTENT_TYPE, "application/xml")], xml)
            }),
        )
        .route(
            "/api/parse-description",
            get(|Query(q): Query<DescribeQuery>| async move {
                let text = q.text.unwrap_or_default();
                let d = geoflow_core::describe::parse_description(&text);
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    serde_json::to_string(&d).unwrap_or_default(),
                )
            }),
        )
        .route(
            "/api/enhance",
            get(|State(s): State<Arc<AppState>>| async move {
                let rows = geoflow_core::describe::enhance_geol(&s.file);
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    serde_json::to_string(&rows).unwrap_or_default(),
                )
            }),
        )
        .with_state(state);

    let addr = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("Explorer live at http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
