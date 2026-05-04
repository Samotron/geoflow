//! Run a [`LoadedPack`] over an [`AgsFile`] and emit diagnostics.
//!
//! Each rule's `when` and `expr` are compiled once. For row-scoped
//! rules we iterate every row of every group, building a fresh CEL
//! context bound with `row`, `group`, `file`, every group as a list,
//! and the host helper functions. For file-scoped rules we evaluate
//! `expr` once with the same bindings minus `row`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use cel_interpreter::extractors::{Arguments, This};
use cel_interpreter::objects::{Key, Map, Value};
use cel_interpreter::{Context, ExecutionError, Program};

use super::codelist::Codelists;
use super::context::{
    ags_value_to_cel, file_to_cel, group_to_cel, groups_meta_cel, render_message, row_to_cel,
};
use super::pack::{LoadedPack, Scope};
use crate::diagnostics::Diagnostic;
use crate::model::AgsFile;

/// Errors raised while compiling or running a rule pack.
#[derive(Debug, thiserror::Error)]
pub enum EvalError {
    #[error("rule {rule_id} `{which}` failed to compile: {message}")]
    Compile {
        rule_id: String,
        which: &'static str,
        message: String,
    },
}

/// Index of every group → key heading → set of values, used by the
/// `exists_in` host function for O(1) cross-references.  Also caches
/// group existence and row counts for `has_group` / `group_size`.
#[derive(Default, Debug, Clone)]
struct CrossIndex {
    by_group: HashMap<String, HashMap<String, HashSet<String>>>,
    rows_by_group: HashMap<String, HashMap<String, HashMap<String, crate::model::AgsRow>>>,
    group_names: HashSet<String>,
    group_row_counts: HashMap<String, usize>,
}

impl CrossIndex {
    fn build(file: &AgsFile) -> Self {
        let mut idx = CrossIndex::default();
        for (gname, group) in &file.groups {
            idx.group_names.insert(gname.clone());
            idx.group_row_counts.insert(gname.clone(), group.rows.len());

            let mut by_heading: HashMap<String, HashSet<String>> = HashMap::new();
            let mut rows_by_heading: HashMap<String, HashMap<String, crate::model::AgsRow>> =
                HashMap::new();
            for h in &group.headings {
                let mut set = HashSet::new();
                let mut rows = HashMap::new();
                for row in &group.rows {
                    if let Some(v) = row.get(&h.name).and_then(|v| v.as_text()) {
                        if !v.is_empty() {
                            set.insert(v.to_string());
                            rows.entry(v.to_string()).or_insert_with(|| row.clone());
                        }
                    }
                }
                by_heading.insert(h.name.clone(), set);
                rows_by_heading.insert(h.name.clone(), rows);
            }
            idx.by_group.insert(gname.clone(), by_heading);
            idx.rows_by_group.insert(gname.clone(), rows_by_heading);
        }
        idx
    }

    fn contains(&self, group: &str, heading: &str, value: &str) -> bool {
        self.by_group
            .get(group)
            .and_then(|m| m.get(heading))
            .map(|s| s.contains(value))
            .unwrap_or(false)
    }

    fn lookup(
        &self,
        group: &str,
        key_heading: &str,
        key_value: &str,
        return_heading: &str,
    ) -> Option<&crate::model::AgsValue> {
        self.rows_by_group
            .get(group)
            .and_then(|by_heading| by_heading.get(key_heading))
            .and_then(|rows| rows.get(key_value))
            .and_then(|row| row.get(return_heading))
    }

    fn has_group(&self, name: &str) -> bool {
        self.group_names.contains(name)
    }

    fn group_size(&self, name: &str) -> usize {
        self.group_row_counts.get(name).copied().unwrap_or(0)
    }
}

