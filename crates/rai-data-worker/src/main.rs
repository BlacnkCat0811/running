use chrono::{DateTime, SecondsFormat, Utc};
use quick_xml::{events::Event, Reader};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Read},
    path::{Path, PathBuf},
    time::Instant,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const TOKEN_LIMIT: usize = 1024 * 1024;
const UNIT_LIMIT: usize = 8 * 1024 * 1024;
const SPOOL_LIMIT: u64 = 8 * 1024 * 1024 * 1024;

/// Count/hash consumed input, and refuse an unbounded XML token before allocation.
struct Input {
    inner: BufReader<File>,
    hash: Sha256,
    bytes: u64,
    event_bytes: usize,
}
impl Input {
    fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            inner: BufReader::with_capacity(64 * 1024, File::open(path)?),
            hash: Sha256::new(),
            bytes: 0,
            event_bytes: 0,
        })
    }
}
impl BufRead for Input {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        if self.event_bytes >= TOKEN_LIMIT {
            return Err(io::Error::other("resource_limit: XML token"));
        }
        let bytes = self.inner.fill_buf()?;
        let n = bytes.len().min(TOKEN_LIMIT - self.event_bytes);
        Ok(&bytes[..n])
    }
    fn consume(&mut self, amount: usize) {
        let buf = self.inner.buffer();
        let n = amount.min(buf.len());
        self.hash.update(&buf[..n]);
        self.bytes += n as u64;
        self.event_bytes += n;
        self.inner.consume(n);
    }
}
impl Read for Input {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let buf = self.fill_buf()?;
        let n = out.len().min(buf.len());
        out[..n].copy_from_slice(&buf[..n]);
        self.consume(n);
        Ok(n)
    }
}

fn name(s: &str) -> Result<String> {
    // Standard Apple/GPX names are ASCII. Unusual legal names can use the
    // reference engine; never silently accept malformed names.
    let mut chars = s.chars();
    let first = chars.next().ok_or("invalid_xml: empty name")?;
    if !s.is_ascii() {
        return Err("unsupported_xml: non-ASCII XML name".into());
    }
    if !(first.is_ascii_alphabetic() || first == '_' || first == ':')
        || !chars.all(|c| c.is_ascii_alphanumeric() || "_:-.".contains(c))
    {
        return Err("invalid_xml: invalid name".into());
    }
    Ok(s.rsplit(':').next().unwrap_or(s).to_owned())
}

fn valid_chars(text: &str) -> bool {
    text.chars().all(
        |c| matches!(c as u32, 9 | 10 | 13 | 0x20..=0xd7ff | 0xe000..=0xfffd | 0x10000..=0x10ffff),
    )
}
fn xml_text(raw: &str, attribute: bool) -> Result<String> {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    if !attribute && normalized.contains("]]>") {
        return Err("invalid_xml: forbidden text delimiter".into());
    }
    let normalized = if attribute {
        normalized.replace(['\n', '\t'], " ")
    } else {
        normalized
    };
    let value = quick_xml::escape::unescape(&normalized)
        .map_err(|e| format!("invalid_xml: {e}"))?
        .into_owned();
    if !valid_chars(&value) {
        return Err("invalid_xml: invalid character".into());
    }
    Ok(value)
}
fn attrs(tag: &quick_xml::events::BytesStart<'_>) -> Result<Map<String, Value>> {
    let mut result = Map::new();
    for attr in tag.attributes().with_checks(true) {
        let attr = attr.map_err(|e| format!("invalid_xml: {e}"))?;
        name(attr.key.as_ref())?;
        let key = attr.key.as_ref().to_owned();
        let raw = attr.value.as_ref();
        if raw.contains('<') {
            return Err("invalid_xml: literal < in attribute".into());
        }
        result.insert(key, Value::String(xml_text(raw, true)?));
    }
    Ok(result)
}

