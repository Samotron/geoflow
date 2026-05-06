//! Local GeoPackage database for persistent geotechnical data storage.
//!
//! A GeoPackage (`.gpkg`) is an OGC-standard SQLite container.  One table is
//! created per AGS group; `loca` is a feature table with a WGS 84 point
//! geometry column so the file opens directly in QGIS, ArcGIS Pro, etc.
//!
//! # Example
//!
//! ```no_run
//! use geoflow_core::db::GpkgDb;
//! use std::path::Path;
//!
//! let mut db = GpkgDb::create(Path::new("site.gpkg")).unwrap();
//! // db.import(&ags_file, Some("phase1.ags")).unwrap();
//! ```

pub mod geometry;
pub mod ingest;
pub mod query;
mod schema;

pub use ingest::ImportReport;
pub use query::{LocaRecord, QueryResult};

use anyhow::Result;
use std::path::Path;

/// An open GeoPackage database.
pub struct GpkgDb {
    conn: rusqlite::Connection,
}

/// A row from `geoflow_imports`.
#[derive(Debug, Clone)]
pub struct ImportRecord {
    pub id: i64,
    pub source_file: String,
    pub imported_at: String,
    pub loca_count: i64,
    pub proj_name: Option<String>,
}

impl GpkgDb {
    /// Create a new GeoPackage at `path`.  Fails if the file already exists.
    pub fn create(path: &Path) -> Result<Self> {
        if path.exists() {
            anyhow::bail!(
                "{} already exists — delete it first or open it with GpkgDb::open()",
                path.display()
            );
        }
        let conn = rusqlite::Connection::open(path)?;
        schema::init(&conn)?;
        Ok(Self { conn })
    }

    /// Open an existing GeoPackage.
    pub fn open(path: &Path) -> Result<Self> {
        if !path.exists() {
            anyhow::bail!(
                "{} not found — run `geoflow db init` to create it",
                path.display()
            );
        }
        let conn = rusqlite::Connection::open(path)?;
        schema::configure(&conn)?;
        Ok(Self { conn })
    }

    pub(crate) fn conn(&self) -> &rusqlite::Connection {
        &self.conn
    }

    pub(crate) fn conn_mut(&mut self) -> &mut rusqlite::Connection {
        &mut self.conn
    }

    /// Import all groups from `file` into this GeoPackage.
    ///
    /// `source_file` is stored as provenance metadata; pass the original
    /// file path or any descriptive label.
    pub fn import(
        &mut self,
        file: &crate::model::AgsFile,
        source_file: Option<&str>,
    ) -> Result<ImportReport> {
        ingest::ingest(self, file, source_file)
    }

    /// Query LOCA records within a WGS 84 bounding box
    /// `(min_lon, min_lat, max_lon, max_lat)`.
    pub fn query_bbox(
        &self,
        min_lon: f64,
        min_lat: f64,
        max_lon: f64,
        max_lat: f64,
    ) -> Result<Vec<LocaRecord>> {
        query::query_loca_by_bbox(self, min_lon, min_lat, max_lon, max_lat)
    }

    /// Return all rows for `group` (case-insensitive), optionally filtered
    /// to a single `loca_id`.
    pub fn query_group(&self, group: &str, loca_id: Option<&str>) -> Result<QueryResult> {
        query::query_group(self, group, loca_id)
    }

    /// Reconstruct an `AgsFile` for the given `loca_ids`.
    /// Pass an empty slice to export everything.
    pub fn export_ags(&self, loca_ids: &[&str]) -> Result<crate::model::AgsFile> {
        query::export_to_ags(self, loca_ids)
    }

    /// List every import that has been recorded in this GeoPackage.
    pub fn list_imports(&self) -> Result<Vec<ImportRecord>> {
        query::list_imports(self)
    }
}
