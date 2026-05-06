//! GeoPackage schema initialisation.
//!
//! Creates the three OGC-required tables (gpkg_spatial_ref_sys,
//! gpkg_contents, gpkg_geometry_columns) plus geoflow-specific metadata
//! tables (geoflow_meta, geoflow_imports, geoflow_headings).

use anyhow::Result;
use rusqlite::Connection;

pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    conn.execute_batch(DDL)?;
    seed_srs(conn)?;
    conn.execute_batch(
        "INSERT INTO geoflow_meta (key, value) VALUES
            ('schema_version', '1'),
            ('created_by', 'geoflow');",
    )?;
    Ok(())
}

/// Enable foreign-key enforcement on every opened connection.
pub fn configure(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    Ok(())
}

const DDL: &str = "
-- ── OGC GeoPackage required tables ──────────────────────────────────

CREATE TABLE gpkg_spatial_ref_sys (
    srs_name                 TEXT    NOT NULL,
    srs_id                   INTEGER NOT NULL PRIMARY KEY,
    organization             TEXT    NOT NULL,
    organization_coordsys_id INTEGER NOT NULL,
    definition               TEXT    NOT NULL,
    description              TEXT
);

CREATE TABLE gpkg_contents (
    table_name  TEXT     NOT NULL PRIMARY KEY,
    data_type   TEXT     NOT NULL,
    identifier  TEXT,
    description TEXT,
    last_change DATETIME NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    min_x       REAL,
    min_y       REAL,
    max_x       REAL,
    max_y       REAL,
    srs_id      INTEGER  REFERENCES gpkg_spatial_ref_sys(srs_id)
);

CREATE TABLE gpkg_geometry_columns (
    table_name        TEXT    NOT NULL REFERENCES gpkg_contents(table_name),
    column_name       TEXT    NOT NULL,
    geometry_type_name TEXT   NOT NULL,
    srs_id            INTEGER NOT NULL REFERENCES gpkg_spatial_ref_sys(srs_id),
    z                 TINYINT NOT NULL,
    m                 TINYINT NOT NULL,
    CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name)
);

-- ── GeoFlow metadata tables ──────────────────────────────────────────

CREATE TABLE geoflow_meta (
    key   TEXT NOT NULL PRIMARY KEY,
    value TEXT
);

CREATE TABLE geoflow_imports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file TEXT    NOT NULL,
    imported_at TEXT    NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    loca_count  INTEGER NOT NULL DEFAULT 0,
    proj_name   TEXT
);

-- Stores AGS heading metadata (unit + type) so export can reconstruct
-- proper AGS structure without consulting the AGS dictionary.
CREATE TABLE geoflow_headings (
    table_name   TEXT NOT NULL,
    heading_name TEXT NOT NULL,
    unit         TEXT NOT NULL DEFAULT '',
    data_type    TEXT NOT NULL DEFAULT 'X',
    PRIMARY KEY (table_name, heading_name)
);
";

fn seed_srs(conn: &Connection) -> Result<()> {
    // OGC GeoPackage spec §1.1.2.1.1 requires these three seed rows.
    conn.execute_batch("
        INSERT INTO gpkg_spatial_ref_sys VALUES
            ('Undefined Cartesian',  -1, 'NONE', -1, 'undefined', 'undefined Cartesian'),
            ('Undefined Geographic',  0, 'NONE',  0, 'undefined', 'undefined geographic'),
            ('WGS 84 Geographic 2D', 4326, 'EPSG', 4326,
             'GEOGCS[\"WGS 84\",DATUM[\"World Geodetic System 1984\",SPHEROID[\"WGS 84\",6378137,298.257223563]],PRIMEM[\"Greenwich\",0],UNIT[\"degree\",0.0174532925199433]]',
             'WGS 84 geographic 2D CRS');

        INSERT INTO gpkg_spatial_ref_sys VALUES
            ('OSGB36 / British National Grid', 27700, 'EPSG', 27700,
             'PROJCS[\"OSGB36 / British National Grid\",GEOGCS[\"OSGB36\",DATUM[\"Ordnance_Survey_of_Great_Britain_1936\",SPHEROID[\"Airy 1830\",6377563.396,299.3249646]],PRIMEM[\"Greenwich\",0],UNIT[\"degree\",0.0174532925199433]],PROJECTION[\"Transverse_Mercator\"],PARAMETER[\"latitude_of_origin\",49],PARAMETER[\"central_meridian\",-2],PARAMETER[\"scale_factor\",0.9996012717],PARAMETER[\"false_easting\",400000],PARAMETER[\"false_northing\",-100000],UNIT[\"metre\",1]]',
             'British National Grid (OSGB36)');
    ")?;
    Ok(())
}

/// Register a feature table (with geometry) in gpkg_contents and
/// gpkg_geometry_columns.
pub fn register_feature_table(conn: &Connection, table: &str, srs_id: i32) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO gpkg_contents
            (table_name, data_type, identifier, description, srs_id)
         VALUES (?1, 'features', ?1, '', ?2)",
        rusqlite::params![table, srs_id],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO gpkg_geometry_columns
            (table_name, column_name, geometry_type_name, srs_id, z, m)
         VALUES (?1, 'geom', 'POINT', ?2, 0, 0)",
        rusqlite::params![table, srs_id],
    )?;
    Ok(())
}

/// Register a non-spatial attribute table in gpkg_contents.
pub fn register_attribute_table(conn: &Connection, table: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO gpkg_contents
            (table_name, data_type, identifier, description)
         VALUES (?1, 'attributes', ?1, '')",
        rusqlite::params![table],
    )?;
    Ok(())
}
