//! DIGGS (Data Interchange for Geotechnical and Geoenvironmental Specialists) support.
//!
//! Handles parsing DIGGS 2.6 XML and converting to/from our internal model.

use crate::model::{AgsFile, AgsGroup, AgsHeading, AgsRow, AgsType, AgsValue};
use anyhow::Result;
use indexmap::IndexMap;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// AGS 4 reference/lookup groups round-tripped via `<MetadataGroup>` XML wrapper.
const METADATA_GROUPS: &[&str] = &["ABBR", "UNIT", "TYPE", "DICT", "HOLE"];

/// AGS groups with native DIGGS element mappings (waves A–D).
const NATIVE_GROUPS: &[&str] = &[
    "PROJ", "LOCA", "GEOL", "SAMP", "ISPT", "WSTK", // wave A
    "LLPL", "LDEN", "LPDN", "LPEN", "LCON", "LCBR", // wave B lab tests
    // wave C in-situ tests
    "IDEN", "IVAN", "IPRM", "IPRT", "IRDX", "ICBR", "CDIA", "CMET",
    // wave D monitoring & instrumentation
    "MOND", "PREM", "PRTM", "STCN", "RELD",
];

fn is_metadata_group(name: &str) -> bool {
    METADATA_GROUPS.contains(&name)
}

fn is_native_group(name: &str) -> bool {
    NATIVE_GROUPS.contains(&name)
}

/// Report produced after AGS→DIGGS conversion.
///
/// - `generic_groups`: groups that had no native DIGGS element and were
///   round-tripped losslessly via a `<DataGroup>` wrapper.
/// - `unmapped_fields`: fields within natively-mapped groups that were
///   not carried into DIGGS (informational; not lossy because
///   `<DataGroup>` still preserves the raw row for any group).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConversionReport {
    /// Groups wrapped via the generic `<DataGroup>` element.
    pub generic_groups: Vec<String>,
    /// Fields within natively-mapped groups not carried to DIGGS.
    pub unmapped_fields: BTreeMap<String, Vec<String>>,
}

