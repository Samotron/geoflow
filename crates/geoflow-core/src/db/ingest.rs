//! Import an `AgsFile` into an open GeoPackage.
//!
//! Strategy: one SQLite table per AGS group, created dynamically from the
//! group's headings.  LOCA gets a `geom BLOB` geometry column and is
//! registered as a GeoPackage feature table; every other group is an
//! attribute table.  Coordinates are stored in WGS 84 (EPSG:4326); BNG
//! inputs are reprojected automatically.

use anyhow::{Context, Result};

use crate::model::{AgsFile, AgsValue};

use super::{geometry, schema, GpkgDb};

/// Summary returned after a successful import.
#[derive(Debug, Default)]
pub struct ImportReport {
    pub loca_count: usize,
    pub groups_imported: Vec<String>,
    pub source_file: String,
}

/// Import every group from `file` into `db`.
pub fn ingest(db: &mut GpkgDb, file: &AgsFile, source_file: Option<&str>) -> Result<ImportReport> {
    let src = source_file.unwrap_or("<unknown>").to_string();
    let mut report = ImportReport {
        source_file: src.clone(),
        ..Default::default()
    };

    let tx = db.conn_mut().transaction()?;

    for (group_name, group) in &file.groups {
        let table = group_name.to_lowercase();
        let is_loca = group_name == "LOCA";

        // 1. Ensure the table exists.
        let ddl = create_table_ddl(&table, &group.headings, is_loca);
        tx.execute_batch(&ddl)
            .with_context(|| format!("creating table {table}"))?;

        // 2. Register in gpkg_contents.
        if is_loca {
            schema::register_feature_table(&tx, &table, 4326)?;
        } else {
            schema::register_attribute_table(&tx, &table)?;
        }

        // 3. Persist heading metadata for later AGS round-trip export.
        for h in &group.headings {
            let dt = format!("{:?}", h.data_type);
            tx.execute(
                "INSERT OR REPLACE INTO geoflow_headings
                    (table_name, heading_name, unit, data_type)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![table, h.name, h.unit, dt],
            )?;
        }

        // 4. Insert rows.
        let heading_names: Vec<&str> = group.headings.iter().map(|h| h.name.as_str()).collect();

        for row in &group.rows {
            if is_loca {
                insert_loca_row(&tx, &table, &heading_names, row, &src)?;
                report.loca_count += 1;
            } else {
                insert_generic_row(&tx, &table, &heading_names, row, &src)?;
            }
        }

        report.groups_imported.push(group_name.clone());
    }

    // 5. Record the import.
    tx.execute(
        "INSERT INTO geoflow_imports (source_file, loca_count, proj_name)
         VALUES (?1, ?2, ?3)",
        rusqlite::params![src, report.loca_count as i64, proj_name(file)],
    )?;

    tx.commit()?;
    Ok(report)
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn proj_name(file: &AgsFile) -> Option<String> {
    file.group("PROJ")
        .and_then(|g| g.rows.first())
        .and_then(|r| r.get("PROJ_NAME"))
        .and_then(|v| v.as_text())
        .map(str::to_string)
}

fn create_table_ddl(table: &str, headings: &[crate::model::AgsHeading], is_loca: bool) -> String {
    let mut cols = vec![
        "fid INTEGER PRIMARY KEY AUTOINCREMENT".to_string(),
        "source_file TEXT NOT NULL DEFAULT ''".to_string(),
        "imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))".to_string(),
    ];

    if is_loca {
        cols.push("geom BLOB".to_string());
    }

    let has_loca_id = headings.iter().any(|h| h.name == "LOCA_ID");
    if !is_loca && has_loca_id {
        cols.push("loca_id TEXT".to_string());
    }

    for h in headings {
        if !is_loca && h.name == "LOCA_ID" {
            continue; // already promoted
        }
        cols.push(format!("\"{}\" TEXT", h.name.replace('"', "\"\"")));
    }

    format!(
        "CREATE TABLE IF NOT EXISTS \"{table}\" ({});",
        cols.join(", ")
    )
}

fn ags_to_text(v: &AgsValue) -> Option<String> {
    match v {
        AgsValue::Null => None,
        AgsValue::Number(n) => Some(n.to_string()),
        AgsValue::Bool(b) => Some(if *b { "Y" } else { "N" }.to_string()),
        AgsValue::Text(s) | AgsValue::Raw(s) => {
            if s.is_empty() {
                None
            } else {
                Some(s.clone())
            }
        }
    }
}

fn insert_loca_row(
    conn: &rusqlite::Connection,
    table: &str,
    heading_names: &[&str],
    row: &crate::model::AgsRow,
    source_file: &str,
) -> Result<()> {
    let e = row.get("LOCA_NATE").and_then(|v| v.as_number());
    let n = row.get("LOCA_NATN").and_then(|v| v.as_number());

    let geom_blob: Option<Vec<u8>> = match (e, n) {
        (Some(e), Some(n)) => {
            let epsg = geometry::guess_epsg(e, n);
            let (lon, lat) = if epsg == 27700 {
                crate::spatial::reproject(
                    (e, n),
                    crate::spatial::Crs::Bng,
                    crate::spatial::Crs::Wgs84,
                )
            } else {
                (e, n)
            };
            Some(geometry::encode_point(lon, lat, 4326))
        }
        _ => None,
    };

    // Build column list and value list dynamically.
    let mut col_names: Vec<String> = vec!["source_file".into(), "geom".into()];
    let mut text_vals: Vec<Option<String>> = Vec::new();

    for &name in heading_names {
        col_names.push(format!("\"{}\"", name.replace('"', "\"\"")));
        text_vals.push(ags_to_text(row.get(name).unwrap_or(&AgsValue::Null)));
    }

    let placeholders: Vec<String> = (1..=col_names.len()).map(|i| format!("?{i}")).collect();

    let sql = format!(
        "INSERT INTO \"{table}\" ({}) VALUES ({})",
        col_names.join(", "),
        placeholders.join(", "),
    );

    // Bind: source_file, geom blob, then all text values.
    conn.execute(
        &sql,
        rusqlite::params_from_iter(
            std::iter::once(rusqlite::types::Value::Text(source_file.to_string()))
                .chain(std::iter::once(match geom_blob {
                    Some(b) => rusqlite::types::Value::Blob(b),
                    None => rusqlite::types::Value::Null,
                }))
                .chain(text_vals.into_iter().map(|v| match v {
                    Some(s) => rusqlite::types::Value::Text(s),
                    None => rusqlite::types::Value::Null,
                })),
        ),
    )?;
    Ok(())
}

fn insert_generic_row(
    conn: &rusqlite::Connection,
    table: &str,
    heading_names: &[&str],
    row: &crate::model::AgsRow,
    source_file: &str,
) -> Result<()> {
    let has_loca_id = heading_names.contains(&"LOCA_ID");

    let mut col_names: Vec<String> = vec!["source_file".into()];
    let mut values: Vec<rusqlite::types::Value> =
        vec![rusqlite::types::Value::Text(source_file.to_string())];

    if has_loca_id {
        col_names.push("loca_id".into());
        values.push(
            match ags_to_text(row.get("LOCA_ID").unwrap_or(&AgsValue::Null)) {
                Some(s) => rusqlite::types::Value::Text(s),
                None => rusqlite::types::Value::Null,
            },
        );
    }

    for &name in heading_names {
        if name == "LOCA_ID" {
            continue;
        }
        col_names.push(format!("\"{}\"", name.replace('"', "\"\"")));
        values.push(
            match ags_to_text(row.get(name).unwrap_or(&AgsValue::Null)) {
                Some(s) => rusqlite::types::Value::Text(s),
                None => rusqlite::types::Value::Null,
            },
        );
    }

    let placeholders: Vec<String> = (1..=col_names.len()).map(|i| format!("?{i}")).collect();
    let sql = format!(
        "INSERT INTO \"{table}\" ({}) VALUES ({})",
        col_names.join(", "),
        placeholders.join(", "),
    );

    conn.execute(&sql, rusqlite::params_from_iter(values.iter()))?;
    Ok(())
}
