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
use serde::Deserialize;

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
        Command::Describe { text, format } => cmd_describe(&text, &format),
        Command::Enhance { file, format } => cmd_enhance(&file, &format),
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
        run_server(parsed.file, port)?;
    } else if out.is_none() {
        anyhow::bail!("provide --out DIR or --serve (or both)");
    }

    Ok(ExitCode::SUCCESS)
}

#[derive(Default)]
struct PackState {
    /// Predefined pack references, e.g. "ags:standard@4.x".
    selected_refs: Vec<String>,
    /// Raw YAML for an uploaded custom rule pack.
    custom_yaml: Option<String>,
}

impl PackState {
    fn load_packs(&self) -> Vec<geoflow_core::dsl::LoadedPack> {
        let mut packs = Vec::new();
        for r in &self.selected_refs {
            match geoflow_core::dsl::RulePack::load_spec(r) {
                Ok(p) => packs.push(p),
                Err(e) => tracing::warn!("failed to load pack {r}: {e}"),
            }
        }
        if let Some(yaml) = &self.custom_yaml {
            match geoflow_core::dsl::RulePack::parse(yaml).and_then(|p| p.into_loaded()) {
                Ok(p) => packs.push(p),
                Err(e) => tracing::warn!("failed to load custom pack: {e}"),
            }
        }
        packs
    }

    fn all_active_refs(&self) -> Vec<String> {
        let mut refs = self.selected_refs.clone();
        if self.custom_yaml.is_some() {
            refs.push("custom".to_string());
        }
        refs
    }
}

#[derive(Debug, Deserialize)]
struct ValidateForm {
    /// Comma-separated pack references encoded by JS before submit.
    #[serde(default)]
    packs: String,
    /// Custom YAML rule pack content.
    #[serde(default)]
    custom_yaml: String,
}

#[tokio::main]
async fn run_server(file: geoflow_core::model::AgsFile, port: u16) -> Result<()> {
    use axum::{
        extract::{Path, State},
        response::{Html, Redirect},
        routing::{get, post},
        Form, Router,
    };
    use std::sync::Arc;
    use tokio::sync::Mutex;

    struct AppState {
        file: geoflow_core::model::AgsFile,
        explorer: geoflow_core::explorer::Explorer,
        pack_state: Mutex<PackState>,
        available_packs: Vec<String>,
    }

    let available_packs = geoflow_core::dsl::installed_pack_refs();
    let state = Arc::new(AppState {
        file,
        explorer: geoflow_core::explorer::Explorer::new(),
        pack_state: Mutex::new(PackState::default()),
        available_packs,
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
                let ps = s.pack_state.lock().await;
                let packs = ps.load_packs();
                let active_refs = ps.all_active_refs();
                let custom_yaml = ps.custom_yaml.clone();
                drop(ps);
                Html(
                    s.explorer
                        .render_validation(
                            &s.file,
                            &packs,
                            &s.available_packs,
                            &active_refs,
                            custom_yaml.as_deref(),
                            true,
                        )
                        .unwrap_or_else(|e| format!("Error: {e}")),
                )
            }),
        )
        .route(
            "/validate",
            post(
                |State(s): State<Arc<AppState>>, Form(form): Form<ValidateForm>| async move {
                    let selected_refs: Vec<String> = form
                        .packs
                        .split(',')
                        .map(|r| r.trim().to_string())
                        .filter(|r| !r.is_empty())
                        .collect();
                    let custom_yaml = if form.custom_yaml.trim().is_empty() {
                        None
                    } else {
                        Some(form.custom_yaml.trim().to_string())
                    };
                    let mut ps = s.pack_state.lock().await;
                    ps.selected_refs = selected_refs;
                    ps.custom_yaml = custom_yaml;
                    drop(ps);
                    Redirect::to("/validation.html")
                },
            ),
        )
        .route(
            "/certificate.html",
            get(|State(s): State<Arc<AppState>>| async move {
                let ps = s.pack_state.lock().await;
                let packs = ps.load_packs();
                let active_refs = ps.all_active_refs();
                drop(ps);
                let now = chrono::Local::now()
                    .format("%Y-%m-%d %H:%M:%S %Z")
                    .to_string();
                Html(
                    s.explorer
                        .render_certificate(&s.file, &packs, &active_refs, &now)
                        .unwrap_or_else(|e| format!("Error: {e}")),
                )
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