/// Compile + run a rule pack against `file`.
pub fn evaluate(file: &AgsFile, pack: &LoadedPack) -> Result<Vec<Diagnostic>, EvalError> {
    let mut diagnostics = Vec::new();

    let cross = Arc::new(CrossIndex::build(file));
    let codelists = Arc::new(pack.codelists.clone());
    let cel_file = file_to_cel(file);
    let cel_groups_meta = groups_meta_cel(file);
    let group_values: HashMap<String, Value> = file
        .groups
        .iter()
        .map(|(name, g)| (name.clone(), group_to_cel(g)))
        .collect();

    // Compile each rule's expressions up-front, surfacing parse errors.
    struct Compiled<'r> {
        rule: &'r super::pack::Rule,
        when: Option<Program>,
        expr: Program,
    }

    let mut compiled = Vec::with_capacity(pack.pack.rules.len());
    for r in &pack.pack.rules {
        let when = match &r.when {
            Some(src) => Some(Program::compile(src).map_err(|e| EvalError::Compile {
                rule_id: r.id.clone(),
                which: "when",
                message: e.to_string(),
            })?),
            None => None,
        };
        let expr = Program::compile(&r.expr).map_err(|e| EvalError::Compile {
            rule_id: r.id.clone(),
            which: "expr",
            message: e.to_string(),
        })?;
        compiled.push(Compiled {
            rule: r,
            when,
            expr,
        });
    }

    for c in &compiled {
        match c.rule.scope {
            Scope::Row => {
                for (group_name, group) in &file.groups {
                    for row in &group.rows {
                        let cel_row = row_to_cel(row);
                        let mut ctx = make_context(
                            cross.clone(),
                            codelists.clone(),
                            &cel_file,
                            &group_values,
                            &cel_groups_meta,
                        );
                        ctx.add_variable_from_value("row", cel_row);
                        ctx.add_variable_from_value(
                            "group",
                            Value::String(Arc::new(group_name.clone())),
                        );

                        if let Some(when) = &c.when {
                            match when.execute(&ctx) {
                                Ok(Value::Bool(true)) => {}
                                Ok(_) => continue,
                                Err(_) => continue,
                            }
                        }
                        match c.expr.execute(&ctx) {
                            Ok(Value::Bool(true)) => {}
                            Ok(_) => {
                                diagnostics.push(
                                    Diagnostic::new(
                                        c.rule.id.clone(),
                                        c.rule.severity,
                                        render_message(
                                            &c.rule.message,
                                            Some(row),
                                            Some(group_name),
                                            None,
                                        ),
                                    )
                                    .at_group(group_name.as_str()),
                                );
                            }
                            Err(e) => {
                                diagnostics.push(
                                    Diagnostic::new(
                                        c.rule.id.clone(),
                                        crate::diagnostics::Severity::Warning,
                                        format!("rule {} runtime error: {e}", c.rule.id),
                                    )
                                    .at_group(group_name.as_str()),
                                );
                            }
                        }
                    }
                }
            }
            Scope::File => {
                let mut ctx = make_context(
                    cross.clone(),
                    codelists.clone(),
                    &cel_file,
                    &group_values,
                    &cel_groups_meta,
                );
                ctx.add_variable_from_value("group", Value::Null);
                if let Some(when) = &c.when {
                    match when.execute(&ctx) {
                        Ok(Value::Bool(true)) => {}
                        _ => continue,
                    }
                }
                match c.expr.execute(&ctx) {
                    Ok(Value::Bool(true)) => {}
                    Ok(_) => {
                        diagnostics.push(Diagnostic::new(
                            c.rule.id.clone(),
                            c.rule.severity,
                            render_message(&c.rule.message, None, None, None),
                        ));
                    }
                    Err(e) => {
                        diagnostics.push(Diagnostic::new(
                            c.rule.id.clone(),
                            crate::diagnostics::Severity::Warning,
                            format!("rule {} runtime error: {e}", c.rule.id),
                        ));
                    }
                }
            }
            Scope::Group(ref heading) => {
                for (group_name, group) in &file.groups {
                    let mut partitions: HashMap<String, Vec<&crate::model::AgsRow>> =
                        HashMap::new();
                    for row in &group.rows {
                        let k = row
                            .get(heading)
                            .and_then(|v| v.as_text())
                            .unwrap_or("")
                            .to_string();
                        partitions.entry(k).or_default().push(row);
                    }

                    for (key_val, rows) in partitions {
                        let mut ctx = make_context(
                            cross.clone(),
                            codelists.clone(),
                            &cel_file,
                            &group_values,
                            &cel_groups_meta,
                        );
                        ctx.add_variable_from_value(
                            "group",
                            Value::String(Arc::new(group_name.clone())),
                        );

                        let cel_rows: Vec<Value> = rows.iter().map(|r| row_to_cel(r)).collect();
                        ctx.add_variable_from_value("rows", Value::List(Arc::new(cel_rows)));

                        let mut key_map_inner = HashMap::new();
                        key_map_inner.insert(
                            Key::String(Arc::new(heading.clone())),
                            Value::String(Arc::new(key_val.clone())),
                        );
                        let key_map = HashMap::from([(heading.clone(), key_val.clone())]);
                        ctx.add_variable_from_value(
                            "key",
                            Value::Map(Map {
                                map: Arc::new(key_map_inner),
                            }),
                        );

                        if let Some(when) = &c.when {
                            match when.execute(&ctx) {
                                Ok(Value::Bool(true)) => {}
                                _ => continue,
                            }
                        }

                        match c.expr.execute(&ctx) {
                            Ok(Value::Bool(true)) => {}
                            Ok(_) => {
                                diagnostics.push(
                                    Diagnostic::new(
                                        c.rule.id.clone(),
                                        c.rule.severity,
                                        render_message(
                                            &c.rule.message,
                                            rows.first().copied(),
                                            Some(group_name),
                                            Some(&key_map),
                                        ),
                                    )
                                    .at_group(group_name.as_str()),
                                );
                            }
                            Err(e) => {
                                diagnostics.push(
                                    Diagnostic::new(
                                        c.rule.id.clone(),
                                        crate::diagnostics::Severity::Warning,
                                        format!("rule {} runtime error: {e}", c.rule.id),
                                    )
                                    .at_group(group_name.as_str()),
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(diagnostics)
}

fn make_context<'a>(
    cross: Arc<CrossIndex>,
    codelists: Arc<Codelists>,
    file: &'a Value,
    groups: &'a HashMap<String, Value>,
    groups_meta: &'a Value,
) -> Context<'a> {
    let mut ctx = Context::default();
    ctx.add_variable_from_value("file", file.clone());
    ctx.add_variable_from_value("groups_meta", groups_meta.clone());
    for (name, value) in groups {
        ctx.add_variable_from_value(name.clone(), value.clone());
    }

    // has_group(name) -> Bool
    {
        let cross = cross.clone();
        ctx.add_function(
            "has_group",
            move |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
                let name = arg_string(&args, 0, "has_group")?;
                Ok(Value::Bool(cross.has_group(&name)))
            },
        );
    }

    // group_size(name) -> Int  (number of DATA rows)
    {
        let cross = cross.clone();
        ctx.add_function(
            "group_size",
            move |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
                let name = arg_string(&args, 0, "group_size")?;
                Ok(Value::Int(cross.group_size(&name) as i64))
            },
        );
    }

    // has_trailing_whitespace(row) -> Bool
    ctx.add_function(
        "has_trailing_whitespace",
        |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
            let map = match args.first() {
                Some(Value::Map(m)) => m,
                _ => {
                    return Err(ExecutionError::function_error(
                        "has_trailing_whitespace",
                        "expected row map",
                    ))
                }
            };
            for v in map.map.values() {
                if let Value::String(s) = v {
                    if s.as_str() != s.as_str().trim_end() {
                        return Ok(Value::Bool(true));
                    }
                }
            }
            Ok(Value::Bool(false))
        },
    );

    // is_valid_ags_type(type_str) -> Bool
    // Returns true for all recognised AGS type codes and for the empty
    // string (missing type, caught separately by AGS-HEAD-003).
    ctx.add_function(
        "is_valid_ags_type",
        |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
            let s = arg_string(&args, 0, "is_valid_ags_type")?;
            if s.is_empty() {
                return Ok(Value::Bool(true));
            }
            Ok(Value::Bool(!matches!(
                crate::model::AgsType::parse(&s),
                crate::model::AgsType::Other(_)
            )))
        },
    );

    // is_numeric_ags_type(type_str) -> Bool
    ctx.add_function(
        "is_numeric_ags_type",
        |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
            let s = arg_string(&args, 0, "is_numeric_ags_type")?;
            Ok(Value::Bool(crate::model::AgsType::parse(&s).is_numeric()))
        },
    );

    // codelist(name) -> List<String>
    {
        let codelists = codelists.clone();
        ctx.add_function(
            "codelist",
            move |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
                let name = match args.first() {
                    Some(Value::String(s)) => s.as_str().to_string(),
                    _ => {
                        return Err(ExecutionError::function_error(
                            "codelist",
                            "expected string id",
                        ))
                    }
                };
                let cl = codelists.get(&name).ok_or_else(|| {
                    ExecutionError::function_error("codelist", format!("unknown codelist {name:?}"))
                })?;
                let items: Vec<Value> = cl
                    .values
                    .iter()
                    .map(|v| Value::String(Arc::new(v.clone())))
                    .collect();
                Ok(Value::List(Arc::new(items)))
            },
        );
    }

    // exists_in(group, key, value) -> Bool
    {
        let cross = cross.clone();
        ctx.add_function(
            "exists_in",
            move |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
                let group = arg_string(&args, 0, "exists_in")?;
                let key = arg_string(&args, 1, "exists_in")?;
                let value = arg_string(&args, 2, "exists_in")?;
                Ok(Value::Bool(cross.contains(&group, &key, &value)))
            },
        );
    }

    // lookup(group, key_heading, key_value, return_heading) -> Value|null
    {
        let cross = cross.clone();
        ctx.add_function(
            "lookup",
            move |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
                let group = arg_string(&args, 0, "lookup")?;
                let key_heading = arg_string(&args, 1, "lookup")?;
                let key_value = arg_string(&args, 2, "lookup")?;
                let return_heading = arg_string(&args, 3, "lookup")?;
                Ok(cross
                    .lookup(&group, &key_heading, &key_value, &return_heading)
                    .map(ags_value_to_cel)
                    .unwrap_or(Value::Null))
            },
        );
    }

    // is_null(v) / not_null(v)
    ctx.add_function(
        "is_null",
        |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
            Ok(Value::Bool(matches!(args.first(), Some(Value::Null))))
        },
    );
    ctx.add_function(
        "not_null",
        |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
            Ok(Value::Bool(!matches!(args.first(), Some(Value::Null))))
        },
    );

    // regex(pattern, value) -> Bool
    ctx.add_function(
        "regex",
        |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
            let pat = arg_string(&args, 0, "regex")?;
            let value = arg_string(&args, 1, "regex")?;
            let re = regex::Regex::new(&pat)
                .map_err(|e| ExecutionError::function_error("regex", e.to_string()))?;
            Ok(Value::Bool(re.is_match(&value)))
        },
    );

    // between(value, lo, hi) -> Bool
    ctx.add_function("between", |a: f64, lo: f64, hi: f64| -> bool {
        a >= lo && a <= hi
    });

    // is_monotonic(list<Float|Int>) -> Bool
    ctx.add_function(
        "is_monotonic",
        |This(this): This<Value>| -> Result<Value, ExecutionError> {
            let list = match this {
                Value::List(l) => l,
                other => {
                    return Err(ExecutionError::function_error(
                        "is_monotonic",
                        format!("expected list, got {other:?}"),
                    ))
                }
            };
            let mut prev: Option<f64> = None;
            for v in list.iter() {
                let n = match v {
                    Value::Int(i) => *i as f64,
                    Value::UInt(u) => *u as f64,
                    Value::Float(f) => *f,
                    other => {
                        return Err(ExecutionError::function_error(
                            "is_monotonic",
                            format!("non-numeric element {other:?}"),
                        ))
                    }
                };
                if let Some(p) = prev {
                    if n < p {
                        return Ok(Value::Bool(false));
                    }
                }
                prev = Some(n);
            }
            Ok(Value::Bool(true))
        },
    );

    // point(e, n) -> Map { e, n }
    ctx.add_function(
        "point",
        |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
            let e = match args.first() {
                Some(Value::Float(f)) => *f,
                Some(Value::Int(i)) => *i as f64,
                Some(Value::UInt(u)) => *u as f64,
                _ => {
                    return Err(ExecutionError::function_error(
                        "point",
                        "expected float easting",
                    ))
                }
            };
            let n = match args.get(1) {
                Some(Value::Float(f)) => *f,
                Some(Value::Int(i)) => *i as f64,
                Some(Value::UInt(u)) => *u as f64,
                _ => {
                    return Err(ExecutionError::function_error(
                        "point",
                        "expected float northing",
                    ))
                }
            };
            let mut m: HashMap<Key, Value> = HashMap::new();
            m.insert(Key::String(Arc::new("e".into())), Value::Float(e));
            m.insert(Key::String(Arc::new("n".into())), Value::Float(n));
            Ok(Value::Map(Map { map: Arc::new(m) }))
        },
    );

    // distance_m(a, b) -> Float (planar distance in same CRS units)
    ctx.add_function(
        "distance_m",
        |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
            let a = arg_point(&args, 0, "distance_m")?;
            let b = arg_point(&args, 1, "distance_m")?;
            let dx = a.0 - b.0;
            let dy = a.1 - b.1;
            Ok(Value::Float((dx * dx + dy * dy).sqrt()))
        },
    );

    // bbox(list<Point>) -> Map { min_e, max_e, min_n, max_n }
    ctx.add_function(
        "bbox",
        |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
            let list = match args.first() {
                Some(Value::List(l)) => l,
                _ => {
                    return Err(ExecutionError::function_error(
                        "bbox",
                        "expected list of points",
                    ))
                }
            };
            let mut min_e = f64::INFINITY;
            let mut max_e = f64::NEG_INFINITY;
            let mut min_n = f64::INFINITY;
            let mut max_n = f64::NEG_INFINITY;
            for v in list.iter() {
                let (e, n) = match v {
                    Value::Map(m) => {
                        let e = lookup_number(m, "e").ok_or_else(|| {
                            ExecutionError::function_error("bbox", "point missing e")
                        })?;
                        let n = lookup_number(m, "n").ok_or_else(|| {
                            ExecutionError::function_error("bbox", "point missing n")
                        })?;
                        (e, n)
                    }
                    _ => return Err(ExecutionError::function_error("bbox", "expected point map")),
                };
                min_e = min_e.min(e);
                max_e = max_e.max(e);
                min_n = min_n.min(n);
                max_n = max_n.max(n);
            }
            let mut m = HashMap::new();
            m.insert(Key::String(Arc::new("min_e".into())), Value::Float(min_e));
            m.insert(Key::String(Arc::new("max_e".into())), Value::Float(max_e));
            m.insert(Key::String(Arc::new("min_n".into())), Value::Float(min_n));
            m.insert(Key::String(Arc::new("max_n".into())), Value::Float(max_n));
            Ok(Value::Map(Map { map: Arc::new(m) }))
        },
    );

    // within(point, polygon_list) -> Bool
    ctx.add_function(
        "within",
        |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
            let p = arg_point(&args, 0, "within")?;
            let poly_list = match args.get(1) {
                Some(Value::List(l)) => l,
                _ => {
                    return Err(ExecutionError::function_error(
                        "within",
                        "expected list of points for polygon",
                    ))
                }
            };
            use geo::{Contains, Coord, LineString, Point, Polygon};
            let mut coords = Vec::with_capacity(poly_list.len());
            for v in poly_list.iter() {
                match v {
                    Value::Map(m) => {
                        let e = lookup_number(m, "e").ok_or_else(|| {
                            ExecutionError::function_error("within", "point missing e")
                        })?;
                        let n = lookup_number(m, "n").ok_or_else(|| {
                            ExecutionError::function_error("within", "point missing n")
                        })?;
                        coords.push(Coord { x: e, y: n });
                    }
                    _ => {
                        return Err(ExecutionError::function_error(
                            "within",
                            "expected point map in polygon list",
                        ))
                    }
                }
            }
            if coords.is_empty() {
                return Ok(Value::Bool(false));
            }
            // Close the polygon if not already closed
            if coords.first() != coords.last() {
                coords.push(*coords.first().unwrap());
            }
            let polygon = Polygon::new(LineString::new(coords), vec![]);
            let point = Point::new(p.0, p.1);
            Ok(Value::Bool(polygon.contains(&point)))
        },
    );

    // crs(epsg) -> Crs
    ctx.add_function(
        "crs",
        |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
            let epsg = match args.first() {
                Some(Value::UInt(u)) => *u as u32,
                Some(Value::Int(i)) => *i as u32,
                _ => {
                    return Err(ExecutionError::function_error(
                        "crs",
                        "expected epsg integer",
                    ))
                }
            };
            let _crs = crate::spatial::Crs::from_epsg(epsg).ok_or_else(|| {
                ExecutionError::function_error("crs", format!("unsupported epsg: {epsg}"))
            })?;
            // We'll wrap Crs in a Value. For now just use an Int of EPSG.
            // CEL doesn't have custom types easily, so we'll just pass EPSG around.
            Ok(Value::UInt(epsg as u64))
        },
    );

    // reproject(point, from_epsg, to_epsg) -> Point
    ctx.add_function(
        "reproject",
        |Arguments(args): Arguments| -> Result<Value, ExecutionError> {
            let p = arg_point(&args, 0, "reproject")?;
            let from_epsg = match args.get(1) {
                Some(Value::UInt(u)) => *u as u32,
                Some(Value::Int(i)) => *i as u32,
                _ => {
                    return Err(ExecutionError::function_error(
                        "reproject",
                        "expected from_epsg",
                    ))
                }
            };
            let to_epsg = match args.get(2) {
                Some(Value::UInt(u)) => *u as u32,
                Some(Value::Int(i)) => *i as u32,
                _ => {
                    return Err(ExecutionError::function_error(
                        "reproject",
                        "expected to_epsg",
                    ))
                }
            };

            let from = crate::spatial::Crs::from_epsg(from_epsg).ok_or_else(|| {
                ExecutionError::function_error(
                    "reproject",
                    format!("unsupported from_epsg: {from_epsg}"),
                )
            })?;
            let to = crate::spatial::Crs::from_epsg(to_epsg).ok_or_else(|| {
                ExecutionError::function_error(
                    "reproject",
                    format!("unsupported to_epsg: {to_epsg}"),
                )
            })?;

            let (e2, n2) = crate::spatial::reproject(p, from, to);

            let mut m: HashMap<Key, Value> = HashMap::new();
            m.insert(Key::String(Arc::new("e".into())), Value::Float(e2));
            m.insert(Key::String(Arc::new("n".into())), Value::Float(n2));
            Ok(Value::Map(Map { map: Arc::new(m) }))
        },
    );

    // count(list) -> Int
    ctx.add_function(
        "count",
        |This(this): This<Value>| -> Result<Value, ExecutionError> {
            match this {
                Value::List(l) => Ok(Value::Int(l.len() as i64)),
                other => Err(ExecutionError::function_error(
                    "count",
                    format!("expected list, got {other:?}"),
                )),
            }
        },
    );

    // unique(list) -> List
    ctx.add_function(
        "unique",
        |This(this): This<Value>| -> Result<Value, ExecutionError> {
            match this {
                Value::List(l) => {
                    let mut seen = HashSet::new();
                    let mut out = Vec::new();
                    for v in l.iter() {
                        let key = match v {
                            Value::String(s) => s.as_str().to_string(),
                            Value::Int(i) => i.to_string(),
                            Value::Float(f) => f.to_string(),
                            Value::Bool(b) => b.to_string(),
                            Value::Null => "null".to_string(),
                            _ => {
                                return Err(ExecutionError::function_error(
                                    "unique",
                                    "can only unique primitive values",
                                ))
                            }
                        };
                        if seen.insert(key) {
                            out.push(v.clone());
                        }
                    }
                    Ok(Value::List(Arc::new(out)))
                }
                other => Err(ExecutionError::function_error(
                    "unique",
                    format!("expected list, got {other:?}"),
                )),
            }
        },
    );

    // sum/min/max/avg(list<Number>)
    ctx.add_function(
        "sum",
        |This(this): This<Value>| -> Result<Value, ExecutionError> {
            let list = arg_list_numbers(&this, "sum")?;
            Ok(Value::Float(list.iter().sum()))
        },
    );
    ctx.add_function(
        "min",
        |This(this): This<Value>| -> Result<Value, ExecutionError> {
            let list = arg_list_numbers(&this, "min")?;
            let m = list.iter().copied().fold(f64::INFINITY, f64::min);
            Ok(Value::Float(m))
        },
    );
    ctx.add_function(
        "max",
        |This(this): This<Value>| -> Result<Value, ExecutionError> {
            let list = arg_list_numbers(&this, "max")?;
            let m = list.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            Ok(Value::Float(m))
        },
    );
    ctx.add_function(
        "avg",
        |This(this): This<Value>| -> Result<Value, ExecutionError> {
            let list = arg_list_numbers(&this, "avg")?;
            if list.is_empty() {
                return Ok(Value::Float(0.0));
            }
            Ok(Value::Float(list.iter().sum::<f64>() / list.len() as f64))
        },
    );

    ctx
}