#[derive(Default)]
struct Unit {
    events: Vec<Value>,
    depth: usize,
    bytes: usize,
}
impl Unit {
    fn push(&mut self, value: Value, bytes: usize) -> Result<()> {
        self.bytes += bytes;
        if self.bytes > UNIT_LIMIT {
            return Err("resource_limit: XML entity".into());
        }
        self.events.push(value);
        Ok(())
    }
}

fn number(value: Option<&str>) -> Result<Option<f64>> {
    let text = match value {
        Some(s) => s.trim_matches(js_whitespace),
        None => return Ok(None),
    };
    if text.is_empty() {
        return Ok(None);
    }
    // JS accepts these forms, Rust's decimal parser does not. Use the reference
    // engine rather than inventing a different numeric identity/interpretation.
    if text.starts_with("0x")
        || text.starts_with("0X")
        || text.starts_with("0b")
        || text.starts_with("0B")
        || text.starts_with("0o")
        || text.starts_with("0O")
    {
        return Err("unsupported_xml: non-decimal number".into());
    }
    let value = text.parse::<f64>().ok().filter(|v| v.is_finite());
    Ok(value)
}

fn js_whitespace(c: char) -> bool {
    matches!(c as u32, 0x9..=0xd | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn timestamp(value: Option<&str>) -> Result<Option<String>> {
    let text = match value {
        Some(s) => s.trim_matches(js_whitespace),
        None => return Ok(None),
    };
    if text.is_empty() {
        return Ok(None);
    }
    match DateTime::parse_from_rfc3339(text) {
        Ok(dt)
            if (0..=9999).contains(&chrono::Datelike::year(&dt.with_timezone(&Utc)))
                && chrono::Timelike::nanosecond(&dt) < 1_000_000_000 =>
        {
            Ok(Some(
                dt.with_timezone(&Utc)
                    .to_rfc3339_opts(SecondsFormat::Millis, true),
            ))
        }
        _ => Err("unsupported_xml: non-RFC3339 GPX timestamp".into()),
    }
}

fn write_unit(db: &Connection, events: &[Value]) -> Result<()> {
    // Common records avoid a generic event replay in JS, but stable IDs and
    // canonicalization still run through the existing contract implementation.
    let record = events
        .first()
        .and_then(|e| e.get(1))
        .and_then(Value::as_str)
        == Some("Record");
    let simple = record
        && events[1..events.len() - 1]
            .iter()
            .all(|e| e.get(1).and_then(Value::as_str) == Some("MetadataEntry"));
    if simple {
        let metadata: Vec<&Value> = events
            .iter()
            .filter(|e| e[0] == "open" && e[1] == "MetadataEntry")
            .map(|e| &e[2])
            .collect();
        db.prepare_cached("INSERT INTO xml_units(kind, payload) VALUES ('record',?)")?
            .execute([serde_json::to_string(
                &json!({"attributes":events[0][2], "metadata":metadata}),
            )?])?;
    } else {
        db.prepare_cached("INSERT INTO xml_units(kind,payload) VALUES ('events',?)")?
            .execute([serde_json::to_string(events)?])?;
    }
    Ok(())
}

fn parse_xml(path: &Path, db: &Connection, gpx: bool) -> Result<Value> {
    let mut reader = Reader::from_reader(Input::open(path)?);
    reader.config_mut().check_end_names = true;
    reader.config_mut().check_comments = true;
    let mut buf = Vec::new();
    let mut depth = 0usize;
    let mut roots = 0usize;
    let mut declaration = false;
    let mut doctype = false;
    let mut unit: Option<Unit> = None;
    let mut rows = 0u64;
    let mut point: Option<Map<String, Value>> = None;
    let mut field: Option<String> = None;
    let mut text = String::new();
    loop {
        reader.get_mut().event_bytes = 0;
        let event = reader.read_event_into(&mut buf)?;
        let event_bytes = reader.get_ref().event_bytes;
        // Validate ignored content too: Node's UTF-8 replacement hashing is not
        // the same as hashing invalid bytes. Such inputs use the reference path.
        let ignored: Option<&str> = match &event {
            Event::Comment(value) => Some(value.as_ref()),
            Event::CData(value) => Some(value.as_ref()),
            Event::PI(value) => Some(value.as_ref()),
            _ => None,
        };
        if ignored.is_some_and(|s| !valid_chars(s)) {
            return Err("invalid_xml: invalid character".into());
        }
        let (start, empty) = match &event {
            Event::Start(tag) => (Some(tag), false),
            Event::Empty(tag) => (Some(tag), true),
            _ => (None, false),
        };
        if let Some(tag) = start {
            if depth == 0 {
                roots += 1;
                if roots != 1 {
                    return Err("invalid_xml: multiple roots".into());
                }
            }
            depth += 1;
            if depth > 256 {
                return Err("resource_limit: XML depth".into());
            }
            let n = name(tag.name().as_ref())?;
            let attributes = attrs(tag)?;
            if gpx {
                if n == "trkpt" {
                    if point.is_some() {
                        return Err("unsupported_xml: nested track points".into());
                    }
                    point = Some(attributes.clone());
                } else if point.is_some()
                    && ["time", "ele", "speed", "course", "hAcc", "vAcc"].contains(&n.as_str())
                {
                    field = Some(n.clone());
                    text.clear();
                }
            } else {
                if unit.is_none()
                    && ["Record", "Workout", "Me", "ExportDate", "ActivitySummary"]
                        .contains(&n.as_str())
                {
                    unit = Some(Unit {
                        depth,
                        ..Unit::default()
                    });
                }
                if let Some(u) = &mut unit {
                    u.push(json!(["open", n, attributes]), event_bytes)?;
                }
            }
            if empty {
                close(
                    &n, depth, &mut unit, &mut point, &mut field, &mut text, db, gpx, &mut rows,
                )?;
                depth -= 1;
            }
        } else {
            match event {
                Event::End(tag) => {
                    if depth == 0 {
                        return Err("invalid_xml: unmatched close".into());
                    }
                    let n = name(tag.name().as_ref())?;
                    close(
                        &n, depth, &mut unit, &mut point, &mut field, &mut text, db, gpx, &mut rows,
                    )?;
                    depth -= 1;
                }
                Event::Text(value) => {
                    let value = xml_text(value.as_ref(), false)?;
                    if depth == 0 && !value.chars().all(|c| matches!(c, ' ' | '\t' | '\r' | '\n')) {
                        return Err("invalid_xml: text outside root".into());
                    }
                    if gpx && field.is_some() {
                        text.push_str(&value);
                    }
                }
                Event::GeneralRef(value) => {
                    let value = xml_text(&format!("&{};", value.as_ref()), false)?;
                    if depth == 0 {
                        return Err("invalid_xml: reference outside root".into());
                    }
                    if gpx && field.is_some() {
                        text.push_str(&value);
                    }
                }
                Event::DocType(value) => {
                    let value = value.as_ref().to_ascii_uppercase();
                    if depth != 0 || roots != 0 || doctype {
                        return Err("invalid_xml: misplaced DTD".into());
                    }
                    doctype = true;
                    if value.contains("ENTITY")
                        || value.contains("SYSTEM")
                        || value.contains("PUBLIC")
                    {
                        return Err("unsupported_xml: DTD entities".into());
                    }
                }
                Event::Decl(value) => {
                    if roots != 0
                        || depth != 0
                        || declaration
                        || doctype
                        || reader.get_ref().bytes != event_bytes as u64
                    {
                        return Err("invalid_xml: misplaced declaration".into());
                    }
                    declaration = true;
                    if value.version()?.as_ref() != "1.0" {
                        return Err("unsupported_xml: XML version".into());
                    }
                    if let Some(encoding) = value.encoding() {
                        if !encoding?.eq_ignore_ascii_case("UTF-8") {
                            return Err("unsupported_xml: encoding".into());
                        }
                    }
                }
                Event::CData(_) => {
                    // Existing GPX parser listens to text, not cdata.
                    if depth == 0 {
                        return Err("invalid_xml: CDATA outside root".into());
                    }
                }
                Event::Eof => break,
                _ => {}
            }
        }
        if text.len() > TOKEN_LIMIT {
            return Err("resource_limit: text".into());
        }
        if rows % 4096 == 0 && rows > 0 {
            let pages: i64 = db.query_row("PRAGMA page_count", [], |r| r.get(0))?;
            let page_size: i64 = db.query_row("PRAGMA page_size", [], |r| r.get(0))?;
            if (pages * page_size) as u64 > SPOOL_LIMIT {
                return Err("resource_limit: spool".into());
            }
        }
        buf.clear();
    }
    if roots != 1 || depth != 0 || unit.is_some() {
        return Err("invalid_xml: incomplete document".into());
    }
    Ok(json!({"rows": rows, "inputBytes": reader.get_ref().bytes,
        "sha256": format!("{:x}", reader.get_ref().hash.clone().finalize())}))
}

#[allow(clippy::too_many_arguments)]
fn close(
    n: &str,
    depth: usize,
    unit: &mut Option<Unit>,
    point: &mut Option<Map<String, Value>>,
    field: &mut Option<String>,
    text: &mut String,
    db: &Connection,
    gpx: bool,
    rows: &mut u64,
) -> Result<()> {
    if gpx {
        if field.as_deref() == Some(n) {
            if let Some(p) = point.as_mut() {
                p.insert(
                    n.to_owned(),
                    Value::String(text.trim_matches(js_whitespace).to_owned()),
                );
            }
            *field = None;
            text.clear();
        }
        if n == "trkpt" {
            if let Some(p) = point.take() {
                let get = |k: &str| p.get(k).and_then(Value::as_str);
                if let (Some(lat), Some(lon)) = (number(get("lat"))?, number(get("lon"))?) {
                    db.prepare_cached("INSERT INTO gpx_points VALUES (?,?,?,?,?,?,?,?,?,?)")?
                        .execute(params![
                            *rows as i64,
                            timestamp(get("time"))?,
                            lat,
                            lon,
                            number(get("ele"))?,
                            number(get("speed"))?,
                            number(get("course"))?,
                            number(get("hAcc"))?,
                            number(get("vAcc"))?,
                            0
                        ])?;
                    *rows += 1;
                }
            }
        }
    } else if let Some(u) = unit.as_mut() {
        u.push(json!(["close", n]), n.len() + 4)?;
        if depth == u.depth {
            write_unit(db, &u.events)?;
            *rows += 1;
            *unit = None;
        }
    }
    Ok(())
}

/// Read-only native route aggregation for unambiguous, single-route workouts.
/// Multi-route ordering is left to the reference implementation.
///
/// 🔴 `readable_route_points` is the **one** relation that answers "which route points are
/// readable right now" (v43; see `packages/storage-sqlite/src/v43-migration.ts`). Reading the
/// `route_points` table directly would return nothing for a published route after the O11
/// write-amplification fix moved its points into the published version — the aggregate would
/// silently degrade to "this workout has no elevation gain", and it would disagree with the
/// TypeScript fallback in `recompute-pipeline.ts` that reads the same view. The view's
/// readability predicate is the same one the write side uses (`usableRouteConditionSql()`).
fn aggregate(input: &Path, output: &Connection) -> Result<Value> {
    let source = Connection::open_with_flags(input, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut query = source.prepare(
        "SELECT route.workout_id, point.elevation_meters FROM workout_routes route
         JOIN readable_route_points point ON point.route_id=route.id
         WHERE route.workout_id IN (SELECT workout_id FROM workout_routes WHERE workout_id IS NOT NULL GROUP BY workout_id HAVING COUNT(*)=1)
           AND point.elevation_meters IS NOT NULL
         ORDER BY route.workout_id, point.sequence")?;
    let mut rows = query.query([])?;
    let mut id = String::new();
    let mut previous = 0.0f64;
    let mut gain = 0.0f64;
    let mut count = 0u64;
    let mut workouts = 0u64;
    let save = |id: &str, count: u64, gain: f64| -> Result<()> {
        if !id.is_empty() {
            output.execute(
                "INSERT INTO route_aggregates VALUES (?,?)",
                params![id, if count < 2 { None } else { Some(gain) }],
            )?;
        }
        Ok(())
    };
    while let Some(row) = rows.next()? {
        let next: String = row.get(0)?;
        let elevation: f64 = row.get(1)?;
        if next != id {
            save(&id, count, gain)?;
            id = next;
            count = 0;
            gain = 0.0;
            workouts += 1;
        }
        if count > 0 {
            let delta = elevation - previous;
            if delta.is_finite() && delta > 0.0 && delta < 30.0 {
                gain += delta;
            }
        }
        previous = elevation;
        count += 1;
    }
    save(&id, count, gain)?;
    Ok(json!({"rows": workouts}))
}

/// The canonical rows and IDs are produced by the reference contract. Only a
/// CLI-owned staging DB bearing a one-shot permit may receive native writes.
fn apply_records(input: &Path, target: &Path, permit: &str) -> Result<Value> {
    if permit.len() != 64 || !permit.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid staging permit".into());
    }
    let suffix = target
        .file_name()
        .and_then(|s| s.to_str())
        .and_then(|s| s.rsplit_once(".importing."))
        .map(|(_, s)| s);
    if !suffix.is_some_and(|s| {
        s.len() == 36
            && s.bytes().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    c == b'-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
    }) {
        return Err("native writes require an isolated importing database".into());
    }
    let source = Connection::open_with_flags(input, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let db = Connection::open_with_flags(target, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.execute_batch("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE")?;
    let operation = (|| -> Result<Value> {
        let expected: String = db.query_row(
            "SELECT value FROM import_manifest WHERE key='rai.native_import_permit'",
            [],
            |r| r.get(0),
        )?;
        if expected != permit {
            return Err("invalid staging permit".into());
        }
        let (generation, batch, incremental): (String, Option<String>, bool) = source.query_row(
            "SELECT generation, batch_id, incremental FROM apply_config",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let mut tombstone = db.prepare(
            "SELECT 1 FROM import_entity_tombstones WHERE entity_kind='record' AND entity_id=?",
        )?;
        let mut existing = db.prepare("SELECT 1 FROM health_records WHERE id=?")?;
        let mut old_hash = db.prepare("SELECT content_hash FROM import_entity_generations WHERE entity_kind='record' AND entity_id=?")?;
        let mut generation_write = db.prepare("INSERT INTO import_entity_generations (entity_kind,entity_id,generation,content_hash,effective_at)
            VALUES ('record',?,?,?,?) ON CONFLICT(entity_kind,entity_id) DO UPDATE SET generation=excluded.generation,
            content_hash=excluded.content_hash,effective_at=excluded.effective_at")?;
        let mut change = db.prepare("INSERT OR REPLACE INTO import_entity_changes
            (batch_id,entity_kind,entity_id,change_type,effective_at,content_hash) VALUES (?,'record',?,?,?,?)")?;
        let mut insert = db.prepare("INSERT INTO health_records (id,type,source_name,source_category,source_version,device,unit,
            value_numeric,value_text,start_at,end_at,created_at,metadata_json,raw_attributes_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET type=excluded.type,source_name=excluded.source_name,source_category=excluded.source_category,
            source_version=excluded.source_version,device=excluded.device,unit=excluded.unit,value_numeric=excluded.value_numeric,
            value_text=excluded.value_text,start_at=excluded.start_at,end_at=excluded.end_at,created_at=excluded.created_at,
            metadata_json=excluded.metadata_json,raw_attributes_json=excluded.raw_attributes_json")?;
        let mut query = source.prepare("SELECT id,type,source_name,source_category,source_version,device,unit,value_numeric,value_text,
            start_at,end_at,created_at,metadata_json,raw_attributes_json,content_hash FROM canonical_records ORDER BY sequence")?;
        let mut rows = query.query([])?;
        let mut inserted = 0u64;
        let mut tombstoned = 0u64;
        let mut observed = 0u64;
        let mut since_commit = 0u32;
        // B1 (runtime invariant): digest of the inputs exactly as this loop READS
        // them, updated before any tombstone/upsert decision. The TS side
        // (`NativeRecordWriter.capture()`) folds the same sequence over every row it
        // wrote into `canonical_records`; a mismatch means this process did not
        // consume the canonical rows the parent produced (skipped/duplicated/reordered).
        let mut digest = Sha256::new();
        while let Some(row) = rows.next()? {
            observed += 1;
            let id: String = row.get(0)?;
            let hash: String = row.get(14)?;
            digest.update(format!("{}|{}|{}\n", observed, id, hash).as_bytes());
            if tombstone.exists([&id])? {
                tombstoned += 1;
                continue;
            }
            let exists = existing.exists([&id])?;
            use rusqlite::OptionalExtension;
            let previous: Option<String> = old_hash.query_row([&id], |r| r.get(0)).optional()?;
            let at: String = row.get(9)?;
            let updated = exists
                && previous
                    .as_ref()
                    .is_some_and(|v| v != "__seed_unknown__" && v != &hash);
            generation_write.execute(params![id, generation, hash, at])?;
            if let Some(batch) = &batch {
                if !exists || updated {
                    change.execute(params![
                        batch,
                        id,
                        if exists { "updated" } else { "inserted" },
                        at,
                        hash
                    ])?;
                }
            }
            if !incremental || !exists || updated {
                let values: Vec<rusqlite::types::Value> = (0..14)
                    .map(|i| row.get(i))
                    .collect::<rusqlite::Result<_>>()?;
                insert.execute(rusqlite::params_from_iter(values))?;
                if !incremental || !exists {
                    inserted += 1;
                }
            }
            since_commit += 1;
            if since_commit >= 4096 {
                // Bounded WAL on large imports. This is a disposable candidate;
                // the parent discards it on any failure, never publishes a batch.
                db.execute_batch("COMMIT; BEGIN IMMEDIATE")?;
                since_commit = 0;
            }
        }
        db.execute(
            "DELETE FROM import_manifest WHERE key='rai.native_import_permit'",
            [],
        )?;
        Ok(
            json!({"rows":0,"insertedRecords":inserted,"tombstonedRecords":tombstoned,
                "observedRecords":observed,"canonicalDigest":format!("{:x}", digest.finalize())}),
        )
    })();
    match operation {
        Ok(value) => {
            db.execute_batch("COMMIT")?;
            Ok(value)
        }
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn peak_rss_kib() -> u64 {
    #[cfg(unix)]
    unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_SELF, &mut usage) == 0 {
            let value = usage.ru_maxrss.max(0) as u64;
            return if cfg!(target_os = "macos") {
                value / 1024
            } else {
                value
            };
        }
    }
    0
}

fn run() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args == ["--version"] {
        println!(
            "{}",
            json!({"protocol":1,"engine":"rust","version":env!("CARGO_PKG_VERSION")})
        );
        return Ok(());
    }
    if (args.len() != 6 && args.len() != 10)
        || args[0] != "--operation"
        || args[2] != "--input"
        || args[4] != "--output"
    {
        return Err(
            "usage: --operation health|gpx|aggregate --input FILE --output NEW_SQLITE".into(),
        );
    }
    if !["health", "gpx", "aggregate", "apply-records"].contains(&args[1].as_str()) {
        return Err("invalid operation".into());
    }
    if (args[1] == "apply-records") != (args.len() == 10)
        || (args.len() == 10 && (args[6] != "--staging-database" || args[8] != "--permit"))
    {
        return Err("invalid staging arguments".into());
    }
    let input = PathBuf::from(&args[3]);
    let output = PathBuf::from(&args[5]);
    // Never open an existing DB for writing, even when a caller supplies the wrong path.
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    drop(options.open(&output)?);
    let started = Instant::now();
    let result = (|| -> Result<Value> {
        let db = Connection::open(&output)?;
        // Disposable staging spool ONLY, never a business database.
        db.execute_batch("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-8192;
            CREATE TABLE xml_units (sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE gpx_points (sequence INTEGER PRIMARY KEY, timestamp TEXT, latitude REAL, longitude REAL,
                elevationMeters REAL, speedMetersPerSecond REAL, courseDegrees REAL,
                horizontalAccuracyMeters REAL, verticalAccuracyMeters REAL, reserved INTEGER);
            CREATE TABLE route_aggregates (workout_id TEXT PRIMARY KEY, elevation_gain REAL);
            CREATE TABLE worker_metadata (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
            BEGIN")?;
        let mut data = if args[1] == "aggregate" {
            aggregate(&input, &db)?
        } else if args[1] == "apply-records" {
            apply_records(&input, Path::new(&args[7]), &args[9])?
        } else {
            parse_xml(&input, &db, args[1] == "gpx")?
        };
        data["protocol"] = json!(1);
        data["engine"] = json!("rust");
        data["version"] = json!(env!("CARGO_PKG_VERSION"));
        data["operation"] = json!(args[1]);
        data["durationMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
        data["peakRssKiB"] = json!(peak_rss_kib());
        db.execute(
            "INSERT INTO worker_metadata VALUES (1,?)",
            [serde_json::to_string(&data)?],
        )?;
        db.execute_batch("COMMIT")?;
        Ok(data)
    })();
    match result {
        Ok(data) => println!("{data}"),
        Err(error) => {
            let _ = fs::remove_file(output);
            return Err(error);
        }
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        let message = error.to_string();
        let xml_error = error.downcast_ref::<quick_xml::Error>();
        let code = if message.contains("resource_limit") {
            "resource_limit"
        } else if message.contains("unsupported_xml")
            || matches!(xml_error, Some(quick_xml::Error::Encoding(_)))
        {
            "unsupported_xml"
        } else if message.contains("invalid_xml")
            || matches!(xml_error, Some(e) if !matches!(e, quick_xml::Error::Io(_)))
        {
            "invalid_xml"
        } else {
            "native_failure"
        };
        // Detailed paths/records never cross the protocol boundary.
        eprintln!("{}", json!({"protocol":1,"code":code}));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numeric_and_time_contract() {
        assert_eq!(number(Some(" 1.2e2 ")).unwrap(), Some(120.0));
        assert_eq!(number(Some("NaN")).unwrap(), None);
        assert_eq!(number(Some("")).unwrap(), None);
        assert!(number(Some("0xff")).is_err());
        assert_eq!(number(Some("\u{85}1")).unwrap(), None);
        assert_eq!(
            timestamp(Some("2026-01-01T08:00:00.123456+08:00"))
                .unwrap()
                .unwrap(),
            "2026-01-01T00:00:00.123Z"
        );
        assert!(timestamp(Some("2026-01-01 08:00:00")).is_err());
        assert!(timestamp(Some("2016-12-31T23:59:60Z")).is_err());
    }
    #[test]
    fn attribute_newlines_are_normalized_before_entities() {
        assert_eq!(xml_text("a\r\nb&#xA;c\t&amp;", true).unwrap(), "a b\nc &");
        assert!(xml_text("&#0;", false).is_err());
    }
}
