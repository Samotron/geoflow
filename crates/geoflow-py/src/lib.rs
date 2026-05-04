//! Python bindings for `geoflow-core` (Milestone 8).
//!
//! Exposes a Pythonic interface to the GeoFlow toolkit.

// PyO3 macros generate conversions that clippy flags as useless.
#![allow(clippy::useless_conversion)]

use std::path::PathBuf;

use pyo3::exceptions::{PyIOError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

use geoflow_core::diagnostics::Severity;
use geoflow_core::dsl;
use geoflow_core::model::{AgsFile, AgsValue};
use geoflow_core::{ags, diggs, validate, Registry};

/// Wrapper around an [`AgsFile`] exposed to Python.
#[pyclass(name = "AgsFile")]
#[derive(Clone)]
struct PyAgsFile {
    inner: AgsFile,
}

#[pymethods]
impl PyAgsFile {
    /// AGS version detected on parse, if any.
    #[getter]
    fn ags_version(&self) -> Option<String> {
        self.inner.ags_version.clone()
    }

    /// Names of every group present in the file, in declared order.
    fn group_names(&self) -> Vec<String> {
        self.inner.groups.keys().cloned().collect()
    }

    /// Number of rows in the named group, or `None` if it is absent.
    fn row_count(&self, group: &str) -> Option<usize> {
        self.inner.group(group).map(|g| g.rows.len())
    }

    /// Get metadata for a group: headings, units, and types.
    fn group_metadata<'py>(&self, py: Python<'py>, group: &str) -> PyResult<Bound<'py, PyList>> {
        let g = self
            .inner
            .group(group)
            .ok_or_else(|| PyValueError::new_err(format!("group not found: {group}")))?;

        let list = PyList::empty_bound(py);
        for h in &g.headings {
            let dict = PyDict::new_bound(py);
            dict.set_item("name", &h.name)?;
            dict.set_item("unit", &h.unit)?;
            dict.set_item("type", format!("{:?}", h.data_type))?;
            list.append(dict)?;
        }
        Ok(list)
    }

    /// Get every row of a group as a list of dictionaries.
    fn group_rows<'py>(&self, py: Python<'py>, group: &str) -> PyResult<Bound<'py, PyList>> {
        let g = self
            .inner
            .group(group)
            .ok_or_else(|| PyValueError::new_err(format!("group not found: {group}")))?;
        let list = PyList::empty_bound(py);
        for row in &g.rows {
            let dict = PyDict::new_bound(py);
            for (k, v) in row.iter() {
                dict.set_item(k, ags_value_to_py(py, v)?)?;
            }
            list.append(dict)?;
        }
        Ok(list)
    }

    /// Run the standard rule registry plus optional rule packs and return
    /// each diagnostic as a dictionary.
    #[pyo3(signature = (rules = None))]
    fn validate<'py>(
        &self,
        py: Python<'py>,
        rules: Option<Vec<String>>,
    ) -> PyResult<Bound<'py, PyList>> {
        let mut registry = Registry::standard();

        if let Some(specs) = rules {
            for spec in specs {
                let pack = dsl::RulePack::load_spec(&spec)
                    .map_err(|e| PyValueError::new_err(format!("loading {spec}: {e}")))?;
                registry.add_pack(pack);
            }
        }

        let diagnostics = validate(&self.inner, &registry);

        let list = PyList::empty_bound(py);
        for d in diagnostics {
            let dict = PyDict::new_bound(py);
            dict.set_item("rule_id", &d.rule_id)?;
            dict.set_item("severity", severity_str(d.severity))?;
            dict.set_item("message", &d.message)?;
            dict.set_item("group", d.location.group.as_deref())?;
            dict.set_item("line", d.location.line)?;
            dict.set_item("file", d.location.file.as_deref())?;
            list.append(dict)?;
        }
        Ok(list)
    }

    /// Automatically fix safe issues in the AGS file in-place.
    /// Returns a list of the names of fixes that were applied.
    #[pyo3(signature = (rules = None))]
    fn fix(&mut self, rules: Option<Vec<String>>) -> PyResult<Vec<String>> {
        let mut applied = Vec::new();

        let fixer = geoflow_core::fix::Fixer::standard();
        for name in fixer.apply_all(&mut self.inner) {
            applied.push(name.to_string());
        }

        for spec in rules.unwrap_or_default() {
            let pack = dsl::RulePack::load_spec(&spec)
                .map_err(|e| PyValueError::new_err(format!("loading {spec}: {e}")))?;
            let pd = dsl::fix(&mut self.inner, &pack)
                .map_err(|e| PyValueError::new_err(format!("applying {spec}: {e}")))?;
            applied.extend(pd);
        }

        applied.sort();
        applied.dedup();
        Ok(applied)
    }

    /// Serialize to a DIGGS XML string. Returns `(xml, report_json)`.
    fn to_diggs(&self) -> PyResult<(String, String)> {
        let (xml, report) = diggs::write(&self.inner)
            .map_err(|e| PyValueError::new_err(format!("writing DIGGS: {e}")))?;
        let report_json = serde_json::to_string(&report)
            .map_err(|e| PyValueError::new_err(format!("serializing report: {e}")))?;
        Ok((xml, report_json))
    }

    /// Serialize back to AGS 4 text.
    fn to_ags(&self) -> String {
        ags::serialize(&self.inner)
    }

    /// Convert the entire file to a dictionary of {group: [rows]}.
    fn to_dict<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let dict = PyDict::new_bound(py);
        for name in self.group_names() {
            dict.set_item(&name, self.group_rows(py, &name)?)?;
        }
        Ok(dict)
    }

    /// Return every group as a `dict[str, str]` of CSV text.
    fn to_csv<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let csvs = geoflow_core::export::to_csv(&self.inner);
        let dict = PyDict::new_bound(py);
        for (name, csv) in csvs {
            dict.set_item(name, csv)?;
        }
        Ok(dict)
    }

    /// Return every group as a `dict[str, pandas.DataFrame]`.
    /// Requires pandas to be installed (`pip install pandas`).
    fn to_dataframes<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let pd = py.import_bound("pandas").map_err(|_| {
            pyo3::exceptions::PyImportError::new_err("pandas is required: pip install pandas")
        })?;
        let out = PyDict::new_bound(py);
        for name in self.group_names() {
            let rows = self.group_rows(py, &name)?;
            let df = pd.call_method1("DataFrame", (&rows,))?;
            out.set_item(&name, df)?;
        }
        Ok(out)
    }

    /// Return a single group as a `pandas.DataFrame`.
    /// Requires pandas to be installed (`pip install pandas`).
    fn to_dataframe<'py>(&self, py: Python<'py>, group: &str) -> PyResult<PyObject> {
        let pd = py.import_bound("pandas").map_err(|_| {
            pyo3::exceptions::PyImportError::new_err("pandas is required: pip install pandas")
        })?;
        let rows = self.group_rows(py, group)?;
        Ok(pd.call_method1("DataFrame", (&rows,))?.into())
    }

    fn __repr__(&self) -> String {
        format!(
            "AgsFile(groups={}, ags_version={:?})",
            self.inner.groups.len(),
            self.inner.ags_version
        )
    }
}

