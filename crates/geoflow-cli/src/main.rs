//! `geoflow` CLI entry point.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use geoflow_core::{
    ags,
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
    /// Convert geotechnical data between formats (AGS/DIGGS).
    Convert {
        /// Input file.
        input: PathBuf,
        /// Output file.
        output: PathBuf,
        /// Target format (ags, diggs).
        #[arg(long)]
        to: String,
        /// Path to write a lossy-conversion report.
        #[arg(long)]
        report: Option<PathBuf>,
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
    /// Export AGS data to CSV (one file per group).
    Export {
        /// Path to the AGS file.
        file: PathBuf,
        /// Output directory (default: current directory).
        #[arg(short, long)]
        out: Option<PathBuf>,
        /// Print a single group to stdout instead of writing files.
        #[arg(long)]
        group: Option<String>,
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
    let cli = Cli::parse();
    init_tracing(cli.quiet, cli.verbose);

    let result = match cli.command {
        Command::Info { file } => cmd_info(&file),
        Command::Validate {
            files,
            rules,
            format,
            fail_on,
        } => cmd_validate(&files, &rules, &format, &fail_on),
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
            report,
        } => cmd_convert(&input, &output, &to, report),
        Command::Diff {
            file_a,
            file_b,
            format,
        } => cmd_diff(&file_a, &file_b, &format),
        Command::Export { file, out, group } => cmd_export(&file, out.as_deref(), group.as_deref()),
        Command::Explore {
            files,
            out,
            serve,
            port,
        } => cmd_explore(&files, out.as_ref(), serve, port),
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
) -> Result<ExitCode> {
    let format = Format::parse(format)
        .ok_or_else(|| anyhow::anyhow!("unknown format {format:?} (text|json|junit)"))?;
    let threshold = parse_severity(fail_on)?;
    let registry = Registry::standard();

    let mut packs = Vec::new();
    for rule_spec in rules {
        packs.push(
            geoflow_core::dsl::RulePack::load_spec(rule_spec)
                .with_context(|| format!("loading rule pack {rule_spec}"))?,
        );
    }

    let mut all_diagnostics = Vec::new();
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
    }

    println!("{}", render::render(&all_diagnostics, format));

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
    _report: Option<PathBuf>,
) -> Result<ExitCode> {
    let bytes = std::fs::read(input).with_context(|| format!("reading {}", input.display()))?;

    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let file = if ext == "xml" || ext == "diggs" {
        geoflow_core::diggs::read(&bytes)?
    } else {
        geoflow_core::ags::parse_bytes(&bytes).file
    };

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
        other => anyhow::bail!("unknown target format {other:?} (ags|diggs)"),
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
) -> Result<ExitCode> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let file = ags::parse_bytes(&bytes).file;
    let csvs = geoflow_core::export::to_csv(&file);

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
        run_server(parsed.file, port)?;
    } else if out.is_none() {
        anyhow::bail!("provide --out DIR or --serve (or both)");
    }

    Ok(ExitCode::SUCCESS)
}

#[tokio::main]
async fn run_server(file: geoflow_core::model::AgsFile, port: u16) -> Result<()> {
    use axum::{
        extract::{Path, State},
        response::Html,
        routing::get,
        Router,
    };
    use std::sync::Arc;

    struct AppState {
        file: geoflow_core::model::AgsFile,
        explorer: geoflow_core::explorer::Explorer,
    }

    let state = Arc::new(AppState {
        file,
        explorer: geoflow_core::explorer::Explorer::new(),
    });

    let app = Router::new()
        .route(
            "/",
            get(|State(s): State<Arc<AppState>>| async move {
                Html(s.explorer.render_overview(&s.file).unwrap())
            }),
        )
        .route(
            "/index.html",
            get(|State(s): State<Arc<AppState>>| async move {
                Html(s.explorer.render_overview(&s.file).unwrap())
            }),
        )
        .route(
            "/validation.html",
            get(|State(s): State<Arc<AppState>>| async move {
                Html(s.explorer.render_validation(&s.file).unwrap())
            }),
        )
        .route(
            "/group/:name",
            get(
                |State(s): State<Arc<AppState>>, Path(name): Path<String>| async move {
                    let name = name.strip_suffix(".html").unwrap_or(&name);
                    Html(
                        s.explorer
                            .render_group(&s.file, name)
                            .unwrap_or_else(|e| format!("Error: {e}")),
                    )
                },
            ),
        )
        .route(
            "/borehole/:id",
            get(
                |State(s): State<Arc<AppState>>, Path(id): Path<String>| async move {
                    let id = id.strip_suffix(".html").unwrap_or(&id);
                    Html(
                        s.explorer
                            .render_borehole(&s.file, id)
                            .unwrap_or_else(|e| format!("Error: {e}")),
                    )
                },
            ),
        )
        .with_state(state);

    let addr = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("Explorer live at http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