/// Parse a DIGGS XML file into our internal model.
pub fn read(bytes: &[u8]) -> Result<AgsFile> {
    let mut file = AgsFile::default();
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);
    // Treat self-closing tags (e.g. <heading name="..."/>) the same as
    // <heading></heading> so the read loop only has to handle Start/End.
    reader.config_mut().expand_empty_elements = true;

    let mut buf = Vec::new();
    let mut path: Vec<String> = Vec::new();
    let mut project_row: Option<IndexMap<String, AgsValue>> = None;
    let mut loca_row: Option<IndexMap<String, AgsValue>> = None;
    let mut geol_row: Option<IndexMap<String, AgsValue>> = None;
    let mut samp_row: Option<IndexMap<String, AgsValue>> = None;
    let mut ispt_row: Option<IndexMap<String, AgsValue>> = None;
    let mut wstk_row: Option<IndexMap<String, AgsValue>> = None;
    // wave B lab test rows
    let mut llpl_row: Option<IndexMap<String, AgsValue>> = None;
    let mut lden_row: Option<IndexMap<String, AgsValue>> = None;
    let mut lpdn_row: Option<IndexMap<String, AgsValue>> = None;
    let mut lpen_row: Option<IndexMap<String, AgsValue>> = None;
    let mut lcon_row: Option<IndexMap<String, AgsValue>> = None;
    let mut lcbr_row: Option<IndexMap<String, AgsValue>> = None;
    // wave C in-situ test rows
    let mut iden_row: Option<IndexMap<String, AgsValue>> = None;
    let mut ivan_row: Option<IndexMap<String, AgsValue>> = None;
    let mut iprm_row: Option<IndexMap<String, AgsValue>> = None;
    let mut iprt_row: Option<IndexMap<String, AgsValue>> = None;
    let mut irdx_row: Option<IndexMap<String, AgsValue>> = None;
    let mut icbr_row: Option<IndexMap<String, AgsValue>> = None;
    let mut cdia_row: Option<IndexMap<String, AgsValue>> = None;
    let mut cmet_row: Option<IndexMap<String, AgsValue>> = None;
    // wave D monitoring rows
    let mut mond_row: Option<IndexMap<String, AgsValue>> = None;
    let mut prem_row: Option<IndexMap<String, AgsValue>> = None;
    let mut prtm_row: Option<IndexMap<String, AgsValue>> = None;
    let mut stcn_row: Option<IndexMap<String, AgsValue>> = None;
    let mut reld_row: Option<IndexMap<String, AgsValue>> = None;

    // Generic group state — shared by MetadataGroup and DataGroup elements.
    let mut meta_group: Option<MetaGroupState> = None;
    let mut meta_field_name: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => {
                let name = local_name(e.name().as_ref());
                match name.as_str() {
                    "Project" => project_row = Some(IndexMap::new()),
                    "SamplingLocation" => loca_row = Some(IndexMap::new()),
                    "Lithology" => geol_row = Some(IndexMap::new()),
                    "Sample" => samp_row = Some(IndexMap::new()),
                    "SPTTest" => ispt_row = Some(IndexMap::new()),
                    "WaterStrike" => wstk_row = Some(IndexMap::new()),
                    // wave B
                    "AttenbergLimits" => llpl_row = Some(IndexMap::new()),
                    "BulkDensityTest" => lden_row = Some(IndexMap::new()),
                    "ParticleDensityTest" => lpdn_row = Some(IndexMap::new()),
                    "PenetratorTest" => lpen_row = Some(IndexMap::new()),
                    "OedometerTest" => lcon_row = Some(IndexMap::new()),
                    "CBRTest" => lcbr_row = Some(IndexMap::new()),
                    // wave C
                    "InSituDensityTest" => iden_row = Some(IndexMap::new()),
                    "VaneTest" => ivan_row = Some(IndexMap::new()),
                    "PermeabilityTest" => iprm_row = Some(IndexMap::new()),
                    "PressuremeterTest" => iprt_row = Some(IndexMap::new()),
                    "RedoxTest" => irdx_row = Some(IndexMap::new()),
                    "InSituCBRTest" => icbr_row = Some(IndexMap::new()),
                    "CasingRecord" => cdia_row = Some(IndexMap::new()),
                    "DrillingMethod" => cmet_row = Some(IndexMap::new()),
                    // wave D
                    "MonitoringReading" => mond_row = Some(IndexMap::new()),
                    "PiezometerReading" => prem_row = Some(IndexMap::new()),
                    "PressureTempReading" => prtm_row = Some(IndexMap::new()),
                    "StaticConeTest" => stcn_row = Some(IndexMap::new()),
                    "RelativeDensityTest" => reld_row = Some(IndexMap::new()),
                    "MetadataGroup" | "DataGroup" => {
                        meta_group = Some(MetaGroupState::from_attrs(&e)?);
                    }
                    "heading" => {
                        if let Some(state) = meta_group.as_mut() {
                            state.start_heading(&e)?;
                        }
                    }
                    "row" => {
                        if let Some(state) = meta_group.as_mut() {
                            state.start_row();
                        }
                    }
                    "field" if meta_group.is_some() => {
                        meta_field_name = field_attr_name(&e)?;
                    }
                    _ => {}
                }
                path.push(name);
            }
            Event::End(e) => {
                match local_name(e.name().as_ref()).as_str() {
                    "Project" => {
                        if let Some(row) = project_row.take() {
                            push_full_row(&mut file, "PROJ", proj_headings(), row);
                        }
                    }
                    "SamplingLocation" => {
                        if let Some(row) = loca_row.take() {
                            push_full_row(&mut file, "LOCA", loca_headings(), row);
                        }
                    }
                    "Lithology" => {
                        if let Some(row) = geol_row.take() {
                            push_full_row(&mut file, "GEOL", geol_headings(), row);
                        }
                    }
                    "Sample" => {
                        if let Some(row) = samp_row.take() {
                            push_full_row(&mut file, "SAMP", samp_headings(), row);
                        }
                    }
                    "SPTTest" => {
                        if let Some(row) = ispt_row.take() {
                            push_full_row(&mut file, "ISPT", ispt_headings(), row);
                        }
                    }
                    "WaterStrike" => {
                        if let Some(row) = wstk_row.take() {
                            push_full_row(&mut file, "WSTK", wstk_headings(), row);
                        }
                    }
                    // wave B
                    "AttenbergLimits" => {
                        if let Some(row) = llpl_row.take() {
                            push_full_row(&mut file, "LLPL", llpl_headings(), row);
                        }
                    }
                    "BulkDensityTest" => {
                        if let Some(row) = lden_row.take() {
                            push_full_row(&mut file, "LDEN", lden_headings(), row);
                        }
                    }
                    "ParticleDensityTest" => {
                        if let Some(row) = lpdn_row.take() {
                            push_full_row(&mut file, "LPDN", lpdn_headings(), row);
                        }
                    }
                    "PenetratorTest" => {
                        if let Some(row) = lpen_row.take() {
                            push_full_row(&mut file, "LPEN", lpen_headings(), row);
                        }
                    }
                    "OedometerTest" => {
                        if let Some(row) = lcon_row.take() {
                            push_full_row(&mut file, "LCON", lcon_headings(), row);
                        }
                    }
                    "CBRTest" => {
                        if let Some(row) = lcbr_row.take() {
                            push_full_row(&mut file, "LCBR", lcbr_headings(), row);
                        }
                    }
                    // wave C
                    "InSituDensityTest" => {
                        if let Some(row) = iden_row.take() {
                            push_full_row(&mut file, "IDEN", iden_headings(), row);
                        }
                    }
                    "VaneTest" => {
                        if let Some(row) = ivan_row.take() {
                            push_full_row(&mut file, "IVAN", ivan_headings(), row);
                        }
                    }
                    "PermeabilityTest" => {
                        if let Some(row) = iprm_row.take() {
                            push_full_row(&mut file, "IPRM", iprm_headings(), row);
                        }
                    }
                    "PressuremeterTest" => {
                        if let Some(row) = iprt_row.take() {
                            push_full_row(&mut file, "IPRT", iprt_headings(), row);
                        }
                    }
                    "RedoxTest" => {
                        if let Some(row) = irdx_row.take() {
                            push_full_row(&mut file, "IRDX", irdx_headings(), row);
                        }
                    }
                    "InSituCBRTest" => {
                        if let Some(row) = icbr_row.take() {
                            push_full_row(&mut file, "ICBR", icbr_headings(), row);
                        }
                    }
                    "CasingRecord" => {
                        if let Some(row) = cdia_row.take() {
                            push_full_row(&mut file, "CDIA", cdia_headings(), row);
                        }
                    }
                    "DrillingMethod" => {
                        if let Some(row) = cmet_row.take() {
                            push_full_row(&mut file, "CMET", cmet_headings(), row);
                        }
                    }
                    // wave D
                    "MonitoringReading" => {
                        if let Some(row) = mond_row.take() {
                            push_full_row(&mut file, "MOND", mond_headings(), row);
                        }
                    }
                    "PiezometerReading" => {
                        if let Some(row) = prem_row.take() {
                            push_full_row(&mut file, "PREM", prem_headings(), row);
                        }
                    }
                    "PressureTempReading" => {
                        if let Some(row) = prtm_row.take() {
                            push_full_row(&mut file, "PRTM", prtm_headings(), row);
                        }
                    }
                    "StaticConeTest" => {
                        if let Some(row) = stcn_row.take() {
                            push_full_row(&mut file, "STCN", stcn_headings(), row);
                        }
                    }
                    "RelativeDensityTest" => {
                        if let Some(row) = reld_row.take() {
                            push_full_row(&mut file, "RELD", reld_headings(), row);
                        }
                    }
                    "MetadataGroup" | "DataGroup" => {
                        if let Some(state) = meta_group.take() {
                            state.flush(&mut file);
                        }
                    }
                    "row" => {
                        if let Some(state) = meta_group.as_mut() {
                            state.finish_row();
                        }
                    }
                    "field" => {
                        meta_field_name = None;
                    }
                    _ => {}
                }
                path.pop();
            }
            Event::Text(e) => {
                let text = e.unescape()?.into_owned();
                if text.is_empty() {
                    buf.clear();
                    continue;
                }
                if let Some(state) = meta_group.as_mut() {
                    if let Some(field) = meta_field_name.as_deref() {
                        state.set_current_field(field, &text);
                        buf.clear();
                        continue;
                    }
                }
                if let Some(tag) = path.last().map(String::as_str) {
                    if let Some(row) = project_row.as_mut() {
                        match tag {
                            "name" => {
                                row.insert("PROJ_ID".into(), AgsValue::Text(text));
                            }
                            "description" => {
                                row.insert("PROJ_NAME".into(), AgsValue::Text(text));
                            }
                            _ => {}
                        }
                    } else if let Some(row) = loca_row.as_mut() {
                        match tag {
                            "name" => {
                                row.insert("LOCA_ID".into(), AgsValue::Text(text));
                            }
                            "easting" => {
                                row.insert("LOCA_NATE".into(), parse_value(&text));
                            }
                            "northing" => {
                                row.insert("LOCA_NATN".into(), parse_value(&text));
                            }
                            _ => {}
                        }
                    } else if let Some(row) = geol_row.as_mut() {
                        match tag {
                            "locationId" => {
                                row.insert("LOCA_ID".into(), AgsValue::Text(text));
                            }
                            "topDepth" => {
                                row.insert("GEOL_TOP".into(), parse_value(&text));
                            }
                            "baseDepth" => {
                                row.insert("GEOL_BASE".into(), parse_value(&text));
                            }
                            "description" => {
                                row.insert("GEOL_DESC".into(), AgsValue::Text(text));
                            }
                            "legendCode" => {
                                row.insert("GEOL_LEG".into(), AgsValue::Text(text));
                            }
                            _ => {}
                        }
                    } else if let Some(row) = samp_row.as_mut() {
                        match tag {
                            "locationId" => {
                                row.insert("LOCA_ID".into(), AgsValue::Text(text));
                            }
                            "sampleId" => {
                                row.insert("SAMP_ID".into(), AgsValue::Text(text));
                            }
                            "sampleType" => {
                                row.insert("SAMP_TYPE".into(), AgsValue::Text(text));
                            }
                            _ => {}
                        }
                    } else if let Some(row) = ispt_row.as_mut() {
                        match tag {
                            "locationId" => {
                                row.insert("LOCA_ID".into(), AgsValue::Text(text));
                            }
                            "testDepth" => {
                                row.insert("ISPT_TOP".into(), parse_value(&text));
                            }
                            "blowCount" => {
                                row.insert("ISPT_NVAL".into(), parse_value(&text));
                            }
                            _ => {}
                        }
                    } else if let Some(row) = wstk_row.as_mut() {
                        match tag {
                            "locationId" => {
                                row.insert("LOCA_ID".into(), AgsValue::Text(text));
                            }
                            "strikeDepth" => {
                                row.insert("WSTK_DPTH".into(), parse_value(&text));
                            }
                            _ => {}
                        }
                    } else if let Some(row) = llpl_row.as_mut() {
                        match tag {
                            "locationId" => {
                                row.insert("LOCA_ID".into(), AgsValue::Text(text));
                            }
                            "sampleId" => {
                                row.insert("SAMP_ID".into(), AgsValue::Text(text));
                            }
                            "sampleRef" => {
                                row.insert("SAMP_REF".into(), AgsValue::Text(text));
                            }
                            "liquidLimit" => {
                                row.insert("LLPL_LL".into(), parse_value(&text));
                            }
                            "plasticLimit" => {
                                row.insert("LLPL_PL".into(), parse_value(&text));
                            }
                            "plasticityIndex" => {
                                row.insert("LLPL_PI".into(), parse_value(&text));
                            }
                            "percentPassing425" => {
                                row.insert("LLPL_425".into(), parse_value(&text));
                            }
                            _ => {}
                        }
                    } else if let Some(row) = lden_row.as_mut() {
                        match tag {
                            "locationId" => {
                                row.insert("LOCA_ID".into(), AgsValue::Text(text));
                            }
                            "sampleId" => {
                                row.insert("SAMP_ID".into(), AgsValue::Text(text));
                            }
                            "sampleRef" => {
                                row.insert("SAMP_REF".into(), AgsValue::Text(text));
                            }
                            "bulkDensity" => {
                                row.insert("LDEN_BULK".into(), parse_value(&text));
                            }
                            "dryDensity" => {
                                row.insert("LDEN_BDEN".into(), parse_value(&text));
                            }
                            "moistureContent" => {
                                row.insert("LDEN_MC".into(), parse_value(&text));
                            }
                            _ => {}
                        }
                    } else if let Some(row) = lpdn_row.as_mut() {
                        match tag {
                            "locationId" => {
                                row.insert("LOCA_ID".into(), AgsValue::Text(text));
                            }
                            "sampleId" => {
                                row.insert("SAMP_ID".into(), AgsValue::Text(text));
                            }
                            "sampleRef" => {
                                row.insert("SAMP_REF".into(), AgsValue::Text(text));
                            }
                            "particleDensity" => {
                                row.insert("LPDN_PD".into(), parse_value(&text));
                            }
                            "moistureContent" => {
                                row.insert("LPDN_MCMC".into(), parse_value(&text));
                            }
                            _ => {}
                        }
                    } else if let Some(row) = lpen_row.as_mut() {
                        match tag {
                            "locationId" => {
                                row.insert("LOCA_ID".into(), AgsValue::Text(text));
                            }
                            "sampleId" => {
                                row.insert("SAMP_ID".into(), AgsValue::Text(text));
                            }
                            "sampleRef" => {
                                row.insert("SAMP_REF".into(), AgsValue::Text(text));
                            }
                            "testDepth" => {
                                row.insert("LPEN_DEPTH".into(), parse_value(&text));
                            }
                            "undrainedStrength" => {
                                row.insert("LPEN_STRE".into(), parse_value(&text));
                            }
                            _ => {}
                        }
                    } else if let Some(row) = lcon_row.as_mut() {
                        match tag {
                            "locationId" => {
                                row.insert("LOCA_ID".into(), AgsValue::Text(text));
                            }
                            "sampleId" => {
                                row.insert("SAMP_ID".into(), AgsValue::Text(text));
                            }
                            "sampleRef" => {
                                row.insert("SAMP_REF".into(), AgsValue::Text(text));
                            }
                            "verticalStress" => {
                                row.insert("LCON_VERT".into(), parse_value(&text));
                            }
                            "voidRatio" => {
                                row.insert("LCON_VOID".into(), parse_value(&text));
                            }
                            "compressionCoefficient" => {
                                row.insert("LCON_RHVC".into(), parse_value(&text));
                            }
                            _ => {}
                        }
                    } else if let Some(row) = lcbr_row.as_mut() {
                        match tag {
                            "locationId" => {
                                row.insert("LOCA_ID".into(), AgsValue::Text(text));
                            }
                            "sampleId" => {
                                row.insert("SAMP_ID".into(), AgsValue::Text(text));
                            }
                            "sampleRef" => {
                                row.insert("SAMP_REF".into(), AgsValue::Text(text));
                            }
                            "condition" => {
                                row.insert("LCBR_COND".into(), AgsValue::Text(text));
                            }
                            "cbrValue" => {
                                row.insert("LCBR_CBR".into(), parse_value(&text));
                            }
                            _ => {}
                        }
                    // wave C
                    } else if let Some(row) = iden_row.as_mut() {
                        match tag {
                            "locationId" => { row.insert("LOCA_ID".into(), AgsValue::Text(text)); }
                            "testDepth" => { row.insert("IDEN_DPTH".into(), parse_value(&text)); }
                            "diameter" => { row.insert("IDEN_DIAM".into(), parse_value(&text)); }
                            "moistureContent" => { row.insert("IDEN_MC".into(), parse_value(&text)); }
                            "dryDensity" => { row.insert("IDEN_DBUL".into(), parse_value(&text)); }
                            _ => {}
                        }
                    } else if let Some(row) = ivan_row.as_mut() {
                        match tag {
                            "locationId" => { row.insert("LOCA_ID".into(), AgsValue::Text(text)); }
                            "testDepth" => { row.insert("IVAN_DPTH".into(), parse_value(&text)); }
                            "testNumber" => { row.insert("IVAN_TESN".into(), AgsValue::Text(text)); }
                            "undrainedStrength" => { row.insert("IVAN_STEN".into(), parse_value(&text)); }
                            "remoulded Strength" => { row.insert("IVAN_RTEN".into(), parse_value(&text)); }
                            _ => {}
                        }
                    } else if let Some(row) = iprm_row.as_mut() {
                        match tag {
                            "locationId" => { row.insert("LOCA_ID".into(), AgsValue::Text(text)); }
                            "topDepth" => { row.insert("IPRM_TOP".into(), parse_value(&text)); }
                            "bottomDepth" => { row.insert("IPRM_BOT".into(), parse_value(&text)); }
                            "testType" => { row.insert("IPRM_TYPE".into(), AgsValue::Text(text)); }
                            "permeability" => { row.insert("IPRM_PERM".into(), parse_value(&text)); }
                            _ => {}
                        }
                    } else if let Some(row) = iprt_row.as_mut() {
                        match tag {
                            "locationId" => { row.insert("LOCA_ID".into(), AgsValue::Text(text)); }
                            "testDepth" => { row.insert("IPRT_DPTH".into(), parse_value(&text)); }
                            "testType" => { row.insert("IPRT_TYPE".into(), AgsValue::Text(text)); }
                            "limitPressure" => { row.insert("IPRT_PL".into(), parse_value(&text)); }
                            "liftoffPressure" => { row.insert("IPRT_LLD".into(), parse_value(&text)); }
                            _ => {}
                        }
                    } else if let Some(row) = irdx_row.as_mut() {
                        match tag {
                            "locationId" => { row.insert("LOCA_ID".into(), AgsValue::Text(text)); }
                            "testDepth" => { row.insert("IRDX_DPTH".into(), parse_value(&text)); }
                            "redoxPotential" => { row.insert("IRDX_RES".into(), parse_value(&text)); }
                            _ => {}
                        }
                    } else if let Some(row) = icbr_row.as_mut() {
                        match tag {
                            "locationId" => { row.insert("LOCA_ID".into(), AgsValue::Text(text)); }
                            "testDepth" => { row.insert("ICBR_DPTH".into(), parse_value(&text)); }
                            "cbrValue1" => { row.insert("ICBR_CBR1".into(), parse_value(&text)); }
                            "cbrValue2" => { row.insert("ICBR_CBR2".into(), parse_value(&text)); }
                            _ => {}
                        }
                    } else if let Some(row) = cdia_row.as_mut() {
                        match tag {
                            "locationId" => { row.insert("LOCA_ID".into(), AgsValue::Text(text)); }
                            "depth" => { row.insert("CDIA_DPTH".into(), parse_value(&text)); }
                            "diameter" => { row.insert("CDIA_DIAM".into(), parse_value(&text)); }
                            "casingType" => { row.insert("CDIA_TYPE".into(), AgsValue::Text(text)); }
                            _ => {}
                        }
                    } else if let Some(row) = cmet_row.as_mut() {
                        match tag {
                            "locationId" => { row.insert("LOCA_ID".into(), AgsValue::Text(text)); }
                            "topDepth" => { row.insert("CMET_TOP".into(), parse_value(&text)); }
                            "baseDepth" => { row.insert("CMET_BASE".into(), parse_value(&text)); }
                            "method" => { row.insert("CMET_METH".into(), AgsValue::Text(text)); }
                            _ => {}
                        }
                    // wave D
                    } else if let Some(row) = mond_row.as_mut() {
                        match tag {
                            "locationId" => { row.insert("LOCA_ID".into(), AgsValue::Text(text)); }
                            "depth" => { row.insert("MOND_DPTH".into(), parse_value(&text)); }
                            "instrumentType" => { row.insert("MOND_TYPE".into(), AgsValue::Text(text)); }
                            "measurement" => { row.insert("MOND_MEAS".into(), parse_value(&text)); }
                            "readingDate" => { row.insert("MOND_TREF".into(), AgsValue::Text(text)); }
                            _ => {}
                        }
                    } else if let Some(row) = prem_row.as_mut() {
                        match tag {
                            "locationId" => { row.insert("LOCA_ID".into(), AgsValue::Text(text)); }
                            "readingDate" => { row.insert("PREM_DATE".into(), AgsValue::Text(text)); }
                            "hydraulicHead" => { row.insert("PREM_HEAD".into(), parse_value(&text)); }
                            "installDepth" => { row.insert("PREM_DPTH".into(), parse_value(&text)); }
                            _ => {}
                        }
                    } else if let Some(row) = prtm_row.as_mut() {
                        match tag {
                            "locationId" => { row.insert("LOCA_ID".into(), AgsValue::Text(text)); }
                            "readingDate" => { row.insert("PRTM_DATE".into(), AgsValue::Text(text)); }
                            "pressure" => { row.insert("PRTM_PRES".into(), parse_value(&text)); }
                            "temperature" => { row.insert("PRTM_TEMP".into(), parse_value(&text)); }
                            _ => {}
                        }
                    } else if let Some(row) = stcn_row.as_mut() {
                        match tag {
                            "locationId" => { row.insert("LOCA_ID".into(), AgsValue::Text(text)); }
                            "testDepth" => { row.insert("STCN_DPTH".into(), parse_value(&text)); }
                            "conePenetrationResistance" => { row.insert("STCN_RES".into(), parse_value(&text)); }
                            "frictionResistance" => { row.insert("STCN_FRES".into(), parse_value(&text)); }
                            "correctedConeResistance" => { row.insert("STCN_QT".into(), parse_value(&text)); }
                            _ => {}
                        }
                    } else if let Some(row) = reld_row.as_mut() {
                        match tag {
                            "locationId" => { row.insert("LOCA_ID".into(), AgsValue::Text(text)); }
                            "sampleDepth" => { row.insert("SAMP_TOP".into(), parse_value(&text)); }
                            "maximumDryDensity" => { row.insert("RELD_DMAX".into(), parse_value(&text)); }
                            "minimumDryDensity" => { row.insert("RELD_DMIN".into(), parse_value(&text)); }
                            "dryDensity" => { row.insert("RELD_DRY".into(), parse_value(&text)); }
                            _ => {}
                        }
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(file)
}

/// Serialize our internal model to DIGGS XML.
pub fn write(file: &AgsFile) -> Result<(String, ConversionReport)> {
    let mut report = ConversionReport::default();
    let mut xml = String::new();
    xml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    xml.push_str("<Diggs xmlns=\"http://diggsml.org/schemas/2.6\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:gml=\"http://www.opengis.net/gml\">\n");

    // Wave A Mapping: PROJ -> Project, LOCA -> SamplingLocation, GEOL -> Stratigraphy
    if let Some(proj) = file.group("PROJ") {
        if let Some(row) = proj.rows.first() {
            xml.push_str("  <Project>\n");
            if let Some(id) = row.get("PROJ_ID").and_then(|v| v.as_text()) {
                xml.push_str(&format!("    <gml:name>{}</gml:name>\n", id));
            }
            if let Some(name) = row.get("PROJ_NAME").and_then(value_as_string) {
                xml.push_str(&format!(
                    "    <gml:description>{}</gml:description>\n",
                    name
                ));
            }
            xml.push_str("  </Project>\n");
        }
    }

    if let Some(loca) = file.group("LOCA") {
        for row in &loca.rows {
            xml.push_str("  <SamplingLocation>\n");
            if let Some(id) = row.get("LOCA_ID").and_then(|v| v.as_text()) {
                xml.push_str(&format!("    <gml:name>{}</gml:name>\n", id));
            }
            if let Some(easting) = row.get("LOCA_NATE").and_then(value_as_string) {
                xml.push_str(&format!("    <easting>{}</easting>\n", easting));
            }
            if let Some(northing) = row.get("LOCA_NATN").and_then(value_as_string) {
                xml.push_str(&format!("    <northing>{}</northing>\n", northing));
            }
            xml.push_str("  </SamplingLocation>\n");
        }
    }

    if let Some(geol) = file.group("GEOL") {
        for row in &geol.rows {
            xml.push_str("  <Lithology>\n");
            if let Some(loca_id) = row.get("LOCA_ID").and_then(value_as_string) {
                xml.push_str(&format!("    <locationId>{}</locationId>\n", loca_id));
            }
            if let Some(top) = row.get("GEOL_TOP").and_then(value_as_string) {
                xml.push_str(&format!("    <topDepth>{}</topDepth>\n", top));
            }
            if let Some(base) = row.get("GEOL_BASE").and_then(value_as_string) {
                xml.push_str(&format!("    <baseDepth>{}</baseDepth>\n", base));
            }
            if let Some(desc) = row.get("GEOL_DESC").and_then(value_as_string) {
                xml.push_str(&format!("    <description>{}</description>\n", desc));
            }
            if let Some(leg) = row.get("GEOL_LEG").and_then(value_as_string) {
                xml.push_str(&format!("    <legendCode>{}</legendCode>\n", leg));
            }
            xml.push_str("  </Lithology>\n");
        }
    }

    if let Some(samp) = file.group("SAMP") {
        for row in &samp.rows {
            xml.push_str("  <Sample>\n");
            if let Some(loca_id) = row.get("LOCA_ID").and_then(value_as_string) {
                xml.push_str(&format!("    <locationId>{}</locationId>\n", loca_id));
            }
            if let Some(sample_id) = row.get("SAMP_ID").and_then(value_as_string) {
                xml.push_str(&format!("    <sampleId>{}</sampleId>\n", sample_id));
            }
            if let Some(sample_type) = row.get("SAMP_TYPE").and_then(value_as_string) {
                xml.push_str(&format!("    <sampleType>{}</sampleType>\n", sample_type));
            }
            xml.push_str("  </Sample>\n");
        }
    }

    if let Some(ispt) = file.group("ISPT") {
        for row in &ispt.rows {
            xml.push_str("  <SPTTest>\n");
            if let Some(loca_id) = row.get("LOCA_ID").and_then(value_as_string) {
                xml.push_str(&format!("    <locationId>{}</locationId>\n", loca_id));
            }
            if let Some(depth) = row.get("ISPT_TOP").and_then(value_as_string) {
                xml.push_str(&format!("    <testDepth>{}</testDepth>\n", depth));
            }
            if let Some(nval) = row.get("ISPT_NVAL").and_then(value_as_string) {
                xml.push_str(&format!("    <blowCount>{}</blowCount>\n", nval));
            }
            xml.push_str("  </SPTTest>\n");
        }
    }

    if let Some(wstk) = file.group("WSTK") {
        for row in &wstk.rows {
            xml.push_str("  <WaterStrike>\n");
            if let Some(loca_id) = row.get("LOCA_ID").and_then(value_as_string) {
                xml.push_str(&format!("    <locationId>{}</locationId>\n", loca_id));
            }
            if let Some(depth) = row.get("WSTK_DPTH").and_then(value_as_string) {
                xml.push_str(&format!("    <strikeDepth>{}</strikeDepth>\n", depth));
            }
            xml.push_str("  </WaterStrike>\n");
        }
    }

    // Wave B lab test groups.
    if let Some(g) = file.group("LLPL") {
        for row in &g.rows {
            xml.push_str("  <AttenbergLimits>\n");
            emit_lab_common(&mut xml, row);
            emit_opt(&mut xml, row, "LLPL_LL", "liquidLimit");
            emit_opt(&mut xml, row, "LLPL_PL", "plasticLimit");
            emit_opt(&mut xml, row, "LLPL_PI", "plasticityIndex");
            emit_opt(&mut xml, row, "LLPL_425", "percentPassing425");
            xml.push_str("  </AttenbergLimits>\n");
        }
    }
    if let Some(g) = file.group("LDEN") {
        for row in &g.rows {
            xml.push_str("  <BulkDensityTest>\n");
            emit_lab_common(&mut xml, row);
            emit_opt(&mut xml, row, "LDEN_BULK", "bulkDensity");
            emit_opt(&mut xml, row, "LDEN_BDEN", "dryDensity");
            emit_opt(&mut xml, row, "LDEN_MC", "moistureContent");
            xml.push_str("  </BulkDensityTest>\n");
        }
    }
    if let Some(g) = file.group("LPDN") {
        for row in &g.rows {
            xml.push_str("  <ParticleDensityTest>\n");
            emit_lab_common(&mut xml, row);
            emit_opt(&mut xml, row, "LPDN_PD", "particleDensity");
            emit_opt(&mut xml, row, "LPDN_MCMC", "moistureContent");
            xml.push_str("  </ParticleDensityTest>\n");
        }
    }
    if let Some(g) = file.group("LPEN") {
        for row in &g.rows {
            xml.push_str("  <PenetratorTest>\n");
            emit_lab_common(&mut xml, row);
            emit_opt(&mut xml, row, "LPEN_DEPTH", "testDepth");
            emit_opt(&mut xml, row, "LPEN_STRE", "undrainedStrength");
            xml.push_str("  </PenetratorTest>\n");
        }
    }
    if let Some(g) = file.group("LCON") {
        for row in &g.rows {
            xml.push_str("  <OedometerTest>\n");
            emit_lab_common(&mut xml, row);
            emit_opt(&mut xml, row, "LCON_VERT", "verticalStress");
            emit_opt(&mut xml, row, "LCON_VOID", "voidRatio");
            emit_opt(&mut xml, row, "LCON_RHVC", "compressionCoefficient");
            xml.push_str("  </OedometerTest>\n");
        }
    }
    if let Some(g) = file.group("LCBR") {
        for row in &g.rows {
            xml.push_str("  <CBRTest>\n");
            emit_lab_common(&mut xml, row);
            emit_opt(&mut xml, row, "LCBR_COND", "condition");
            emit_opt(&mut xml, row, "LCBR_CBR", "cbrValue");
            xml.push_str("  </CBRTest>\n");
        }
    }

    // Wave C – in-situ tests.
    if let Some(g) = file.group("IDEN") {
        for row in &g.rows {
            xml.push_str("  <InSituDensityTest>\n");
            emit_opt(&mut xml, row, "LOCA_ID", "locationId");
            emit_opt(&mut xml, row, "IDEN_DPTH", "testDepth");
            emit_opt(&mut xml, row, "IDEN_DIAM", "diameter");
            emit_opt(&mut xml, row, "IDEN_MC", "moistureContent");
            emit_opt(&mut xml, row, "IDEN_DBUL", "dryDensity");
            xml.push_str("  </InSituDensityTest>\n");
        }
    }
    if let Some(g) = file.group("IVAN") {
        for row in &g.rows {
            xml.push_str("  <VaneTest>\n");
            emit_opt(&mut xml, row, "LOCA_ID", "locationId");
            emit_opt(&mut xml, row, "IVAN_DPTH", "testDepth");
            emit_opt(&mut xml, row, "IVAN_TESN", "testNumber");
            emit_opt(&mut xml, row, "IVAN_STEN", "undrainedStrength");
            emit_opt(&mut xml, row, "IVAN_RTEN", "remoulded Strength");
            xml.push_str("  </VaneTest>\n");
        }
    }
    if let Some(g) = file.group("IPRM") {
        for row in &g.rows {
            xml.push_str("  <PermeabilityTest>\n");
            emit_opt(&mut xml, row, "LOCA_ID", "locationId");
            emit_opt(&mut xml, row, "IPRM_TOP", "topDepth");
            emit_opt(&mut xml, row, "IPRM_BOT", "bottomDepth");
            emit_opt(&mut xml, row, "IPRM_TYPE", "testType");
            emit_opt(&mut xml, row, "IPRM_PERM", "permeability");
            xml.push_str("  </PermeabilityTest>\n");
        }
    }
    if let Some(g) = file.group("IPRT") {
        for row in &g.rows {
            xml.push_str("  <PressuremeterTest>\n");
            emit_opt(&mut xml, row, "LOCA_ID", "locationId");
            emit_opt(&mut xml, row, "IPRT_DPTH", "testDepth");
            emit_opt(&mut xml, row, "IPRT_TYPE", "testType");
            emit_opt(&mut xml, row, "IPRT_PL", "limitPressure");
            emit_opt(&mut xml, row, "IPRT_LLD", "liftoffPressure");
            xml.push_str("  </PressuremeterTest>\n");
        }
    }
    if let Some(g) = file.group("IRDX") {
        for row in &g.rows {
            xml.push_str("  <RedoxTest>\n");
            emit_opt(&mut xml, row, "LOCA_ID", "locationId");
            emit_opt(&mut xml, row, "IRDX_DPTH", "testDepth");
            emit_opt(&mut xml, row, "IRDX_RES", "redoxPotential");
            xml.push_str("  </RedoxTest>\n");
        }
    }
    if let Some(g) = file.group("ICBR") {
        for row in &g.rows {
            xml.push_str("  <InSituCBRTest>\n");
            emit_opt(&mut xml, row, "LOCA_ID", "locationId");
            emit_opt(&mut xml, row, "ICBR_DPTH", "testDepth");
            emit_opt(&mut xml, row, "ICBR_CBR1", "cbrValue1");
            emit_opt(&mut xml, row, "ICBR_CBR2", "cbrValue2");
            xml.push_str("  </InSituCBRTest>\n");
        }
    }
    if let Some(g) = file.group("CDIA") {
        for row in &g.rows {
            xml.push_str("  <CasingRecord>\n");
            emit_opt(&mut xml, row, "LOCA_ID", "locationId");
            emit_opt(&mut xml, row, "CDIA_DPTH", "depth");
            emit_opt(&mut xml, row, "CDIA_DIAM", "diameter");
            emit_opt(&mut xml, row, "CDIA_TYPE", "casingType");
            xml.push_str("  </CasingRecord>\n");
        }
    }
    if let Some(g) = file.group("CMET") {
        for row in &g.rows {
            xml.push_str("  <DrillingMethod>\n");
            emit_opt(&mut xml, row, "LOCA_ID", "locationId");
            emit_opt(&mut xml, row, "CMET_TOP", "topDepth");
            emit_opt(&mut xml, row, "CMET_BASE", "baseDepth");
            emit_opt(&mut xml, row, "CMET_METH", "method");
            xml.push_str("  </DrillingMethod>\n");
        }
    }

    // Wave D – monitoring and instrumentation.
    if let Some(g) = file.group("MOND") {
        for row in &g.rows {
            xml.push_str("  <MonitoringReading>\n");
            emit_opt(&mut xml, row, "LOCA_ID", "locationId");
            emit_opt(&mut xml, row, "MOND_DPTH", "depth");
            emit_opt(&mut xml, row, "MOND_TYPE", "instrumentType");
            emit_opt(&mut xml, row, "MOND_MEAS", "measurement");
            emit_opt(&mut xml, row, "MOND_TREF", "readingDate");
            xml.push_str("  </MonitoringReading>\n");
        }
    }
    if let Some(g) = file.group("PREM") {
        for row in &g.rows {
            xml.push_str("  <PiezometerReading>\n");
            emit_opt(&mut xml, row, "LOCA_ID", "locationId");
            emit_opt(&mut xml, row, "PREM_DATE", "readingDate");
            emit_opt(&mut xml, row, "PREM_HEAD", "hydraulicHead");
            emit_opt(&mut xml, row, "PREM_DPTH", "installDepth");
            xml.push_str("  </PiezometerReading>\n");
        }
    }
    if let Some(g) = file.group("PRTM") {
        for row in &g.rows {
            xml.push_str("  <PressureTempReading>\n");
            emit_opt(&mut xml, row, "LOCA_ID", "locationId");
            emit_opt(&mut xml, row, "PRTM_DATE", "readingDate");
            emit_opt(&mut xml, row, "PRTM_PRES", "pressure");
            emit_opt(&mut xml, row, "PRTM_TEMP", "temperature");
            xml.push_str("  </PressureTempReading>\n");
        }
    }
    if let Some(g) = file.group("STCN") {
        for row in &g.rows {
            xml.push_str("  <StaticConeTest>\n");
            emit_opt(&mut xml, row, "LOCA_ID", "locationId");
            emit_opt(&mut xml, row, "STCN_DPTH", "testDepth");
            emit_opt(&mut xml, row, "STCN_RES", "conePenetrationResistance");
            emit_opt(&mut xml, row, "STCN_FRES", "frictionResistance");
            emit_opt(&mut xml, row, "STCN_QT", "correctedConeResistance");
            xml.push_str("  </StaticConeTest>\n");
        }
    }
    if let Some(g) = file.group("RELD") {
        for row in &g.rows {
            xml.push_str("  <RelativeDensityTest>\n");
            emit_opt(&mut xml, row, "LOCA_ID", "locationId");
            emit_opt(&mut xml, row, "SAMP_TOP", "sampleDepth");
            emit_opt(&mut xml, row, "RELD_DMAX", "maximumDryDensity");
            emit_opt(&mut xml, row, "RELD_DMIN", "minimumDryDensity");
            emit_opt(&mut xml, row, "RELD_DRY", "dryDensity");
            xml.push_str("  </RelativeDensityTest>\n");
        }
    }

    // Reference / metadata groups: lossless round-trip via <MetadataGroup>.
    for (gname, group) in &file.groups {
        if !is_metadata_group(gname) {
            continue;
        }
        write_generic_group(&mut xml, "MetadataGroup", gname, group);
    }

    // All other groups: lossless round-trip via <DataGroup>.
    for (gname, group) in &file.groups {
        if is_native_group(gname) || is_metadata_group(gname) {
            continue;
        }
        write_generic_group(&mut xml, "DataGroup", gname, group);
        report.generic_groups.push(gname.clone());
    }
    report.generic_groups.sort();

    // Track fields within natively-mapped groups that we don't carry to DIGGS.
    for (gname, group) in &file.groups {
        let mapped_fields: Option<&[&str]> = match gname.as_str() {
            "PROJ" => Some(&["PROJ_ID", "PROJ_NAME"]),
            "LOCA" => Some(&["LOCA_ID", "LOCA_NATE", "LOCA_NATN"]),
            "GEOL" => Some(&["LOCA_ID", "GEOL_TOP", "GEOL_BASE", "GEOL_DESC", "GEOL_LEG"]),
            "SAMP" => Some(&["LOCA_ID", "SAMP_ID", "SAMP_TYPE"]),
            "ISPT" => Some(&["LOCA_ID", "ISPT_TOP", "ISPT_NVAL"]),
            "WSTK" => Some(&["LOCA_ID", "WSTK_DPTH"]),
            "LLPL" => Some(&[
                "LOCA_ID", "SAMP_ID", "SAMP_REF", "LLPL_LL", "LLPL_PL", "LLPL_PI", "LLPL_425",
            ]),
            "LDEN" => Some(&[
                "LOCA_ID",
                "SAMP_ID",
                "SAMP_REF",
                "LDEN_BULK",
                "LDEN_BDEN",
                "LDEN_MC",
            ]),
            "LPDN" => Some(&["LOCA_ID", "SAMP_ID", "SAMP_REF", "LPDN_PD", "LPDN_MCMC"]),
            "LPEN" => Some(&["LOCA_ID", "SAMP_ID", "SAMP_REF", "LPEN_DEPTH", "LPEN_STRE"]),
            "LCON" => Some(&[
                "LOCA_ID",
                "SAMP_ID",
                "SAMP_REF",
                "LCON_VERT",
                "LCON_VOID",
                "LCON_RHVC",
            ]),
            "LCBR" => Some(&["LOCA_ID", "SAMP_ID", "SAMP_REF", "LCBR_COND", "LCBR_CBR"]),
            // wave C
            "IDEN" => Some(&["LOCA_ID", "IDEN_DPTH", "IDEN_DIAM", "IDEN_MC", "IDEN_DBUL"]),
            "IVAN" => Some(&["LOCA_ID", "IVAN_DPTH", "IVAN_TESN", "IVAN_STEN", "IVAN_RTEN"]),
            "IPRM" => Some(&["LOCA_ID", "IPRM_TOP", "IPRM_BOT", "IPRM_TYPE", "IPRM_PERM"]),
            "IPRT" => Some(&["LOCA_ID", "IPRT_DPTH", "IPRT_TYPE", "IPRT_PL", "IPRT_LLD"]),
            "IRDX" => Some(&["LOCA_ID", "IRDX_DPTH", "IRDX_RES"]),
            "ICBR" => Some(&["LOCA_ID", "ICBR_DPTH", "ICBR_CBR1", "ICBR_CBR2"]),
            "CDIA" => Some(&["LOCA_ID", "CDIA_DPTH", "CDIA_DIAM", "CDIA_TYPE"]),
            "CMET" => Some(&["LOCA_ID", "CMET_TOP", "CMET_BASE", "CMET_METH"]),
            // wave D
            "MOND" => Some(&["LOCA_ID", "MOND_DPTH", "MOND_TYPE", "MOND_MEAS", "MOND_TREF"]),
            "PREM" => Some(&["LOCA_ID", "PREM_DATE", "PREM_HEAD", "PREM_DPTH"]),
            "PRTM" => Some(&["LOCA_ID", "PRTM_DATE", "PRTM_PRES", "PRTM_TEMP"]),
            "STCN" => Some(&["LOCA_ID", "STCN_DPTH", "STCN_RES", "STCN_FRES", "STCN_QT"]),
            "RELD" => Some(&["LOCA_ID", "SAMP_TOP", "RELD_DMAX", "RELD_DMIN", "RELD_DRY"]),
            _ => None,
        };
        if let Some(mapped) = mapped_fields {
            let unmapped: Vec<String> = group
                .headings
                .iter()
                .map(|h| h.name.clone())
                .filter(|n| !mapped.contains(&n.as_str()))
                .collect();
            if !unmapped.is_empty() {
                report.unmapped_fields.insert(gname.clone(), unmapped);
            }
        }
    }

    xml.push_str("</Diggs>");
    Ok((xml, report))
}

fn emit_lab_common(xml: &mut String, row: &crate::model::AgsRow) {
    if let Some(v) = row.get("LOCA_ID").and_then(value_as_string) {
        xml.push_str(&format!("    <locationId>{}</locationId>\n", xml_text(&v)));
    }
    if let Some(v) = row.get("SAMP_ID").and_then(value_as_string) {
        xml.push_str(&format!("    <sampleId>{}</sampleId>\n", xml_text(&v)));
    }
    if let Some(v) = row.get("SAMP_REF").and_then(value_as_string) {
        xml.push_str(&format!("    <sampleRef>{}</sampleRef>\n", xml_text(&v)));
    }
}

fn emit_opt(xml: &mut String, row: &crate::model::AgsRow, field: &str, tag: &str) {
    if let Some(v) = row.get(field).and_then(value_as_string) {
        xml.push_str(&format!("    <{tag}>{}</{tag}>\n", xml_text(&v)));
    }
}

fn write_generic_group(
    xml: &mut String,
    element: &str,
    gname: &str,
    group: &crate::model::AgsGroup,
) {
    xml.push_str(&format!("  <{element} name=\"{}\">\n", xml_attr(gname)));
    for h in &group.headings {
        xml.push_str(&format!(
            "    <heading name=\"{}\" unit=\"{}\" type=\"{}\"/>\n",
            xml_attr(&h.name),
            xml_attr(&h.unit),
            xml_attr(&type_to_string(&h.data_type)),
        ));
    }
    for row in &group.rows {
        xml.push_str("    <row>\n");
        for h in &group.headings {
            if let Some(v) = row.get(&h.name).and_then(value_as_string) {
                xml.push_str(&format!(
                    "      <field name=\"{}\">{}</field>\n",
                    xml_attr(&h.name),
                    xml_text(&v),
                ));
            }
        }
        xml.push_str("    </row>\n");
    }
    xml.push_str(&format!("  </{element}>\n"));
}

// ── Metadata-group state machine ────────────────────────────────────

#[derive(Debug, Default)]
struct MetaGroupState {
    name: String,
    headings: Vec<AgsHeading>,
    rows: Vec<AgsRow>,
    current_row: Option<AgsRow>,
}

impl MetaGroupState {
    fn from_attrs(e: &quick_xml::events::BytesStart<'_>) -> Result<Self> {
        let mut name = String::new();
        for attr in e.attributes() {
            let attr = attr?;
            if attr.key.as_ref() == b"name" {
                name = String::from_utf8_lossy(&attr.value).into_owned();
            }
        }
        Ok(Self {
            name,
            ..Default::default()
        })
    }

    fn start_heading(&mut self, e: &quick_xml::events::BytesStart<'_>) -> Result<()> {
        let mut name = String::new();
        let mut unit = String::new();
        let mut data_type = AgsType::X;
        for attr in e.attributes() {
            let attr = attr?;
            let value = String::from_utf8_lossy(&attr.value).into_owned();
            match attr.key.as_ref() {
                b"name" => name = value,
                b"unit" => unit = value,
                b"type" => data_type = AgsType::parse(&value),
                _ => {}
            }
        }
        if !name.is_empty() {
            self.headings.push(AgsHeading {
                name,
                unit,
                data_type,
            });
        }
        Ok(())
    }

    fn start_row(&mut self) {
        self.current_row = Some(IndexMap::new());
    }

    fn finish_row(&mut self) {
        if let Some(mut row) = self.current_row.take() {
            for h in &self.headings {
                row.entry(h.name.clone()).or_insert(AgsValue::Null);
            }
            self.rows.push(row);
        }
    }

    fn set_current_field(&mut self, name: &str, text: &str) {
        let data_type = self
            .headings
            .iter()
            .find(|h| h.name == name)
            .map(|h| h.data_type.clone())
            .unwrap_or(AgsType::X);
        let value = if data_type.is_numeric() {
            text.parse::<f64>()
                .map(AgsValue::Number)
                .unwrap_or_else(|_| AgsValue::Text(text.to_string()))
        } else {
            AgsValue::Text(text.to_string())
        };
        if let Some(row) = self.current_row.as_mut() {
            row.insert(name.to_string(), value);
        }
    }

    fn flush(self, file: &mut AgsFile) {
        if self.name.is_empty() {
            return;
        }
        let group = AgsGroup {
            name: self.name.clone(),
            headings: self.headings,
            rows: self.rows,
            source_line: None,
        };
        file.groups.insert(self.name, group);
    }
}

fn field_attr_name(e: &quick_xml::events::BytesStart<'_>) -> Result<Option<String>> {
    for attr in e.attributes() {
        let attr = attr?;
        if attr.key.as_ref() == b"name" {
            return Ok(Some(String::from_utf8_lossy(&attr.value).into_owned()));
        }
    }
    Ok(None)
}

fn type_to_string(t: &AgsType) -> String {
    match t {
        AgsType::X => "X".into(),
        AgsType::XN => "XN".into(),
        AgsType::MC => "MC".into(),
        AgsType::ID => "ID".into(),
        AgsType::PA => "PA".into(),
        AgsType::PT => "PT".into(),
        AgsType::PU => "PU".into(),
        AgsType::T => "T".into(),
        AgsType::DT => "DT".into(),
        AgsType::YN => "YN".into(),
        AgsType::RL => "RL".into(),
        AgsType::U => "U".into(),
        AgsType::RecordLink => "RECORD_LINK".into(),
        AgsType::Dp(n) => format!("{n}DP"),
        AgsType::Sf(n) => format!("{n}SF"),
        AgsType::Sci(n) => format!("{n}SCI"),
        AgsType::Other(s) => s.clone(),
    }
}

fn xml_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn xml_text(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn local_name(name: &[u8]) -> String {
    let name = std::str::from_utf8(name).unwrap_or_default();
    name.rsplit(':').next().unwrap_or(name).to_string()
}

fn push_full_row(
    file: &mut AgsFile,
    group_name: &str,
    headings: Vec<AgsHeading>,
    mut row: IndexMap<String, AgsValue>,
) {
    let group = file
        .groups
        .entry(group_name.to_string())
        .or_insert_with(|| AgsGroup {
            name: group_name.to_string(),
            headings: headings.clone(),
            rows: Vec::new(),
            source_line: None,
        });

    if group.headings.is_empty() {
        group.headings = headings.clone();
    }
    for heading in &headings {
        if group.headings.iter().all(|h| h.name != heading.name) {
            group.headings.push(heading.clone());
        }
        row.entry(heading.name.clone()).or_insert(AgsValue::Null);
    }
    group.rows.push(row);
}

fn parse_value(s: &str) -> AgsValue {
    match s.parse::<f64>() {
        Ok(n) => AgsValue::Number(n),
        Err(_) => AgsValue::Text(s.to_string()),
    }
}

fn value_as_string(value: &AgsValue) -> Option<String> {
    match value {
        AgsValue::Null => None,
        AgsValue::Text(s) | AgsValue::Raw(s) => Some(s.clone()),
        AgsValue::Number(n) => Some(format_number(*n)),
        AgsValue::Bool(true) => Some("Y".into()),
        AgsValue::Bool(false) => Some("N".into()),
    }
}

fn format_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e16 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn proj_headings() -> Vec<AgsHeading> {
    vec![
        heading("PROJ_ID", AgsType::ID),
        heading("PROJ_NAME", AgsType::X),
    ]
}

fn loca_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading_with_unit("LOCA_NATE", "m", AgsType::Dp(2)),
        heading_with_unit("LOCA_NATN", "m", AgsType::Dp(2)),
    ]
}

fn geol_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading_with_unit("GEOL_TOP", "m", AgsType::Dp(2)),
        heading_with_unit("GEOL_BASE", "m", AgsType::Dp(2)),
        heading("GEOL_DESC", AgsType::X),
        heading("GEOL_LEG", AgsType::PA),
    ]
}

