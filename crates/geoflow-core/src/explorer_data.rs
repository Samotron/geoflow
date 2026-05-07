use crate::model::{AgsFile, AgsRow, AgsValue};

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExplorerBorehole {
    pub id: Option<String>,
    pub easting: Option<f64>,
    pub northing: Option<f64>,
    pub ground_level: Option<f64>,
    pub final_depth: Option<f64>,
    pub loca_type: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExplorerGeolRow {
    pub loca_id: Option<String>,
    pub top: Option<f64>,
    pub base: Option<f64>,
    pub desc: Option<String>,
    pub geol: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExplorerWstkRow {
    pub loca_id: Option<String>,
    pub depth: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExplorerIsptRow {
    pub loca_id: Option<String>,
    pub top: Option<f64>,
    pub nval: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExplorerMapData {
    pub boreholes: Vec<ExplorerBorehole>,
    pub geol: Vec<ExplorerGeolRow>,
    pub wstk: Vec<ExplorerWstkRow>,
    pub ispt: Vec<ExplorerIsptRow>,
}

pub fn build_map_data(file: &AgsFile) -> ExplorerMapData {
    let boreholes = file
        .group("LOCA")
        .map(|g| {
            g.rows
                .iter()
                .map(|r| ExplorerBorehole {
                    id: row_text(r, "LOCA_ID"),
                    easting: row_number(r, "LOCA_NATE"),
                    northing: row_number(r, "LOCA_NATN"),
                    ground_level: row_number(r, "LOCA_GL"),
                    final_depth: row_number(r, "LOCA_FDEP"),
                    loca_type: row_text(r, "LOCA_TYPE"),
                })
                .collect()
        })
        .unwrap_or_default();

    let geol = file
        .group("GEOL")
        .map(|g| {
            g.rows
                .iter()
                .map(|r| ExplorerGeolRow {
                    loca_id: row_text(r, "LOCA_ID"),
                    top: row_number(r, "GEOL_TOP"),
                    base: row_number(r, "GEOL_BASE"),
                    desc: row_text(r, "GEOL_DESC"),
                    geol: row_text(r, "GEOL_GEOL"),
                })
                .collect()
        })
        .unwrap_or_default();

    let wstk = file
        .group("WSTK")
        .map(|g| {
            g.rows
                .iter()
                .map(|r| ExplorerWstkRow {
                    loca_id: row_text(r, "LOCA_ID"),
                    depth: row_number(r, "WSTK_DPTH"),
                })
                .collect()
        })
        .unwrap_or_default();

    let ispt = file
        .group("ISPT")
        .map(|g| {
            g.rows
                .iter()
                .map(|r| ExplorerIsptRow {
                    loca_id: row_text(r, "LOCA_ID"),
                    top: row_number(r, "ISPT_TOP"),
                    nval: row_number(r, "ISPT_NVAL"),
                })
                .collect()
        })
        .unwrap_or_default();

    ExplorerMapData {
        boreholes,
        geol,
        wstk,
        ispt,
    }
}

fn row_text(row: &AgsRow, key: &str) -> Option<String> {
    match row.get(key) {
        Some(AgsValue::Text(s) | AgsValue::Raw(s)) => Some(s.clone()),
        Some(AgsValue::Number(n)) => Some(n.to_string()),
        Some(AgsValue::Bool(b)) => Some(b.to_string()),
        _ => None,
    }
}

fn row_number(row: &AgsRow, key: &str) -> Option<f64> {
    match row.get(key) {
        Some(AgsValue::Number(n)) => Some(*n),
        Some(AgsValue::Text(s) | AgsValue::Raw(s)) => s.parse::<f64>().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ags::parse_str;

    #[test]
    fn build_map_data_collects_shared_explorer_payload() {
        let file = parse_str(
            "\"GROUP\",\"LOCA\"\n\
             \"HEADING\",\"LOCA_ID\",\"LOCA_NATE\",\"LOCA_NATN\",\"LOCA_GL\",\"LOCA_FDEP\",\"LOCA_TYPE\"\n\
             \"UNIT\",\"\",\"m\",\"m\",\"m\",\"m\",\"\"\n\
             \"TYPE\",\"ID\",\"2DP\",\"2DP\",\"2DP\",\"2DP\",\"X\"\n\
             \"DATA\",\"BH1\",\"100\",\"200\",\"10.5\",\"12.0\",\"BH\"\n\
             \n\
             \"GROUP\",\"GEOL\"\n\
             \"HEADING\",\"LOCA_ID\",\"GEOL_TOP\",\"GEOL_BASE\",\"GEOL_DESC\"\n\
             \"UNIT\",\"\",\"m\",\"m\",\"\"\n\
             \"TYPE\",\"ID\",\"2DP\",\"2DP\",\"X\"\n\
             \"DATA\",\"BH1\",\"0\",\"1.5\",\"CLAY\"\n",
        )
        .file;

        let data = build_map_data(&file);
        assert_eq!(data.boreholes.len(), 1);
        assert_eq!(data.boreholes[0].id.as_deref(), Some("BH1"));
        assert_eq!(data.boreholes[0].ground_level, Some(10.5));
        assert_eq!(data.geol.len(), 1);
        assert_eq!(data.geol[0].desc.as_deref(), Some("CLAY"));
    }
}
