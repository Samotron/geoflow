//! HTML Explorer rendering engine.

use crate::model::AgsFile;
use crate::validate::{self, Registry};
use anyhow::Result;
use minijinja::{context, Environment};

pub struct Explorer {
    env: Environment<'static>,
}

impl Default for Explorer {
    fn default() -> Self {
        Self::new()
    }
}

impl Explorer {
    pub fn new() -> Self {
        let mut env = Environment::new();
        env.add_filter("truncate", |s: &str, max: usize| -> String {
            if s.chars().count() <= max {
                s.to_string()
            } else {
                let truncated: String = s.chars().take(max.saturating_sub(1)).collect();
                format!("{truncated}…")
            }
        });
        env.add_template("base", include_str!("explorer/base.html"))
            .unwrap();
        env.add_template("overview", include_str!("explorer/overview.html"))
            .unwrap();
        env.add_template("group", include_str!("explorer/group.html"))
            .unwrap();
        env.add_template("borehole", include_str!("explorer/borehole.html"))
            .unwrap();
        env.add_template("borehole_svg", include_str!("explorer/borehole_svg.html"))
            .unwrap();
        env.add_template("validation", include_str!("explorer/validation.html"))
            .unwrap();
        env.add_template("certificate", include_str!("explorer/certificate.html"))
            .unwrap();
        Self { env }
    }

    pub fn render_overview(&self, file: &AgsFile) -> Result<String> {
        let diagnostics = run_validation(file, &[]);
        let summary = diagnostic_summary(&diagnostics);
        let tmpl = self.env.get_template("overview")?;
        let html = tmpl.render(context!(
            file => file,
            diagnostics => diagnostics,
            summary => summary,
        ))?;
        Ok(html)
    }

    pub fn render_group(&self, file: &AgsFile, group_name: &str) -> Result<String> {
        let group = file
            .group(group_name)
            .ok_or_else(|| anyhow::anyhow!("group not found"))?;
        let diggs_xml = crate::diggs::write(file)
            .map(|(xml, _)| xml)
            .unwrap_or_default();
        let tmpl = self.env.get_template("group")?;
        let html = tmpl.render(context!(
            file => file,
            group_name => group_name,
            group => group,
            diggs_xml => diggs_xml,
        ))?;
        Ok(html)
    }

    pub fn render_borehole(&self, file: &AgsFile, loca_id: &str) -> Result<String> {
        let loca_group = file
            .group("LOCA")
            .ok_or_else(|| anyhow::anyhow!("no LOCA group"))?;
        let loca_row = loca_group
            .rows
            .iter()
            .find(|r| r.get("LOCA_ID").and_then(|v| v.as_text()) == Some(loca_id))
            .ok_or_else(|| anyhow::anyhow!("LOCA_ID {loca_id} not found"))?;

        let geol_rows: Vec<_> = file
            .group("GEOL")
            .map(|g| {
                g.rows
                    .iter()
                    .filter(|r| r.get("LOCA_ID").and_then(|v| v.as_text()) == Some(loca_id))
                    .collect()
            })
            .unwrap_or_default();

        let samp_rows: Vec<_> = file
            .group("SAMP")
            .map(|g| {
                g.rows
                    .iter()
                    .filter(|r| r.get("LOCA_ID").and_then(|v| v.as_text()) == Some(loca_id))
                    .collect()
            })
            .unwrap_or_default();

        let ispt_rows: Vec<_> = file
            .group("ISPT")
            .map(|g| {
                g.rows
                    .iter()
                    .filter(|r| r.get("LOCA_ID").and_then(|v| v.as_text()) == Some(loca_id))
                    .collect()
            })
            .unwrap_or_default();

        let wstk_rows: Vec<_> = file
            .group("WSTK")
            .map(|g| {
                g.rows
                    .iter()
                    .filter(|r| r.get("LOCA_ID").and_then(|v| v.as_text()) == Some(loca_id))
                    .collect()
            })
            .unwrap_or_default();

        let tmpl = self.env.get_template("borehole")?;
        let html = tmpl.render(context!(
            file => file,
            loca_id => loca_id,
            loca => loca_row,
            geol => geol_rows,
            samp => samp_rows,
            ispt => ispt_rows,
            wstk => wstk_rows,
        ))?;
        Ok(html)
    }