fn samp_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading("SAMP_ID", AgsType::ID),
        heading("SAMP_TYPE", AgsType::PA),
    ]
}

fn ispt_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading_with_unit("ISPT_TOP", "m", AgsType::Dp(2)),
        heading("ISPT_NVAL", AgsType::XN),
    ]
}

fn wstk_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading_with_unit("WSTK_DPTH", "m", AgsType::Dp(2)),
    ]
}

fn llpl_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading("SAMP_ID", AgsType::ID),
        heading("SAMP_REF", AgsType::X),
        heading_with_unit("LLPL_LL", "%", AgsType::Dp(0)),
        heading_with_unit("LLPL_PL", "%", AgsType::Dp(0)),
        heading_with_unit("LLPL_PI", "%", AgsType::Dp(0)),
        heading_with_unit("LLPL_425", "%", AgsType::Dp(0)),
    ]
}

fn lden_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading("SAMP_ID", AgsType::ID),
        heading("SAMP_REF", AgsType::X),
        heading_with_unit("LDEN_BULK", "t/m3", AgsType::Dp(3)),
        heading_with_unit("LDEN_BDEN", "t/m3", AgsType::Dp(3)),
        heading_with_unit("LDEN_MC", "%", AgsType::Dp(1)),
    ]
}

