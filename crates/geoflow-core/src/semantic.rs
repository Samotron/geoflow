use crate::{
    describe,
    model::{AgsFile, AgsRow, AgsValue},
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, serde::Serialize)]
pub struct SemanticGraph {
    pub investigation_points: Vec<InvestigationPoint>,
    pub intervals: Vec<DepthInterval>,
    pub lithology_observations: Vec<LithologyObservation>,
    pub samples: Vec<Sample>,
    pub field_tests: Vec<FieldTest>,
    pub lab_tests: Vec<LabTest>,
    pub measurements: Vec<Measurement>,
    pub classifications: Vec<Classification>,
    pub material_facets: Vec<MaterialFacet>,
    pub edges: Vec<SemanticEdge>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InvestigationPoint {
    pub id: String,
    pub loca_id: String,
    pub point_type: String,
    pub easting: Option<f64>,
    pub northing: Option<f64>,
    pub elevation: Option<f64>,
    pub final_depth: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DepthInterval {
    pub id: String,
    pub point_id: String,
    pub kind: String,
    pub top_depth: Option<f64>,
    pub base_depth: Option<f64>,
    pub thickness: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LithologyObservation {
    pub id: String,
    pub interval_id: String,
    pub point_id: String,
    pub raw_description: Option<String>,
    pub legend_code: Option<String>,
    pub confidence: Option<f32>,
    pub source_kind: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Sample {
    pub id: String,
    pub point_id: String,
    pub loca_id: String,
    pub samp_id: Option<String>,
    pub samp_ref: Option<String>,
    pub samp_type: Option<String>,
    pub top_depth: Option<f64>,
    pub base_depth: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FieldTest {
    pub id: String,
    pub point_id: String,
    pub test_type: String,
    pub depth_ref: Option<f64>,
    pub top_depth: Option<f64>,
    pub base_depth: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LabTest {
    pub id: String,
    pub sample_id: String,
    pub point_id: String,
    pub test_type: String,
    pub procedure: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Measurement {
    pub id: String,
    pub owner_id: String,
    pub measure_name: String,
    pub value: Option<f64>,
    pub unit: Option<String>,
    pub qualifier: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Classification {
    pub id: String,
    pub subject_id: String,
    pub scheme: String,
    pub code: String,
    pub label: Option<String>,
    pub explicitness: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MaterialFacet {
    pub id: String,
    pub subject_id: String,
    pub facet: String,
    pub value: String,
    pub explicitness: String,
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SemanticEdge {
    pub from: String,
    pub to: String,
    pub predicate: String,
}

pub fn build_semantic_graph(file: &AgsFile) -> SemanticGraph {
    let mut graph = SemanticGraph {
        investigation_points: Vec::new(),
        intervals: Vec::new(),
        lithology_observations: Vec::new(),
        samples: Vec::new(),
        field_tests: Vec::new(),
        lab_tests: Vec::new(),
        measurements: Vec::new(),
        classifications: Vec::new(),
        material_facets: Vec::new(),
        edges: Vec::new(),
    };

    let mut point_ids = BTreeMap::new();
    if let Some(group) = file.group("LOCA") {
        for row in &group.rows {
            let Some(loca_id) = row_text(row, "LOCA_ID") else {
                continue;
            };
            let point_id = format!("point:{loca_id}");
            point_ids.insert(loca_id.clone(), point_id.clone());
            graph.investigation_points.push(InvestigationPoint {
                id: point_id,
                loca_id,
                point_type: row_text(row, "LOCA_TYPE").unwrap_or_else(|| "Unknown".to_string()),
                easting: row_number(row, "LOCA_NATE"),
                northing: row_number(row, "LOCA_NATN"),
                elevation: row_number(row, "LOCA_GL"),
                final_depth: row_number(row, "LOCA_FDEP"),
            });
        }
    }

    let enhanced_geol = describe::enhance_geol(file);
    let mut geol_facet_index: BTreeMap<(String, String), Vec<MaterialFacet>> = BTreeMap::new();
    for enriched in enhanced_geol {
        let key = (
            enriched.loca_id.clone(),
            interval_key(enriched.geol_top, enriched.geol_base, "geol"),
        );
        let parsed = enriched.parsed;
        let mut facets = Vec::new();

        if let Some(v) = parsed.primary_soil_type {
            facets.push(MaterialFacet {
                id: String::new(),
                subject_id: String::new(),
                facet: "primary_soil_type".to_string(),
                value: format!("{v:?}").to_lowercase(),
                explicitness: "derived".to_string(),
                confidence: Some(parsed.confidence),
            });
        }
        if let Some(v) = parsed.secondary_soil_type {
            facets.push(MaterialFacet {
                id: String::new(),
                subject_id: String::new(),
                facet: "secondary_soil_type".to_string(),
                value: format!("{v:?}").to_lowercase(),
                explicitness: "derived".to_string(),
                confidence: Some(parsed.confidence),
            });
        }
        if let Some(v) = parsed.rock_type {
            facets.push(MaterialFacet {
                id: String::new(),
                subject_id: String::new(),
                facet: "rock_type".to_string(),
                value: format!("{v:?}").to_lowercase(),
                explicitness: "derived".to_string(),
                confidence: Some(parsed.confidence),
            });
        }
        if let Some(v) = parsed.consistency {
            facets.push(MaterialFacet {
                id: String::new(),
                subject_id: String::new(),
                facet: "consistency".to_string(),
                value: format!("{v:?}").to_lowercase(),
                explicitness: "derived".to_string(),
                confidence: Some(parsed.confidence),
            });
        }
        if let Some(v) = parsed.density {
            facets.push(MaterialFacet {
                id: String::new(),
                subject_id: String::new(),
                facet: "density".to_string(),
                value: format!("{v:?}").to_lowercase(),
                explicitness: "derived".to_string(),
                confidence: Some(parsed.confidence),
            });
        }
        if parsed.is_made_ground {
            facets.push(MaterialFacet {
                id: String::new(),
                subject_id: String::new(),
                facet: "made_ground".to_string(),
                value: "true".to_string(),
                explicitness: "derived".to_string(),
                confidence: Some(parsed.confidence),
            });
        }
        for colour in parsed.colours {
            facets.push(MaterialFacet {
                id: String::new(),
                subject_id: String::new(),
                facet: "colour".to_string(),
                value: colour,
                explicitness: "derived".to_string(),
                confidence: Some(parsed.confidence),
            });
        }
        geol_facet_index.insert(key, facets);
    }

    if let Some(group) = file.group("GEOL") {
        for (i, row) in group.rows.iter().enumerate() {
            let Some(loca_id) = row_text(row, "LOCA_ID") else {
                continue;
            };
            let Some(point_id) = point_ids.get(&loca_id).cloned() else {
                continue;
            };
            let top = row_number(row, "GEOL_TOP");
            let base = row_number(row, "GEOL_BASE");
            let interval_id = format!("interval:{point_id}:{}", interval_key(top, base, "geol"));
            graph.intervals.push(DepthInterval {
                id: interval_id.clone(),
                point_id: point_id.clone(),
                kind: "geol".to_string(),
                top_depth: top,
                base_depth: base,
                thickness: match (top, base) {
                    (Some(t), Some(b)) => Some(b - t),
                    _ => None,
                },
            });
            graph.edges.push(SemanticEdge {
                from: point_id.clone(),
                to: interval_id.clone(),
                predicate: "hasInterval".to_string(),
            });

            let obs_id = format!("lith:{interval_id}:{i}");
            graph.lithology_observations.push(LithologyObservation {
                id: obs_id.clone(),
                interval_id: interval_id.clone(),
                point_id: point_id.clone(),
                raw_description: row_text(row, "GEOL_DESC"),
                legend_code: row_text(row, "GEOL_LEG"),
                confidence: geol_facet_index
                    .get(&(loca_id.clone(), interval_key(top, base, "geol")))
                    .and_then(|f| f.first())
                    .and_then(|f| f.confidence),
                source_kind: "GEOL".to_string(),
            });
            graph.edges.push(SemanticEdge {
                from: interval_id.clone(),
                to: obs_id.clone(),
                predicate: "hasObservation".to_string(),
            });

            if let Some(code) = row_text(row, "GEOL_LEG") {
                let class_id = format!("class:{obs_id}:GEOL_LEG:{code}");
                graph.classifications.push(Classification {
                    id: class_id.clone(),
                    subject_id: obs_id.clone(),
                    scheme: "GEOL_LEG".to_string(),
                    code: code.clone(),
                    label: row_text(row, "GEOL_DESC"),
                    explicitness: "explicit".to_string(),
                });
                graph.edges.push(SemanticEdge {
                    from: obs_id.clone(),
                    to: class_id,
                    predicate: "hasClassification".to_string(),
                });
            }

            if let Some(facets) =
                geol_facet_index.remove(&(loca_id.clone(), interval_key(top, base, "geol")))
            {
                for (idx, mut facet) in facets.into_iter().enumerate() {
                    let facet_id = format!("facet:{obs_id}:{}:{}:{idx}", facet.facet, facet.value);
                    facet.id = facet_id.clone();
                    facet.subject_id = obs_id.clone();
                    graph.material_facets.push(facet);
                    graph.edges.push(SemanticEdge {
                        from: obs_id.clone(),
                        to: facet_id,
                        predicate: "hasFacet".to_string(),
                    });
                }
            }
        }
    }

    if let Some(group) = file.group("SAMP") {
        for row in &group.rows {
            let Some(loca_id) = row_text(row, "LOCA_ID") else {
                continue;
            };
            let Some(point_id) = point_ids.get(&loca_id).cloned() else {
                continue;
            };
            let samp_id = row_text(row, "SAMP_ID");
            let samp_ref = row_text(row, "SAMP_REF");
            let samp_type = row_text(row, "SAMP_TYPE");
            let top = row_number(row, "SAMP_TOP");
            let base = row_number(row, "SAMP_BASE").or(top);
            let sample_id = format!(
                "sample:{point_id}:{}",
                samp_id
                    .clone()
                    .or_else(|| samp_ref.clone())
                    .unwrap_or_else(|| interval_key(top, base, "sample"))
            );
            graph.samples.push(Sample {
                id: sample_id.clone(),
                point_id: point_id.clone(),
                loca_id,
                samp_id: samp_id.clone(),
                samp_ref: samp_ref.clone(),
                samp_type,
                top_depth: top,
                base_depth: base,
            });
            graph.edges.push(SemanticEdge {
                from: point_id,
                to: sample_id,
                predicate: "produced".to_string(),
            });
        }
    }

    build_field_tests(
        file,
        "ISPT",
        "ISPT",
        "ISPT_TOP",
        Some("ISPT_NVAL"),
        "NVAL",
        &point_ids,
        &mut graph,
    );
    build_field_tests(
        file,
        "WSTK",
        "WSTK",
        "WSTK_DPTH",
        None,
        "DPTH",
        &point_ids,
        &mut graph,
    );
    build_lab_tests(file, &point_ids, &mut graph);

    dedupe_intervals(&mut graph);
    graph
}

pub fn investigation_points_for_geol_code(file: &AgsFile, code: &str) -> Vec<String> {
    let graph = build_semantic_graph(file);
    let mut ids = BTreeSet::new();
    for class in &graph.classifications {
        if class.scheme == "GEOL_LEG" && class.code.eq_ignore_ascii_case(code) {
            if let Some(obs) = graph
                .lithology_observations
                .iter()
                .find(|o| o.id == class.subject_id)
            {
                if let Some(point) = graph
                    .investigation_points
                    .iter()
                    .find(|p| p.id == obs.point_id)
                {
                    ids.insert(point.loca_id.clone());
                }
            }
        }
    }
    ids.into_iter().collect()
}

fn build_field_tests(
    file: &AgsFile,
    group_name: &str,
    test_type: &str,
    depth_col: &str,
    value_col: Option<&str>,
    measure_name: &str,
    point_ids: &BTreeMap<String, String>,
    graph: &mut SemanticGraph,
) {
    if let Some(group) = file.group(group_name) {
        for (idx, row) in group.rows.iter().enumerate() {
            let Some(loca_id) = row_text(row, "LOCA_ID") else {
                continue;
            };
            let Some(point_id) = point_ids.get(&loca_id).cloned() else {
                continue;
            };
            let depth = row_number(row, depth_col);
            let test_id = format!(
                "fieldtest:{point_id}:{}:{}:{idx}",
                test_type.to_lowercase(),
                depth_fragment(depth)
            );
            graph.field_tests.push(FieldTest {
                id: test_id.clone(),
                point_id: point_id.clone(),
                test_type: test_type.to_string(),
                depth_ref: depth,
                top_depth: depth,
                base_depth: depth,
            });
            graph.edges.push(SemanticEdge {
                from: point_id,
                to: test_id.clone(),
                predicate: "hasFieldTest".to_string(),
            });
            if let Some(col) = value_col {
                let measure_id = format!("measure:{test_id}:{}", measure_name.to_lowercase());
                graph.measurements.push(Measurement {
                    id: measure_id.clone(),
                    owner_id: test_id.clone(),
                    measure_name: measure_name.to_string(),
                    value: row_number(row, col),
                    unit: None,
                    qualifier: None,
                });
                graph.edges.push(SemanticEdge {
                    from: test_id,
                    to: measure_id,
                    predicate: "hasMeasurement".to_string(),
                });
            }
        }
    }
}

fn build_lab_tests(
    file: &AgsFile,
    point_ids: &BTreeMap<String, String>,
    graph: &mut SemanticGraph,
) {
    for group_name in ["LLPL", "LDEN", "LPDN", "LPEN", "LCON", "LCBR"] {
        let Some(group) = file.group(group_name) else {
            continue;
        };
        for (idx, row) in group.rows.iter().enumerate() {
            let Some(loca_id) = row_text(row, "LOCA_ID") else {
                continue;
            };
            let Some(point_id) = point_ids.get(&loca_id).cloned() else {
                continue;
            };
            let samp_id = row_text(row, "SAMP_ID")
                .or_else(|| row_text(row, "SAMP_REF"))
                .unwrap_or_else(|| format!("unknown-{idx}"));
            let sample_key = format!("sample:{point_id}:{samp_id}");
            let test_id = format!("labtest:{sample_key}:{}", group_name.to_lowercase());
            graph.lab_tests.push(LabTest {
                id: test_id.clone(),
                sample_id: sample_key.clone(),
                point_id,
                test_type: group_name.to_string(),
                procedure: None,
            });
            graph.edges.push(SemanticEdge {
                from: sample_key.clone(),
                to: test_id.clone(),
                predicate: "hasLabTest".to_string(),
            });

            for heading in &group.headings {
                if !heading.name.starts_with(group_name) {
                    continue;
                }
                let value = row_number(row, &heading.name);
                if value.is_none() {
                    continue;
                }
                let measure_id = format!("measure:{test_id}:{}", heading.name.to_lowercase());
                graph.measurements.push(Measurement {
                    id: measure_id.clone(),
                    owner_id: test_id.clone(),
                    measure_name: heading.name.clone(),
                    value,
                    unit: if heading.unit.is_empty() {
                        None
                    } else {
                        Some(heading.unit.clone())
                    },
                    qualifier: None,
                });
                graph.edges.push(SemanticEdge {
                    from: test_id.clone(),
                    to: measure_id,
                    predicate: "hasMeasurement".to_string(),
                });
            }
        }
    }
}

fn dedupe_intervals(graph: &mut SemanticGraph) {
    let mut seen = BTreeSet::new();
    graph
        .intervals
        .retain(|interval| seen.insert(interval.id.clone()));
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

fn interval_key(top: Option<f64>, base: Option<f64>, kind: &str) -> String {
    format!("{}:{}:{kind}", depth_fragment(top), depth_fragment(base))
}

fn depth_fragment(depth: Option<f64>) -> String {
    depth
        .map(|v| format!("{v:.3}"))
        .unwrap_or_else(|| "na".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ags::parse_str;

    #[test]
    fn builds_semantic_graph_for_core_groups() {
        let file = parse_str(
            "\"GROUP\",\"LOCA\"\n\
             \"HEADING\",\"LOCA_ID\",\"LOCA_NATE\",\"LOCA_NATN\",\"LOCA_GL\",\"LOCA_FDEP\",\"LOCA_TYPE\"\n\
             \"UNIT\",\"\",\"m\",\"m\",\"m\",\"m\",\"\"\n\
             \"TYPE\",\"ID\",\"2DP\",\"2DP\",\"2DP\",\"2DP\",\"X\"\n\
             \"DATA\",\"BH1\",\"100\",\"200\",\"10.5\",\"12.0\",\"BH\"\n\
             \n\
             \"GROUP\",\"GEOL\"\n\
             \"HEADING\",\"LOCA_ID\",\"GEOL_TOP\",\"GEOL_BASE\",\"GEOL_DESC\",\"GEOL_LEG\"\n\
             \"UNIT\",\"\",\"m\",\"m\",\"\",\"\"\n\
             \"TYPE\",\"ID\",\"2DP\",\"2DP\",\"X\",\"PA\"\n\
             \"DATA\",\"BH1\",\"0\",\"1.5\",\"Brown CLAY\",\"CL\"\n\
             \n\
             \"GROUP\",\"SAMP\"\n\
             \"HEADING\",\"LOCA_ID\",\"SAMP_ID\",\"SAMP_TOP\",\"SAMP_REF\",\"SAMP_TYPE\"\n\
             \"UNIT\",\"\",\"\",\"m\",\"\",\"\"\n\
             \"TYPE\",\"ID\",\"ID\",\"2DP\",\"X\",\"PA\"\n\
             \"DATA\",\"BH1\",\"S1\",\"0.5\",\"B1\",\"B\"\n\
             \n\
             \"GROUP\",\"ISPT\"\n\
             \"HEADING\",\"LOCA_ID\",\"ISPT_TOP\",\"ISPT_TESN\",\"ISPT_NVAL\"\n\
             \"UNIT\",\"\",\"m\",\"\",\"\"\n\
             \"TYPE\",\"ID\",\"2DP\",\"X\",\"2DP\"\n\
             \"DATA\",\"BH1\",\"1.0\",\"1\",\"24\"\n",
        )
        .file;

        let graph = build_semantic_graph(&file);
        assert_eq!(graph.investigation_points.len(), 1);
        assert_eq!(graph.lithology_observations.len(), 1);
        assert_eq!(graph.samples.len(), 1);
        assert_eq!(graph.field_tests.len(), 1);
        assert!(!graph.classifications.is_empty());
        assert!(graph
            .material_facets
            .iter()
            .any(|f| f.facet == "primary_soil_type"));
    }

    #[test]
    fn finds_investigation_points_for_geol_code() {
        let file = parse_str(
            "\"GROUP\",\"LOCA\"\n\
             \"HEADING\",\"LOCA_ID\"\n\
             \"UNIT\",\"\"\n\
             \"TYPE\",\"ID\"\n\
             \"DATA\",\"BH1\"\n\
             \"DATA\",\"BH2\"\n\
             \n\
             \"GROUP\",\"GEOL\"\n\
             \"HEADING\",\"LOCA_ID\",\"GEOL_TOP\",\"GEOL_BASE\",\"GEOL_LEG\"\n\
             \"UNIT\",\"\",\"m\",\"m\",\"\"\n\
             \"TYPE\",\"ID\",\"2DP\",\"2DP\",\"PA\"\n\
             \"DATA\",\"BH1\",\"0\",\"1\",\"CL\"\n\
             \"DATA\",\"BH2\",\"0\",\"1\",\"SA\"\n",
        )
        .file;

        let points = investigation_points_for_geol_code(&file, "cl");
        assert_eq!(points, vec!["BH1".to_string()]);
    }
}