fn arg_list_numbers(v: &Value, func: &'static str) -> Result<Vec<f64>, ExecutionError> {
    let list = match v {
        Value::List(l) => l,
        other => {
            return Err(ExecutionError::function_error(
                func,
                format!("expected list, got {other:?}"),
            ))
        }
    };
    let mut out = Vec::with_capacity(list.len());
    for v in list.iter() {
        match v {
            Value::Int(i) => out.push(*i as f64),
            Value::UInt(u) => out.push(*u as f64),
            Value::Float(f) => out.push(*f),
            Value::Null => {} // ignore nulls in aggregates
            other => {
                return Err(ExecutionError::function_error(
                    func,
                    format!("expected number in list, got {other:?}"),
                ))
            }
        }
    }
    Ok(out)
}

fn arg_string(args: &[Value], i: usize, func: &'static str) -> Result<String, ExecutionError> {
    match args.get(i) {
        Some(Value::String(s)) => Ok(s.as_str().to_string()),
        Some(other) => Err(ExecutionError::function_error(
            func,
            format!("arg {} must be string, got {other:?}", i + 1),
        )),
        None => Err(ExecutionError::function_error(
            func,
            format!("missing arg {}", i + 1),
        )),
    }
}

fn arg_point(args: &[Value], i: usize, func: &'static str) -> Result<(f64, f64), ExecutionError> {
    match args.get(i) {
        Some(Value::Map(m)) => {
            let e = lookup_number(m, "e")
                .ok_or_else(|| ExecutionError::function_error(func, "point map missing `e`"))?;
            let n = lookup_number(m, "n")
                .ok_or_else(|| ExecutionError::function_error(func, "point map missing `n`"))?;
            Ok((e, n))
        }
        Some(other) => Err(ExecutionError::function_error(
            func,
            format!("arg {} must be a point map, got {other:?}", i + 1),
        )),
        None => Err(ExecutionError::function_error(
            func,
            format!("missing arg {}", i + 1),
        )),
    }
}