fn lpdn_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading("SAMP_ID", AgsType::ID),
        heading("SAMP_REF", AgsType::X),
        heading_with_unit("LPDN_PD", "Mg/m3", AgsType::Dp(3)),
        heading_with_unit("LPDN_MCMC", "%", AgsType::Dp(1)),
    ]
}

fn lpen_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading("SAMP_ID", AgsType::ID),
        heading("SAMP_REF", AgsType::X),
        heading_with_unit("LPEN_DEPTH", "m", AgsType::Dp(2)),
        heading_with_unit("LPEN_STRE", "kPa", AgsType::Dp(1)),
    ]
}

fn lcon_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading("SAMP_ID", AgsType::ID),
        heading("SAMP_REF", AgsType::X),
        heading_with_unit("LCON_VERT", "kPa", AgsType::Dp(1)),
        heading("LCON_VOID", AgsType::Dp(3)),
        heading_with_unit("LCON_RHVC", "m2/MN", AgsType::Dp(3)),
    ]
}

fn lcbr_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading("SAMP_ID", AgsType::ID),
        heading("SAMP_REF", AgsType::X),
        heading("LCBR_COND", AgsType::PA),
        heading_with_unit("LCBR_CBR", "%", AgsType::Dp(1)),
    ]
}

