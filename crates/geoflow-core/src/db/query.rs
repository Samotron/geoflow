//! Read-side queries against an open GeoPackage.

use anyhow::{Context, Result};
use indexmap::IndexMap;

use crate::model::{AgsFile, AgsGroup, AgsHeading, AgsRow, AgsType, AgsValue};

use super::{geometry, GpkgDb, ImportRecord};

/// A LOCA record with WGS 84 coordinates decoded from the geometry blob.
#[derive(Debug, Clone)]
pub struct LocaRecord {
    pub loca_id: String,
    pub lon: f64,
    pub lat: f64,
    /// All other columns from the `loca` table.
    pub attrs: IndexMap<String, Option<String>>,
}

/// Rows from an arbitrary AGS group table.
#[derive(Debug, Clone)]
pub struct QueryResult {
    pub group: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
}

/// Query LOCA records whose geometry falls within a WGS 84 bounding box.
pub fn query_loca_by_bbox(
    db: &GpkgDb,
    min_lon: f64,
    min_lat: f64,
    max_lon: f64,
    max_lat: f64,
) -> Result<Vec<LocaRecord>> {
    // Fetch all loca rows (SQLite has no built-in spatial index without
    // SpatiaLite; for typical GI datasets the full scan is fast enough).
    let conn = db.conn();

    // Discover columns so we can build a dynamic SELECT.
    let cols = table_columns(conn, "loca")?;
    if cols.is_empty() {
        return Ok(vec![]);
    }

    let col_list = cols
        .iter()
        .filter(|c| *c != "geom" && *c != "fid" && *c != "imported_at")
        .cloned()
        .collect::<Vec<_>>();

    let select = format!(
        "SELECT geom, {} FROM loca",
        col_list.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ")
    );

    let mut stmt = conn.prepare(&select)?;
    let mut out = Vec::new();

    let rows = stmt.query_map([], |row| {
        let blob: Option<Vec<u8>> = row.get(0)?;
        let mut values: Vec<Option<String>> = Vec::with_capacity(col_list.len());
        for i in 0..col_list.len() {
            values.push(row.get(i + 1)?);
        }
        Ok((blob, values))
    })?;

    for row_res in rows {
        let (blob, values) = row_res?;
        let (lon, lat) = match blob.as_deref().and_then(geometry::decode_point) {
            Some(p) => p,
            None => continue,
        };
        if lon < min_lon || lon > max_lon || lat < min_lat || lat > max_lat {
            continue;
        }
        let loca_id = values
            .iter()
            .zip(&col_list)
            .find(|(_, c)| c.to_lowercase() == "loca_id")
            .and_then(|(v, _)| v.clone())
            .unwrap_or_default();

        let attrs: IndexMap<String, Option<String>> = col_list
            .iter()
            .zip(values)
            .map(|(k, v)| (k.clone(), v))
            .collect();

        out.push(LocaRecord { loca_id, lon, lat, attrs });
    }

    Ok(out)
}

/// Return all rows for `group` (table name, case-insensitive), optionally
/// filtered by `loca_id`.
pub fn query_group(
    db: &GpkgDb,
    group: &str,
    loca_id: Option<&str>,
) -> Result<QueryResult> {
    let table = group.to_lowercase();
    let conn = db.conn();

    let cols = table_columns(conn, &table)
        .with_context(|| format!("table {table:?} not found — has the AGS file been imported?"))?;

    let display_cols: Vec<String> = cols
        .iter()
        .filter(|c| *c != "fid" && *c != "geom" && *c != "imported_at")
        .cloned()
        .collect();

    let col_select = display_cols
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");

    let (sql, param): (String, Option<String>) = match loca_id {
        Some(id) => (
            format!("SELECT {col_select} FROM \"{table}\" WHERE loca_id = ?1"),
            Some(id.to_string()),
        ),
        None => (format!("SELECT {col_select} FROM \"{table}\""), None),
    };

    let mut stmt = conn.prepare(&sql)?;
    let n = display_cols.len();
    let collect_row = |row: &rusqlite::Row| -> rusqlite::Result<Vec<Option<String>>> {
        (0..n).map(|i| row.get(i)).collect()
    };

    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    if let Some(ref id) = param {
        for r in stmt.query_map(rusqlite::params![id], collect_row)? {
            rows.push(r?);
        }
    } else {
        for r in stmt.query_map([], collect_row)? {
            rows.push(r?);
        }
    }

    Ok(QueryResult { group: group.to_uppercase(), columns: display_cols, rows })
}