fn lookup_number(m: &Map, key: &str) -> Option<f64> {
    let k = Key::String(Arc::new(key.into()));
    match m.get(&k) {
        Some(Value::Int(i)) => Some(*i as f64),
        Some(Value::UInt(u)) => Some(*u as f64),
        Some(Value::Float(f)) => Some(*f),
        _ => None,
    }
}

/// Apply automated fixes from `pack` to `file`.
/// Returns list of rule IDs that were applied.
pub fn fix(file: &mut AgsFile, pack: &LoadedPack) -> Result<Vec<String>, EvalError> {
    let mut applied = Vec::new();

    let cross = Arc::new(CrossIndex::build(file));
    let codelists = Arc::new(pack.codelists.clone());
    let cel_file = file_to_cel(file);
    let cel_groups_meta = groups_meta_cel(file);
    let group_values: HashMap<String, Value> = file
        .groups
        .iter()
        .map(|(name, g)| (name.clone(), group_to_cel(g)))
        .collect();

    for r in &pack.pack.rules {
        if r.fix.is_empty() {
            continue;
        }

        let when = match &r.when {
            Some(src) => Some(Program::compile(src).map_err(|e| EvalError::Compile {
                rule_id: r.id.clone(),
                which: "when",
                message: e.to_string(),
            })?),
            None => None,
        };
        let expr = Program::compile(&r.expr).map_err(|e| EvalError::Compile {
            rule_id: r.id.clone(),
            which: "expr",
            message: e.to_string(),
        })?;

        match r.scope {
            Scope::Row => {
                for (group_name, group) in file.groups.iter_mut() {
                    let mut row_index = 0;
                    while row_index < group.rows.len() {
                        let cel_row = row_to_cel(&group.rows[row_index]);
                        let mut ctx = make_context(
                            cross.clone(),
                            codelists.clone(),
                            &cel_file,
                            &group_values,
                            &cel_groups_meta,
                        );
                        ctx.add_variable_from_value("row", cel_row);
                        ctx.add_variable_from_value(
                            "group",
                            Value::String(Arc::new(group_name.clone())),
                        );

                        if let Some(when) = &when {
                            match when.execute(&ctx) {
                                Ok(Value::Bool(true)) => {}
                                _ => {
                                    row_index += 1;
                                    continue;
                                }
                            }
                        }

                        if let Ok(Value::Bool(false)) = expr.execute(&ctx) {
                            let mut row_changed = false;
                            let mut delete_row = false;
                            for step in &r.fix {
                                match &step.op {
                                    super::pack::FixOp::Set { value } => {
                                        let heading = step.heading.as_ref().ok_or_else(|| {
                                            EvalError::Compile {
                                                rule_id: r.id.clone(),
                                                which: "fix",
                                                message: "set fix requires a heading".to_string(),
                                            }
                                        })?;
                                        group.rows[row_index].insert(
                                            heading.clone(),
                                            crate::model::AgsValue::Text(value.clone()),
                                        );
                                        row_changed = true;
                                    }
                                    super::pack::FixOp::DeleteRow => {
                                        delete_row = true;
                                    }
                                }
                            }
                            if delete_row {
                                group.rows.remove(row_index);
                                applied.push(r.id.clone());
                                continue;
                            }
                            if row_changed {
                                applied.push(r.id.clone());
                            }
                        }
                        row_index += 1;
                    }
                }
            }
            _ => {
                // File/Group scoped fixes deferred.
            }
        }
    }

    applied.sort();
    applied.dedup();
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ags::parse_str;
    use crate::dsl::pack::RulePack;

    fn run(ags: &str, pack_yaml: &str) -> Vec<Diagnostic> {
        let parsed = parse_str(ags);
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let pack = RulePack::parse(pack_yaml).unwrap();
        let loaded = pack.into_loaded().unwrap();
        evaluate(&parsed.file, &loaded).unwrap()
    }

    const AGS: &str = r#""GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"

"GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","100.00","200.00"
"DATA","BH02","100.50","200.20"
"DATA","BH03","500.00","500.00"

"GROUP","SAMP"
"HEADING","LOCA_ID","SAMP_ID","SAMP_TYPE"
"UNIT","","",""
"TYPE","ID","ID","PA"
"DATA","BH01","S1","B"
"DATA","BHX","S2","Z"
"#;

    #[test]
    fn row_scope_existence_check() {
        let pack = r#"
version: 1
rules:
  - id: LOCA-COORDS
    severity: error
    when: "group == 'LOCA'"
    expr: "row.LOCA_NATE != null && row.LOCA_NATN != null"
    message: "LOCA {row.LOCA_ID} missing coords"
"#;
        let d = run(AGS, pack);
        assert!(d.is_empty(), "{:?}", d);
    }

    #[test]
    fn exists_in_flags_orphan_sample() {
        let pack = r#"
version: 1
rules:
  - id: SAMP-XREF
    severity: error
    when: "group == 'SAMP'"
    expr: "exists_in('LOCA', 'LOCA_ID', row.LOCA_ID)"
    message: "Sample {row.SAMP_ID} references unknown LOCA {row.LOCA_ID}"
"#;
        let d = run(AGS, pack);
        assert_eq!(d.len(), 1, "{:?}", d);
        assert!(d[0].message.contains("BHX"));
    }

    #[test]
    fn lookup_reads_values_from_related_group() {
        let pack = r#"
version: 1
rules:
  - id: SAMP-LOOKUP
    severity: error
    when: "group == 'SAMP'"
    expr: "lookup('LOCA', 'LOCA_ID', row.LOCA_ID, 'LOCA_NATE') != null"
    message: "Sample {row.SAMP_ID} is not tied to a known location"
"#;
        let d = run(AGS, pack);
        assert_eq!(d.len(), 1, "{:?}", d);
        assert!(d[0].message.contains("S2"));
    }

    #[test]
    fn codelist_check() {
        let pack = r#"
version: 1
codelists:
  ice_sample_types:
    inline: ["B", "U", "D"]
rules:
  - id: SAMP-TYPE
    severity: warning
    when: "group == 'SAMP'"
    expr: "row.SAMP_TYPE in codelist('ice_sample_types')"
    message: "Sample type {row.SAMP_TYPE} not permitted"
"#;
        let d = run(AGS, pack);
        assert_eq!(d.len(), 1);
        assert!(d[0].message.contains("Z"));
    }

    #[test]
    fn file_scope_vicinity_check() {
        // Bind LOCA list at file scope; flag if ANY pair is within 1.0 of each other.
        let pack = r#"
version: 1
rules:
  - id: LOCA-VIC
    severity: warning
    scope: file
    expr: |
      LOCA.all(a, LOCA.all(b,
        a.LOCA_ID == b.LOCA_ID ||
        distance_m(point(a.LOCA_NATE, a.LOCA_NATN),
                   point(b.LOCA_NATE, b.LOCA_NATN)) > 1.0))
    message: "two boreholes are within 1m"
"#;
        let d = run(AGS, pack);
        // BH01 and BH02 are ~0.54m apart → expect a diagnostic.
        assert_eq!(d.len(), 1, "{:?}", d);
    }

    #[test]
    fn group_scope_monotonic_check() {
        let pack = r#"
version: 1
rules:
  - id: GEOL-MONO
    severity: warning
    scope: "group:LOCA_ID"
    when: "group == 'GEOL'"
    expr: "is_monotonic(rows.map(r, r.GEOL_TOP))"
    message: "Non-monotonic GEOL layers under LOCA {key.LOCA_ID}"
"#;
        let ags = r#""GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"

"GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"

"GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH01"
"DATA","BH02"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","0.00","1.00"
"DATA","BH01","1.00","2.00"
"DATA","BH02","0.00","1.00"
"DATA","BH02","0.50","1.50"
"#;
        let d = run(ags, pack);
        assert!(d.is_empty(), "{:?}", d);

        let bad_ags = r#""GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"

"GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"

"GROUP","LOCA"
"HEADING","LOCA_ID"
"UNIT",""
"TYPE","ID"
"DATA","BH01"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","0.00","1.00"
"DATA","BH01","0.50","2.00"
"DATA","BH01","0.20","0.50"
"#;
        let d = run(bad_ags, pack);
        assert_eq!(d.len(), 1);
        assert!(d[0].message.contains("BH01"));
    }

    #[test]
    fn compile_error_surfaces() {
        let parsed = parse_str(AGS);
        let pack = RulePack::parse(
            r#"
version: 1
rules:
  - id: BAD
    severity: error
    expr: "this is not cel @@@"
    message: "x"
"#,
        )
        .unwrap();
        let loaded = LoadedPack::from_inline(pack, vec![]);
        let err = evaluate(&parsed.file, &loaded).unwrap_err();
        assert!(matches!(err, EvalError::Compile { .. }));
    }

    #[test]
    fn row_fix_can_delete_matching_rows() {
        let mut parsed = parse_str(AGS).file;
        let pack = RulePack::parse(
            r#"
version: 1
rules:
  - id: DROP-UNKNOWN-SAMPLES
    severity: warning
    when: "group == 'SAMP'"
    expr: "exists_in('LOCA', 'LOCA_ID', row.LOCA_ID)"
    message: "drop orphan sample"
    fix:
      - op: deleterow
"#,
        )
        .unwrap();
        let loaded = pack.into_loaded().unwrap();
        let applied = fix(&mut parsed, &loaded).unwrap();
        assert_eq!(applied, vec!["DROP-UNKNOWN-SAMPLES"]);
        let samp = parsed.group("SAMP").unwrap();
        assert_eq!(samp.rows.len(), 1);
        assert_eq!(
            samp.rows[0].get("SAMP_ID").and_then(|v| v.as_text()),
            Some("S1")
        );
    }

    #[test]
    fn row_fix_set_without_heading_errors() {
        let mut parsed = parse_str(AGS).file;
        let pack = RulePack::parse(
            r#"
version: 1
rules:
  - id: BROKEN-FIX
    severity: warning
    when: "group == 'SAMP'"
    expr: "false"
    message: "broken"
    fix:
      - op: set
        value: "X"
"#,
        )
        .unwrap();
        let loaded = pack.into_loaded().unwrap();
        let err = fix(&mut parsed, &loaded).unwrap_err();
        assert!(matches!(err, EvalError::Compile { .. }));
    }
}