// ── Wave C heading definitions ───────────────────────────────────────────────

fn iden_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading_with_unit("IDEN_DPTH", "m", AgsType::Dp(2)),
        heading_with_unit("IDEN_DIAM", "mm", AgsType::Dp(1)),
        heading_with_unit("IDEN_MC", "%", AgsType::Dp(1)),
        heading_with_unit("IDEN_DBUL", "Mg/m3", AgsType::Dp(3)),
    ]
}

fn ivan_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading_with_unit("IVAN_DPTH", "m", AgsType::Dp(2)),
        heading("IVAN_TESN", AgsType::X),
        heading_with_unit("IVAN_STEN", "kPa", AgsType::Dp(1)),
        heading_with_unit("IVAN_RTEN", "kPa", AgsType::Dp(1)),
    ]
}

fn iprm_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading_with_unit("IPRM_TOP", "m", AgsType::Dp(2)),
        heading_with_unit("IPRM_BOT", "m", AgsType::Dp(2)),
        heading("IPRM_TYPE", AgsType::PA),
        heading_with_unit("IPRM_PERM", "m/s", AgsType::Sci(2)),
    ]
}

fn iprt_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading_with_unit("IPRT_DPTH", "m", AgsType::Dp(2)),
        heading("IPRT_TYPE", AgsType::PA),
        heading_with_unit("IPRT_PL", "kPa", AgsType::Dp(1)),
        heading_with_unit("IPRT_LLD", "kPa", AgsType::Dp(1)),
    ]
}

