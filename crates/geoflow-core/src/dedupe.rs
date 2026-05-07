//! Duplicate borehole detection.
//!
//! Finds LOCA rows that are likely duplicates based on spatial proximity
//! (coordinate distance) or identical IDs across files.

use serde::{Deserialize, Serialize};

use crate::model::{AgsFile, AgsValue};

/// A pair of LOCA rows identified as potential duplicates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DuplicatePair {
    /// File index for the first location (index into the input slice).
    pub file_a: usize,
    /// File index for the second location.
    pub file_b: usize,
    pub loca_id_a: String,
    pub loca_id_b: String,
    /// Euclidean distance between the two points in the same units as the
    /// coordinates (typically metres).  `None` if either row lacks coordinates.
    pub distance_m: Option<f64>,
    pub reason: DuplicateReason,
}

/// Why two boreholes are considered duplicates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DuplicateReason {
    /// Identical LOCA_ID strings across files.
    SameId,
    /// Coordinates within the configured spatial tolerance.
    NearbyCoordinates,
    /// Both same ID and nearby coordinates.
    SameIdAndCoordinates,
}

/// Find potential duplicate LOCA rows within a single file or across multiple files.
///
/// - `tolerance_m`: two boreholes are considered spatially duplicate if their
///   coordinate distance is ≤ this value (in coordinate units, assumed metres).
///   Pass `0.0` to disable spatial checks.
pub fn find_duplicates(
    files: &[&AgsFile],
    labels: &[&str],
    tolerance_m: f64,
) -> Vec<DuplicatePair> {
    let mut pairs: Vec<DuplicatePair> = Vec::new();

    // Collect all LOCA rows with their file index.
    let locations: Vec<LocaEntry> = files
        .iter()
        .enumerate()
        .flat_map(|(file_idx, file)| {
            file.group("LOCA").into_iter().flat_map(move |g| {
                g.rows.iter().filter_map(move |r| {
                    let id = r.get("LOCA_ID").and_then(|v| v.as_text())?.to_string();
                    let e = r.get("LOCA_NATE").and_then(|v| v.as_number());
                    let n = r.get("LOCA_NATN").and_then(|v| v.as_number());
                    Some(LocaEntry {
                        file_idx,
                        loca_id: id,
                        easting: e,
                        northing: n,
                    })
                })
            })
        })
        .collect();

    // O(n²) pairwise comparison — acceptable for typical borehole counts (<10k).
    for i in 0..locations.len() {
        for j in (i + 1)..locations.len() {
            let a = &locations[i];
            let b = &locations[j];

            // Skip intra-file same-ID check if comparing within the same file
            // (intra-file duplicates are caught by built-in validation already).
            let same_file = a.file_idx == b.file_idx;
            let same_id = a.loca_id == b.loca_id;

            let dist = match (a.easting, a.northing, b.easting, b.northing) {
                (Some(ae), Some(an), Some(be), Some(bn)) => {
                    let de = ae - be;
                    let dn = an - bn;
                    Some((de * de + dn * dn).sqrt())
                }
                _ => None,
            };

            let nearby = tolerance_m > 0.0 && dist.map(|d| d <= tolerance_m).unwrap_or(false);

            if same_id && !same_file {
                let reason = if nearby {
                    DuplicateReason::SameIdAndCoordinates
                } else {
                    DuplicateReason::SameId
                };
                pairs.push(DuplicatePair {
                    file_a: a.file_idx,
                    file_b: b.file_idx,
                    loca_id_a: a.loca_id.clone(),
                    loca_id_b: b.loca_id.clone(),
                    distance_m: dist,
                    reason,
                });
            } else if nearby && !same_id {
                // Different IDs but within tolerance — possible re-survey.
                pairs.push(DuplicatePair {
                    file_a: a.file_idx,
                    file_b: b.file_idx,
                    loca_id_a: a.loca_id.clone(),
                    loca_id_b: b.loca_id.clone(),
                    distance_m: dist,
                    reason: DuplicateReason::NearbyCoordinates,
                });
            } else if same_id && same_file {
                // Intra-file same ID: only flag if coordinates also match
                // (the built-in ID uniqueness rule handles the ID-only case).
                if nearby {
                    pairs.push(DuplicatePair {
                        file_a: a.file_idx,
                        file_b: b.file_idx,
                        loca_id_a: a.loca_id.clone(),
                        loca_id_b: b.loca_id.clone(),
                        distance_m: dist,
                        reason: DuplicateReason::SameIdAndCoordinates,
                    });
                }
            }
        }
    }

    // Deduplicate pairs (can arise when same IDs also happen to be nearby).
    pairs.dedup_by(|a, b| {
        a.loca_id_a == b.loca_id_a
            && a.loca_id_b == b.loca_id_b
            && a.file_a == b.file_a
            && a.file_b == b.file_b
    });

    let _ = labels; // reserved for future use in messages
    pairs
}

struct LocaEntry {
    file_idx: usize,
    loca_id: String,
    easting: Option<f64>,
    northing: Option<f64>,
}

// Keep AgsValue in scope for potential future expansion.
const _: () = {
    let _ = std::mem::size_of::<AgsValue>();
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ags::parse_str;

    fn make(ags: &str) -> AgsFile {
        parse_str(ags).file
    }

    const FILE_A: &str = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","500000.00","200000.00"
"DATA","BH02","500100.00","200000.00"
"#;

    const FILE_B_DUP_ID: &str = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","500200.00","200000.00"
"#;

    const FILE_C_NEARBY: &str = r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH03","500005.00","200000.00"
"#;

    #[test]
    fn detects_same_id_across_files() {
        let a = make(FILE_A);
        let b = make(FILE_B_DUP_ID);
        let pairs = find_duplicates(&[&a, &b], &["a.ags", "b.ags"], 0.0);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].loca_id_a, "BH01");
        assert_eq!(pairs[0].reason, DuplicateReason::SameId);
    }

    #[test]
    fn detects_nearby_different_ids() {
        let a = make(FILE_A);
        let c = make(FILE_C_NEARBY);
        // BH01 at 500000,200000 vs BH03 at 500005,200000 → 5 m apart.
        let pairs = find_duplicates(&[&a, &c], &["a.ags", "c.ags"], 10.0);
        assert!(
            pairs
                .iter()
                .any(|p| p.reason == DuplicateReason::NearbyCoordinates),
            "expected NearbyCoordinates pair, got {pairs:?}"
        );
    }

    #[test]
    fn no_duplicates_for_well_separated_files() {
        let a = make(FILE_A);
        let far = make(
            r#""GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH99","600000.00","300000.00"
"#,
        );
        let pairs = find_duplicates(&[&a, &far], &["a.ags", "far.ags"], 10.0);
        assert!(pairs.is_empty(), "unexpected duplicates: {pairs:?}");
    }

    #[test]
    fn no_duplicates_within_single_clean_file() {
        let a = make(FILE_A);
        let pairs = find_duplicates(&[&a], &["a.ags"], 1.0);
        assert!(pairs.is_empty());
    }

    #[test]
    fn distance_is_populated_when_coords_available() {
        let a = make(FILE_A);
        let b = make(FILE_B_DUP_ID);
        let pairs = find_duplicates(&[&a, &b], &["a.ags", "b.ags"], 0.0);
        // BH01: 500000 vs 500200 → 200 m.
        let d = pairs[0].distance_m.expect("expected distance");
        assert!((d - 200.0).abs() < 0.1, "expected ~200 m, got {d}");
    }
}