/// Read an AGS 4.x file from disk.
#[pyfunction]
fn read_ags(path: PathBuf) -> PyResult<PyAgsFile> {
    let bytes = std::fs::read(&path)
        .map_err(|e| PyIOError::new_err(format!("reading {}: {e}", path.display())))?;
    Ok(PyAgsFile {
        inner: ags::parse_bytes(&bytes).file,
    })
}

/// Read AGS 4.x text.
#[pyfunction]
fn parse_ags(text: &str) -> PyAgsFile {
    PyAgsFile {
        inner: ags::parse_str(text).file,
    }
}

/// Read a DIGGS XML file from disk.
#[pyfunction]
fn read_diggs(path: PathBuf) -> PyResult<PyAgsFile> {
    let bytes = std::fs::read(&path)
        .map_err(|e| PyIOError::new_err(format!("reading {}: {e}", path.display())))?;
    let file =
        diggs::read(&bytes).map_err(|e| PyValueError::new_err(format!("parsing DIGGS: {e}")))?;
    Ok(PyAgsFile { inner: file })
}

/// List all built-in rule packs available in the registry.
#[pyfunction]
fn installed_pack_refs() -> Vec<String> {
    dsl::installed_pack_refs()
}

#[pymodule]
fn geoflow(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    m.add_class::<PyAgsFile>()?;
    m.add_function(wrap_pyfunction!(read_ags, m)?)?;
    m.add_function(wrap_pyfunction!(parse_ags, m)?)?;
    m.add_function(wrap_pyfunction!(read_diggs, m)?)?;
    m.add_function(wrap_pyfunction!(installed_pack_refs, m)?)?;
    Ok(())
}

fn ags_value_to_py(py: Python<'_>, v: &AgsValue) -> PyResult<PyObject> {
    Ok(match v {
        AgsValue::Null => py.None(),
        AgsValue::Text(s) | AgsValue::Raw(s) => s.to_object(py),
        AgsValue::Number(n) => n.to_object(py),
        AgsValue::Bool(b) => b.to_object(py),
    })
}

fn severity_str(s: Severity) -> &'static str {
    match s {
        Severity::Info => "info",
        Severity::Warning => "warning",
        Severity::Error => "error",
    }
}