/// Reconstruct an `AgsFile` for the given `loca_ids` (or all if empty).
///
/// Uses `geoflow_headings` to recover AGS unit and type metadata.
pub fn export_to_ags(db: &GpkgDb, loca_ids: &[&str]) -> Result<AgsFile> {
    let conn = db.conn();
    let mut file = AgsFile::new();

    // Discover which AGS tables exist in this GeoPackage.
    let tables = attribute_tables(conn)?;

    for table in &tables {
        let group_name = table.to_uppercase();
        let cols = table_columns(conn, table)?;
        if cols.is_empty() {
            continue;
        }

        // Retrieve heading metadata from geoflow_headings.
        let mut headings: Vec<AgsHeading> = Vec::new();
        {
            let mut hstmt = conn.prepare(
                "SELECT heading_name, unit, data_type FROM geoflow_headings
                  WHERE table_name = ?1 ORDER BY rowid",
            )?;
            let h_iter = hstmt.query_map(rusqlite::params![table], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            for h in h_iter {
                let (name, unit, dt_str) = h?;
                headings.push(AgsHeading {
                    name,
                    unit,
                    data_type: AgsType::parse(&dt_str),
                });
            }
        }

        if headings.is_empty() {
            continue;
        }

        let heading_names: Vec<&str> = headings.iter().map(|h| h.name.as_str()).collect();

        // Build SELECT for this table.
        let col_select = heading_names
            .iter()
            .map(|n| format!("\"{}\"", n.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(", ");

        let (sql, filter_loca): (String, bool) = if loca_ids.is_empty() {
            (format!("SELECT {col_select} FROM \"{table}\""), false)
        } else if cols.contains(&"loca_id".to_string()) {
            let placeholders: Vec<String> =
                (1..=loca_ids.len()).map(|i| format!("?{i}")).collect();
            (
                format!(
                    "SELECT {col_select} FROM \"{table}\" WHERE loca_id IN ({})",
                    placeholders.join(", ")
                ),
                true,
            )
        } else {
            (format!("SELECT {col_select} FROM \"{table}\""), false)
        };

        let mut group = AgsGroup::new(&group_name);
        group.headings = headings.clone();

        let row_builder = |row: &rusqlite::Row| -> rusqlite::Result<AgsRow> {
            let mut ags_row = AgsRow::new();
            for (i, h) in heading_names.iter().enumerate() {
                let raw: Option<String> = row.get(i)?;
                let val = match raw {
                    None => AgsValue::Null,
                    Some(s) if s.is_empty() => AgsValue::Null,
                    Some(s) => AgsValue::Text(s),
                };
                ags_row.insert(h.to_string(), val);
            }
            Ok(ags_row)
        };

        let mut stmt = conn.prepare(&sql)?;
        if filter_loca && !loca_ids.is_empty() {
            let rows = stmt.query_map(rusqlite::params_from_iter(loca_ids.iter()), row_builder)?;
            for r in rows {
                group.rows.push(r?);
            }
        } else {
            let rows = stmt.query_map([], row_builder)?;
            for r in rows {
                group.rows.push(r?);
            }
        }

        if !group.rows.is_empty() {
            file.groups.insert(group_name, group);
        }
    }

    Ok(file)
}

/// List all recorded imports.
pub fn list_imports(db: &GpkgDb) -> Result<Vec<ImportRecord>> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, source_file, imported_at, loca_count, proj_name
           FROM geoflow_imports ORDER BY id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ImportRecord {
            id: row.get(0)?,
            source_file: row.get(1)?,
            imported_at: row.get(2)?,
            loca_count: row.get(3)?,
            proj_name: row.get(4)?,
        })
    })?;
    rows.map(|r| r.map_err(anyhow::Error::from)).collect()
}

// ── private helpers ──────────────────────────────────────────────────────────

/// Return column names for `table`, empty vec if the table doesn't exist.
pub(super) fn table_columns(conn: &rusqlite::Connection, table: &str) -> Result<Vec<String>> {
    let sql = format!("PRAGMA table_info(\"{table}\")");
    let mut stmt = conn.prepare(&sql)?;
    let cols: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(cols)
}

/// Return all non-system tables registered in gpkg_contents.
fn attribute_tables(conn: &rusqlite::Connection) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT table_name FROM gpkg_contents ORDER BY table_name")?;
    let names: Vec<String> = stmt
        .query_map([], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(names)
}