fn irdx_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading_with_unit("IRDX_DPTH", "m", AgsType::Dp(2)),
        heading_with_unit("IRDX_RES", "mV", AgsType::Dp(1)),
    ]
}

fn icbr_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading_with_unit("ICBR_DPTH", "m", AgsType::Dp(2)),
        heading_with_unit("ICBR_CBR1", "%", AgsType::Dp(1)),
        heading_with_unit("ICBR_CBR2", "%", AgsType::Dp(1)),
    ]
}

fn cdia_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading_with_unit("CDIA_DPTH", "m", AgsType::Dp(2)),
        heading_with_unit("CDIA_DIAM", "mm", AgsType::Dp(0)),
        heading("CDIA_TYPE", AgsType::PA),
    ]
}

fn cmet_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading_with_unit("CMET_TOP", "m", AgsType::Dp(2)),
        heading_with_unit("CMET_BASE", "m", AgsType::Dp(2)),
        heading("CMET_METH", AgsType::PA),
    ]
}

// ── Wave D heading definitions ───────────────────────────────────────────────

fn mond_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading_with_unit("MOND_DPTH", "m", AgsType::Dp(2)),
        heading("MOND_TYPE", AgsType::PA),
        heading("MOND_MEAS", AgsType::XN),
        heading("MOND_TREF", AgsType::DT),
    ]
}