    /// Render just the SVG strip log for one borehole — suitable for inline embedding.
    pub fn render_borehole_svg(&self, file: &AgsFile, loca_id: &str) -> Result<String> {
        let loca_group = file
            .group("LOCA")
            .ok_or_else(|| anyhow::anyhow!("no LOCA group"))?;
        let loca_row = loca_group
            .rows
            .iter()
            .find(|r| r.get("LOCA_ID").and_then(|v| v.as_text()) == Some(loca_id))
            .ok_or_else(|| anyhow::anyhow!("LOCA_ID {loca_id} not found"))?;

        let filter_rows = |group: &str| -> Vec<_> {
            file.group(group)
                .map(|g| {
                    g.rows
                        .iter()
                        .filter(|r| r.get("LOCA_ID").and_then(|v| v.as_text()) == Some(loca_id))
                        .collect()
                })
                .unwrap_or_default()
        };

        let tmpl = self.env.get_template("borehole_svg")?;
        Ok(tmpl.render(context!(
            loca_id => loca_id,
            loca    => loca_row,
            geol    => filter_rows("GEOL"),
            samp    => filter_rows("SAMP"),
            ispt    => filter_rows("ISPT"),
            wstk    => filter_rows("WSTK"),
        ))?)
    }

    pub fn render_validation(
        &self,
        file: &AgsFile,
        extra_packs: &[crate::dsl::LoadedPack],
        available_packs: &[String],
        active_pack_refs: &[String],
        custom_yaml: Option<&str>,
        is_serve: bool,
    ) -> Result<String> {
        let diagnostics = run_validation(file, extra_packs);
        let summary = diagnostic_summary(&diagnostics);
        let groups: std::collections::BTreeSet<_> = diagnostics
            .iter()
            .filter_map(|d| d.location.group.as_deref())
            .collect();
        let rules: std::collections::BTreeSet<_> =
            diagnostics.iter().map(|d| d.rule_id.as_str()).collect();

        let tmpl = self.env.get_template("validation")?;
        let html = tmpl.render(context!(
            file => file,
            page => "validation",
            diagnostics => diagnostics,
            summary => summary,
            groups => groups,
            rules => rules,
            available_packs => available_packs,
            active_pack_refs => active_pack_refs,
            custom_yaml => custom_yaml.unwrap_or(""),
            is_serve => is_serve,
        ))?;
        Ok(html)
    }

    pub fn render_certificate(
        &self,
        file: &AgsFile,
        extra_packs: &[crate::dsl::LoadedPack],
        active_pack_refs: &[String],
        validated_at: &str,
    ) -> Result<String> {
        let diagnostics = run_validation(file, extra_packs);
        let summary = diagnostic_summary(&diagnostics);
        let passed = summary.get("error").copied().unwrap_or(0) == 0;
        let tmpl = self.env.get_template("certificate")?;
        let html = tmpl.render(context!(
            file => file,
            diagnostics => diagnostics,
            summary => summary,
            active_pack_refs => active_pack_refs,
            validated_at => validated_at,
            passed => passed,
        ))?;
        Ok(html)
    }

    /// Render all pages of the explorer as (path, html) pairs.
    pub fn render_all(&self, file: &AgsFile) -> Result<Vec<(String, String)>> {
        let mut pages = Vec::new();

        // Index
        pages.push(("index.html".to_string(), self.render_overview(file)?));
        pages.push((
            "validation.html".to_string(),
            self.render_validation(file, &[], &[], &[], None, false)?,
        ));
        pages.push((
            "certificate.html".to_string(),
            self.render_certificate(file, &[], &[], "static export")?,
        ));

        // Groups
        for group_name in file.groups.keys() {
            pages.push((
                format!("group/{}.html", group_name),
                self.render_group(file, group_name)?,
            ));
        }

        // Boreholes
        if let Some(loca) = file.group("LOCA") {
            for row in &loca.rows {
                if let Some(id) = row.get("LOCA_ID").and_then(|v| v.as_text()) {
                    pages.push((
                        format!("borehole/{}.html", id),
                        self.render_borehole(file, id)?,
                    ));
                }
            }
        }

        Ok(pages)
    }
}

fn run_validation(
    file: &AgsFile,
    extra_packs: &[crate::dsl::LoadedPack],
) -> Vec<crate::diagnostics::Diagnostic> {
    let mut diagnostics = validate::validate(file, &Registry::standard());
    for pack in extra_packs {
        match crate::dsl::evaluate(file, pack) {
            Ok(pd) => diagnostics.extend(pd),
            Err(e) => {
                diagnostics.push(crate::diagnostics::Diagnostic::new(
                    "RULE-PACK-ERR".to_string(),
                    crate::diagnostics::Severity::Error,
                    format!("rule pack error: {e}"),
                ));
            }
        }
    }
    diagnostics
}

fn diagnostic_summary(
    diagnostics: &[crate::diagnostics::Diagnostic],
) -> std::collections::BTreeMap<&'static str, usize> {
    let mut summary = std::collections::BTreeMap::new();
    summary.insert("error", 0);
    summary.insert("warning", 0);
    summary.insert("info", 0);

    for diagnostic in diagnostics {
        let key = match diagnostic.severity {
            crate::diagnostics::Severity::Error => "error",
            crate::diagnostics::Severity::Warning => "warning",
            crate::diagnostics::Severity::Info => "info",
        };
        *summary.entry(key).or_insert(0) += 1;
    }

    summary
}