fn prem_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading("PREM_DATE", AgsType::DT),
        heading_with_unit("PREM_HEAD", "m", AgsType::Dp(3)),
        heading_with_unit("PREM_DPTH", "m", AgsType::Dp(2)),
    ]
}

fn prtm_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading("PRTM_DATE", AgsType::DT),
        heading_with_unit("PRTM_PRES", "kPa", AgsType::Dp(1)),
        heading_with_unit("PRTM_TEMP", "degC", AgsType::Dp(1)),
    ]
}

fn stcn_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading_with_unit("STCN_DPTH", "m", AgsType::Dp(2)),
        heading_with_unit("STCN_RES", "MPa", AgsType::Dp(3)),
        heading_with_unit("STCN_FRES", "kPa", AgsType::Dp(1)),
        heading_with_unit("STCN_QT", "MPa", AgsType::Dp(3)),
    ]
}

fn reld_headings() -> Vec<AgsHeading> {
    vec![
        heading("LOCA_ID", AgsType::ID),
        heading_with_unit("SAMP_TOP", "m", AgsType::Dp(2)),
        heading_with_unit("RELD_DMAX", "Mg/m3", AgsType::Dp(3)),
        heading_with_unit("RELD_DMIN", "Mg/m3", AgsType::Dp(3)),
        heading_with_unit("RELD_DRY", "Mg/m3", AgsType::Dp(3)),
    ]
}

fn heading(name: &str, data_type: AgsType) -> AgsHeading {
    AgsHeading {
        name: name.to_string(),
        unit: String::new(),
        data_type,
    }
}

fn heading_with_unit(name: &str, unit: &str, data_type: AgsType) -> AgsHeading {
    AgsHeading {
        name: name.to_string(),
        unit: unit.to_string(),
        data_type,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ags::parse_str;

    #[test]
    fn reads_minimal_project_and_locations() {
        let xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<Diggs xmlns="http://diggsml.org/schemas/2.6" xmlns:gml="http://www.opengis.net/gml">
  <Project>
    <gml:name>P1</gml:name>
    <gml:description>Demo Project</gml:description>
  </Project>
  <SamplingLocation>
    <gml:name>BH01</gml:name>
    <easting>123456.78</easting>
    <northing>234567.89</northing>
  </SamplingLocation>
  <SamplingLocation>
    <gml:name>BH02</gml:name>
  </SamplingLocation>
  <Lithology>
    <locationId>BH01</locationId>
    <topDepth>0.00</topDepth>
    <baseDepth>1.50</baseDepth>
    <description>Topsoil</description>
    <legendCode>TS</legendCode>
  </Lithology>
  <Sample>
    <locationId>BH01</locationId>
    <sampleId>S1</sampleId>
    <sampleType>B</sampleType>
  </Sample>
  <SPTTest>
    <locationId>BH01</locationId>
    <testDepth>2.00</testDepth>
    <blowCount>12</blowCount>
  </SPTTest>
  <WaterStrike>
    <locationId>BH01</locationId>
    <strikeDepth>3.50</strikeDepth>
  </WaterStrike>
</Diggs>"#;
        let file = read(xml).unwrap();
        assert_eq!(
            file.group("PROJ")
                .unwrap()
                .rows
                .first()
                .and_then(|r| r.get("PROJ_ID"))
                .and_then(|v| v.as_text()),
            Some("P1")
        );
        assert_eq!(
            file.group("PROJ")
                .unwrap()
                .rows
                .first()
                .and_then(|r| r.get("PROJ_NAME"))
                .and_then(|v| v.as_text()),
            Some("Demo Project")
        );
        assert_eq!(file.group("LOCA").unwrap().rows.len(), 2);
        assert_eq!(
            file.group("LOCA").unwrap().rows[0]
                .get("LOCA_NATE")
                .and_then(|v| v.as_number()),
            Some(123456.78)
        );
        assert_eq!(file.group("GEOL").unwrap().rows.len(), 1);
        assert_eq!(file.group("SAMP").unwrap().rows.len(), 1);
        assert_eq!(file.group("ISPT").unwrap().rows.len(), 1);
        assert_eq!(file.group("WSTK").unwrap().rows.len(), 1);
    }

    #[test]
    fn ags_to_diggs_to_ags_round_trips_mapped_subset() {
        let ags = r#""GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P1","Demo"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","123456.78","234567.89"
"DATA","BH02","123460.00","234570.00"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC","GEOL_LEG"
"UNIT","","m","m","",""
"TYPE","ID","2DP","2DP","X","PA"
"DATA","BH01","0.00","1.50","Topsoil","TS"

"GROUP","SAMP"
"HEADING","LOCA_ID","SAMP_ID","SAMP_TYPE"
"UNIT","","",""
"TYPE","ID","ID","PA"
"DATA","BH01","S1","B"

"GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_NVAL"
"UNIT","","m",""
"TYPE","ID","2DP","XN"
"DATA","BH01","2.00","12"

"GROUP","WSTK"
"HEADING","LOCA_ID","WSTK_DPTH"
"UNIT","","m"
"TYPE","ID","2DP"
"DATA","BH01","3.50"
"#;
        let file = parse_str(ags).file;
        let (xml, _report) = write(&file).unwrap();
        let reparsed = read(xml.as_bytes()).unwrap();

        assert_eq!(
            reparsed
                .group("PROJ")
                .unwrap()
                .rows
                .first()
                .and_then(|r| r.get("PROJ_ID"))
                .and_then(|v| v.as_text()),
            Some("P1")
        );
        assert_eq!(
            reparsed
                .group("PROJ")
                .unwrap()
                .rows
                .first()
                .and_then(|r| r.get("PROJ_NAME"))
                .and_then(|v| v.as_text()),
            Some("Demo")
        );
        assert_eq!(reparsed.group("LOCA").unwrap().rows.len(), 2);
        assert_eq!(
            reparsed.group("LOCA").unwrap().rows[0]
                .get("LOCA_ID")
                .and_then(|v| v.as_text()),
            Some("BH01")
        );
        assert_eq!(
            reparsed.group("LOCA").unwrap().rows[0]
                .get("LOCA_NATE")
                .and_then(|v| v.as_number()),
            Some(123456.78)
        );
        assert_eq!(
            reparsed.group("GEOL").unwrap().rows[0]
                .get("GEOL_DESC")
                .and_then(|v| v.as_text()),
            Some("Topsoil")
        );
        assert_eq!(
            reparsed.group("SAMP").unwrap().rows[0]
                .get("SAMP_ID")
                .and_then(|v| v.as_text()),
            Some("S1")
        );
        assert_eq!(
            reparsed.group("ISPT").unwrap().rows[0]
                .get("ISPT_NVAL")
                .and_then(|v| v.as_number()),
            Some(12.0)
        );
        assert_eq!(
            reparsed.group("WSTK").unwrap().rows[0]
                .get("WSTK_DPTH")
                .and_then(|v| v.as_number()),
            Some(3.5)
        );
    }

    #[test]
    fn conversion_report_lists_generic_groups_and_unmapped_fields() {
        let ags = r#""GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME","PROJ_LOC"
"UNIT","","",""
"TYPE","ID","X","X"
"DATA","P1","Demo","Somewhere"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN","LOCA_GL"
"UNIT","","m","m","m"
"TYPE","ID","2DP","2DP","2DP"
"DATA","BH01","123456.78","234567.89","45.67"

"GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_NVAL","ISPT_REM"
"UNIT","","m","",""
"TYPE","ID","2DP","XN","X"
"DATA","BH01","2.00","12","Refusal"

"GROUP","CBRG"
"HEADING","CBRG_ID","CBRG_VAL"
"UNIT","",""
"TYPE","ID","XN"
"DATA","C1","100"
"#;
        let file = parse_str(ags).file;
        let (xml, report) = write(&file).unwrap();

        // CBRG is wrapped as a DataGroup (losslessly), not dropped.
        assert!(report.generic_groups.contains(&"CBRG".to_string()));
        assert!(xml.contains("<DataGroup name=\"CBRG\""));
        // Fields within natively-mapped groups that we don't carry.
        assert_eq!(
            report.unmapped_fields.get("PROJ"),
            Some(&vec!["PROJ_LOC".to_string()])
        );
        assert_eq!(
            report.unmapped_fields.get("LOCA"),
            Some(&vec!["LOCA_GL".to_string()])
        );
        assert_eq!(
            report.unmapped_fields.get("ISPT"),
            Some(&vec!["ISPT_REM".to_string()])
        );
    }

    #[test]
    fn generic_data_group_round_trips_losslessly() {
        let ags = r#""GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"

"GROUP","CBRG"
"HEADING","CBRG_ID","CBRG_VAL"
"UNIT","",""
"TYPE","ID","XN"
"DATA","C1","100"
"DATA","C2","85"
"#;
        let file = parse_str(ags).file;
        let (xml, report) = write(&file).unwrap();
        assert!(report.generic_groups.contains(&"CBRG".to_string()));
        assert!(xml.contains("<DataGroup name=\"CBRG\""));

        let reparsed = read(xml.as_bytes()).unwrap();
        let cbrg = reparsed.group("CBRG").unwrap();
        assert_eq!(cbrg.headings.len(), 2);
        assert_eq!(cbrg.rows.len(), 2);
        assert_eq!(
            cbrg.rows[0].get("CBRG_ID").and_then(|v| v.as_text()),
            Some("C1")
        );
        assert_eq!(
            cbrg.rows[1].get("CBRG_ID").and_then(|v| v.as_text()),
            Some("C2")
        );
    }

    #[test]
    fn metadata_groups_round_trip_losslessly() {
        let ags = r#""GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P1","Demo"

"GROUP","ABBR"
"HEADING","ABBR_HDNG","ABBR_CODE","ABBR_DESC"
"UNIT","","",""
"TYPE","X","ID","X"
"DATA","GEOL_LEG","TS","Topsoil"
"DATA","GEOL_LEG","CL","Clay"

"GROUP","DICT"
"HEADING","DICT_TYPE","DICT_GRP","DICT_HDNG","DICT_DESC"
"UNIT","","","",""
"TYPE","X","X","X","X"
"DATA","GROUP","CUST","CUST_ID","Custom group identifier"
"#;
        let file = parse_str(ags).file;
        let (xml, report) = write(&file).unwrap();
        // Metadata groups must NOT show up as generic_groups.
        assert!(
            !report.generic_groups.contains(&"ABBR".to_string()),
            "{:?}",
            report.generic_groups
        );
        assert!(xml.contains("<MetadataGroup name=\"ABBR\""));
        assert!(xml.contains("<MetadataGroup name=\"DICT\""));

        let reparsed = read(xml.as_bytes()).unwrap();
        let abbr = reparsed.group("ABBR").unwrap();
        assert_eq!(abbr.headings.len(), 3);
        assert_eq!(abbr.rows.len(), 2);
        assert_eq!(
            abbr.rows[0].get("ABBR_CODE").and_then(|v| v.as_text()),
            Some("TS")
        );
        assert_eq!(
            abbr.rows[1].get("ABBR_DESC").and_then(|v| v.as_text()),
            Some("Clay")
        );
        let dict = reparsed.group("DICT").unwrap();
        assert_eq!(dict.rows.len(), 1);
        assert_eq!(
            dict.rows[0].get("DICT_HDNG").and_then(|v| v.as_text()),
            Some("CUST_ID")
        );
    }

    #[test]
    fn wave_b_lab_tests_round_trip() {
        let ags = r#""GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"

"GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH01"

"GROUP","LLPL"
"HEADING","LOCA_ID","SAMP_ID","LLPL_LL","LLPL_PL","LLPL_PI"
"UNIT","","","%","%","%"
"TYPE","ID","ID","0DP","0DP","0DP"
"DATA","BH01","S1","45","22","23"

"GROUP","LDEN"
"HEADING","LOCA_ID","SAMP_ID","LDEN_BULK","LDEN_MC"
"UNIT","","","t/m3","%"
"TYPE","ID","ID","3DP","1DP"
"DATA","BH01","S1","1.850","15.2"

"GROUP","LPDN"
"HEADING","LOCA_ID","SAMP_ID","LPDN_PD"
"UNIT","","","Mg/m3"
"TYPE","ID","ID","3DP"
"DATA","BH01","S1","2.650"

"GROUP","LPEN"
"HEADING","LOCA_ID","SAMP_ID","LPEN_STRE"
"UNIT","","","kPa"
"TYPE","ID","ID","1DP"
"DATA","BH01","S1","50.0"

"GROUP","LCON"
"HEADING","LOCA_ID","SAMP_ID","LCON_VERT","LCON_RHVC"
"UNIT","","","kPa","m2/MN"
"TYPE","ID","ID","1DP","3DP"
"DATA","BH01","S1","100.0","0.150"

"GROUP","LCBR"
"HEADING","LOCA_ID","SAMP_ID","LCBR_CBR"
"UNIT","","","%"
"TYPE","ID","ID","1DP"
"DATA","BH01","S1","15.0"
"#;
        let file = parse_str(ags).file;
        let (xml, report) = write(&file).unwrap();
        // All wave B groups must be natively mapped (not generic).
        assert!(
            report.generic_groups.is_empty(),
            "{:?}",
            report.generic_groups
        );
        assert!(xml.contains("<AttenbergLimits>"));
        assert!(xml.contains("<BulkDensityTest>"));
        assert!(xml.contains("<ParticleDensityTest>"));
        assert!(xml.contains("<PenetratorTest>"));
        assert!(xml.contains("<OedometerTest>"));
        assert!(xml.contains("<CBRTest>"));

        let reparsed = read(xml.as_bytes()).unwrap();
        assert_eq!(
            reparsed.group("LLPL").unwrap().rows[0]
                .get("LLPL_LL")
                .and_then(|v| v.as_number()),
            Some(45.0)
        );
        assert_eq!(
            reparsed.group("LDEN").unwrap().rows[0]
                .get("LDEN_BULK")
                .and_then(|v| v.as_number()),
            Some(1.85)
        );
        assert_eq!(
            reparsed.group("LPDN").unwrap().rows[0]
                .get("LPDN_PD")
                .and_then(|v| v.as_number()),
            Some(2.65)
        );
        assert_eq!(
            reparsed.group("LPEN").unwrap().rows[0]
                .get("LPEN_STRE")
                .and_then(|v| v.as_number()),
            Some(50.0)
        );
        assert_eq!(
            reparsed.group("LCON").unwrap().rows[0]
                .get("LCON_VERT")
                .and_then(|v| v.as_number()),
            Some(100.0)
        );
        assert_eq!(
            reparsed.group("LCBR").unwrap().rows[0]
                .get("LCBR_CBR")
                .and_then(|v| v.as_number()),
            Some(15.0)
        );
    }
}
