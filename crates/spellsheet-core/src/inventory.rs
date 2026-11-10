//! 業務の棚卸し (a stock-take of a person's work): what their work is, how
//! long it takes, and which of it is worth automating first.
//!
//! ```text
//! <workspace>/inventory/<id>.json
//! ```
//!
//! An AI client fills it in while it interviews the person (MCP
//! `save_work_inventory`); Writer shows it as a sheet the person reads and
//! corrects. The AI records what it heard; the numbers and the order come
//! from [`assess`], with fixed formulas, so the order does not depend on
//! which AI asked or how it felt that day.

use std::fs;
use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

use crate::error::{CoreError, CoreResult};
use crate::ids::InventoryId;
use crate::store::{Actor, write_atomic};

/// Folder of the stock-takes, in the workspace (shared, like flows).
pub const FOLDER: &str = "inventory";

/// Most tasks one stock-take holds (an interview lists 5 to 15).
pub const MAX_TASKS: usize = 100;

/// Saved time per month (minutes) from which a task counts as worth a flow
/// of its own: 5 hours.
pub const WORTH_MINUTES: f64 = 300.0;

/// Working days in a month, for work done every day.
const DAYS_PER_MONTH: f64 = 20.0;

/// One stock-take: one person's (or one team's) work.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkInventory {
    pub id: InventoryId,
    /// What is taken stock of, e.g. 「経理課 月次の締め」.
    pub title: String,
    /// Whose work: department and role, e.g. 「経理課 2 名、請求と支払」.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    /// Systems and tools used every day (受注システム（Web）, 販売管理（Windows）, Excel, Outlook…).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub systems: Vec<String>,
    #[serde(default)]
    pub status: InventoryStatus,
    /// Anything else worth keeping from the interview.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default)]
    pub tasks: Vec<WorkTask>,
    /// Who made it (the AI client, or Writer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<Actor>,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum InventoryStatus {
    /// Still being asked about.
    #[default]
    Interviewing,
    /// The person confirmed the list and the numbers.
    Done,
}

/// One piece of work.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkTask {
    /// `t1`, `t2`… given when the task is added; stays the same.
    pub id: String,
    /// The work in the person's words, e.g. 「受注メールの Excel を販売管理に入力」.
    pub name: String,
    /// What is done, one or two sentences.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The order of the work, in business words.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frequency: Option<Frequency>,
    /// Minutes one time takes one person.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minutes: Option<f64>,
    /// How many people do it (default 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub people: Option<u32>,
    /// Share of that time (percent, 0 to 100) that is hands-only work a flow
    /// can take over: copying, typing, downloading, checking against a list.
    /// Judging, phoning and talking stay with people.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_share: Option<u32>,
    /// How easy it is to build with SpellSheet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ease: Option<Level>,
    /// Why it is that easy or hard (input is data or paper, fixed steps,
    /// exceptions, kind of screen).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ease_reasons: Vec<String>,
    /// What a mistake costs: high (money, customers, deadlines), medium, low.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_impact: Option<Level>,
    /// Systems and apps it uses.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub systems: Vec<String>,
    /// What it reads: files, mails, forms, paper.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<String>,
    /// What it makes or updates.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outputs: Vec<String>,
    /// The cases that do not follow the usual steps, and how often.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exceptions: Option<String>,
    /// SpellSheet node types a flow for it would use (from list_step_types).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub step_types: Vec<String>,
    /// Plugins it needs, if any.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plugins: Vec<String>,
    /// Why it does not suit automation now (judgment at its core, once a
    /// year, a system about to be replaced). Set: the task is not ranked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_now: Option<String>,
    /// Flows made for it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub flow_ids: Vec<String>,
    /// Anything else, e.g. which numbers are estimates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// How often: `times` per `per`, e.g. 3 per week.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Frequency {
    pub times: f64,
    pub per: Period,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Period {
    Day,
    Week,
    Month,
    Quarter,
    Year,
}

impl Period {
    /// How many of these make a month (a day: the working days).
    pub fn per_month(self) -> f64 {
        match self {
            Self::Day => DAYS_PER_MONTH,
            Self::Week => 52.0 / 12.0,
            Self::Month => 1.0,
            Self::Quarter => 1.0 / 3.0,
            Self::Year => 1.0 / 12.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    High,
    Medium,
    Low,
}

// -- changes ------------------------------------------------------------------

/// A change to a stock-take: given fields replace what is there, the rest
/// stays. Without `id` a new stock-take is made.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InventoryPatch {
    /// The stock-take to change. Omit to start a new one (`title` needed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<InventoryId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub systems: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<InventoryStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// Tasks to add (no `id`) or change (`id` of an existing one: only the
    /// fields given change; `null` clears one).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tasks: Vec<TaskPatch>,
    /// IDs of tasks to take out.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove_tasks: Vec<String>,
}

/// A task to add or change. Fields as in [`WorkTask`]; `null` clears one.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    /// An existing task's ID (`t3`). Omit to add a task (`name` needed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The fields to set, as in a task: name, description, steps,
    /// frequency { times, per: day | week | month | quarter | year },
    /// minutes, people, manualShare (0-100), ease (high | medium | low),
    /// easeReasons, errorImpact (high | medium | low), systems, inputs,
    /// outputs, exceptions, stepTypes, plugins, notNow, flowIds, note.
    #[serde(flatten)]
    #[schemars(with = "TaskFields")]
    pub fields: serde_json::Map<String, Value>,
}

/// The settable fields of a task, for the schema of [`TaskPatch`].
#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct TaskFields {
    name: Option<String>,
    description: Option<String>,
    steps: Option<Vec<String>>,
    frequency: Option<Frequency>,
    minutes: Option<f64>,
    people: Option<u32>,
    manual_share: Option<u32>,
    ease: Option<Level>,
    ease_reasons: Option<Vec<String>>,
    error_impact: Option<Level>,
    systems: Option<Vec<String>>,
    inputs: Option<Vec<String>>,
    outputs: Option<Vec<String>>,
    exceptions: Option<String>,
    step_types: Option<Vec<String>>,
    plugins: Option<Vec<String>>,
    not_now: Option<String>,
    flow_ids: Option<Vec<String>>,
    note: Option<String>,
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::InvalidEdit(message.into())
}

impl WorkInventory {
    pub fn new(title: impl Into<String>, created_by: Option<Actor>) -> Self {
        let now = OffsetDateTime::now_utc();
        Self {
            id: InventoryId::generate(),
            title: title.into(),
            about: None,
            systems: Vec::new(),
            status: InventoryStatus::default(),
            notes: None,
            tasks: Vec::new(),
            created_by,
            created_at: now,
            updated_at: now,
        }
    }

    /// Applies a change in memory. Nothing changes when it fails.
    pub fn apply(&mut self, patch: &InventoryPatch) -> CoreResult<()> {
        let mut next = self.clone();
        if let Some(title) = &patch.title {
            if title.trim().is_empty() {
                return Err(invalid("title cannot be empty"));
            }
            next.title = title.trim().to_owned();
        }
        if let Some(about) = &patch.about {
            next.about = non_empty(about);
        }
        if let Some(systems) = &patch.systems {
            next.systems = clean_list(systems);
        }
        if let Some(status) = patch.status {
            next.status = status;
        }
        if let Some(notes) = &patch.notes {
            next.notes = non_empty(notes);
        }
        for id in &patch.remove_tasks {
            let before = next.tasks.len();
            next.tasks.retain(|t| &t.id != id);
            if next.tasks.len() == before {
                return Err(invalid(format!("no task {id} in this inventory")));
            }
        }
        for change in &patch.tasks {
            next.apply_task(change)?;
        }
        next.updated_at = OffsetDateTime::now_utc();
        *self = next;
        Ok(())
    }

    fn apply_task(&mut self, change: &TaskPatch) -> CoreResult<()> {
        if change.fields.contains_key("id") {
            return Err(invalid("a task's id is given by SpellSheet"));
        }
        let (index, mut value) = match &change.id {
            Some(id) => {
                let index = self.tasks.iter().position(|t| &t.id == id).ok_or_else(|| {
                    invalid(format!(
                        "no task {id} in this inventory; omit id to add one"
                    ))
                })?;
                (Some(index), serde_json::to_value(&self.tasks[index])?)
            }
            None => {
                if self.tasks.len() >= MAX_TASKS {
                    return Err(invalid(format!(
                        "an inventory holds at most {MAX_TASKS} tasks"
                    )));
                }
                (
                    None,
                    serde_json::json!({ "id": self.next_task_id(), "name": "" }),
                )
            }
        };
        if let Value::Object(map) = &mut value {
            for (key, field) in &change.fields {
                if field.is_null() {
                    map.remove(key);
                } else {
                    map.insert(key.clone(), field.clone());
                }
            }
        }
        let mut task: WorkTask = serde_json::from_value(value).map_err(|e| {
            invalid(format!(
                "task {}: {e}",
                change.id.as_deref().unwrap_or("(new)")
            ))
        })?;
        task.check()?;
        task.tidy();
        match index {
            Some(i) => self.tasks[i] = task,
            None => self.tasks.push(task),
        }
        Ok(())
    }

    fn next_task_id(&self) -> String {
        let highest = self
            .tasks
            .iter()
            .filter_map(|t| t.id.strip_prefix('t')?.parse::<u32>().ok())
            .max()
            .unwrap_or(0);
        format!("t{}", highest + 1)
    }

    pub fn summary(&self) -> InventorySummary {
        let assessment = assess(self);
        InventorySummary {
            id: self.id.clone(),
            title: self.title.clone(),
            about: self.about.clone(),
            status: self.status,
            tasks: self.tasks.len(),
            savable_minutes: assessment.savable_minutes,
            updated_at: self.updated_at,
        }
    }
}

impl WorkTask {
    fn check(&self) -> CoreResult<()> {
        let name = if self.name.trim().is_empty() {
            return Err(invalid("a task needs a name"));
        } else {
            &self.name
        };
        if let Some(f) = self.frequency
            && !(f.times.is_finite() && f.times > 0.0)
        {
            return Err(invalid(format!(
                "{name}: frequency.times must be more than 0"
            )));
        }
        if let Some(m) = self.minutes
            && !(m.is_finite() && m >= 0.0)
        {
            return Err(invalid(format!("{name}: minutes cannot be negative")));
        }
        if self.people == Some(0) {
            return Err(invalid(format!("{name}: people is at least 1")));
        }
        if self.manual_share.is_some_and(|s| s > 100) {
            return Err(invalid(format!(
                "{name}: manualShare is a percent, 0 to 100"
            )));
        }
        Ok(())
    }

    fn tidy(&mut self) {
        self.name = self.name.trim().to_owned();
        for list in [
            &mut self.steps,
            &mut self.ease_reasons,
            &mut self.systems,
            &mut self.inputs,
            &mut self.outputs,
            &mut self.step_types,
            &mut self.plugins,
            &mut self.flow_ids,
        ] {
            *list = clean_list(list);
        }
        for text in [
            &mut self.description,
            &mut self.exceptions,
            &mut self.not_now,
            &mut self.note,
        ] {
            *text = text.as_deref().and_then(non_empty);
        }
    }
}

fn non_empty(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn clean_list(items: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let item = item.trim();
        if !item.is_empty() && !out.iter().any(|o| o == item) {
            out.push(item.to_owned());
        }
    }
    out
}

// -- assessment ---------------------------------------------------------------

/// Where a task stands, by the time it could save and how easy it is.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum Group {
    /// Easy, and saves 5 hours a month or more: build these first.
    First,
    /// Easy, saves less: build once used to it.
    Later,
    /// Saves a lot but hard: split it and start with a part.
    Split,
    /// Not enough is known yet to place it.
    Unknown,
    /// Does not suit automation now (its `notNow`, or little to save and hard).
    NotNow,
}

/// The numbers of one task, from fixed formulas.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskAssessment {
    pub task_id: String,
    /// Times a month.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub times_per_month: Option<f64>,
    /// Minutes a month it takes everyone: times × minutes × people.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monthly_minutes: Option<f64>,
    /// Minutes a month a flow could save: monthlyMinutes × manualShare.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub savable_minutes: Option<f64>,
    pub group: Group,
    /// 1 = the first to build. Only ranked groups (first, later, split).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rank: Option<u32>,
    /// For ordering: saved hours, weighted by ease and by what a mistake costs.
    pub priority: f64,
    /// What is still to ask before it can be placed or trusted.
    pub missing: Vec<String>,
}

/// The whole stock-take in numbers, tasks in the order to build them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Assessment {
    pub tasks: Vec<TaskAssessment>,
    /// Minutes a month of the tasks whose time is known.
    pub monthly_minutes: f64,
    /// Minutes a month the ranked tasks could save.
    pub savable_minutes: f64,
    /// The task to build first, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first: Option<String>,
    /// Tasks that still miss something to be placed.
    pub incomplete: usize,
}

/// Scores every task and puts them in the order to build them.
pub fn assess(inventory: &WorkInventory) -> Assessment {
    let mut tasks: Vec<TaskAssessment> = inventory.tasks.iter().map(assess_task).collect();
    tasks.sort_by(|a, b| {
        a.group
            .cmp(&b.group)
            .then(b.priority.total_cmp(&a.priority))
            .then(
                b.monthly_minutes
                    .unwrap_or(0.0)
                    .total_cmp(&a.monthly_minutes.unwrap_or(0.0)),
            )
    });
    let mut rank = 0;
    for task in &mut tasks {
        if matches!(task.group, Group::First | Group::Later | Group::Split) {
            rank += 1;
            task.rank = Some(rank);
        }
    }
    let monthly_minutes = tasks.iter().filter_map(|t| t.monthly_minutes).sum::<f64>();
    let savable_minutes = tasks
        .iter()
        .filter(|t| t.rank.is_some())
        .filter_map(|t| t.savable_minutes)
        .sum::<f64>();
    let first = tasks
        .iter()
        .find(|t| t.group == Group::First)
        .map(|t| t.task_id.clone());
    let incomplete = tasks.iter().filter(|t| !t.missing.is_empty()).count();
    Assessment {
        tasks,
        monthly_minutes: round1(monthly_minutes),
        savable_minutes: round1(savable_minutes),
        first,
        incomplete,
    }
}

fn assess_task(task: &WorkTask) -> TaskAssessment {
    let mut missing = Vec::new();
    if task.frequency.is_none() {
        missing.push("frequency".to_owned());
    }
    if task.minutes.is_none() {
        missing.push("minutes".to_owned());
    }
    if task.manual_share.is_none() {
        missing.push("manualShare".to_owned());
    }
    if task.ease.is_none() {
        missing.push("ease".to_owned());
    }
    let times = task.frequency.map(|f| f.times * f.per.per_month());
    let people = f64::from(task.people.unwrap_or(1));
    let monthly = match (times, task.minutes) {
        (Some(times), Some(minutes)) => Some(times * minutes * people),
        _ => None,
    };
    let savable = match (monthly, task.manual_share) {
        (Some(m), Some(share)) => Some(m * f64::from(share) / 100.0),
        _ => None,
    };
    let ease_weight = match task.ease {
        Some(Level::High) => 1.0,
        Some(Level::Medium) => 0.6,
        Some(Level::Low) => 0.3,
        None => 0.0,
    };
    let impact = match task.error_impact {
        Some(Level::High) => 1.5,
        Some(Level::Medium) => 1.2,
        _ => 1.0,
    };
    let priority = savable.map_or(0.0, |s| s / 60.0 * ease_weight * impact);
    let group = if task.not_now.is_some() {
        Group::NotNow
    } else {
        match (savable, task.ease) {
            (Some(saved), Some(ease)) => {
                let easy = ease != Level::Low;
                let worth = saved >= WORTH_MINUTES;
                match (easy, worth) {
                    (true, true) => Group::First,
                    (true, false) => Group::Later,
                    (false, true) => Group::Split,
                    (false, false) => Group::NotNow,
                }
            }
            _ => Group::Unknown,
        }
    };
    TaskAssessment {
        task_id: task.id.clone(),
        times_per_month: times.map(round1),
        monthly_minutes: monthly.map(round1),
        savable_minutes: savable.map(round1),
        group,
        rank: None,
        priority: round1(priority),
        missing,
    }
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

// -- storage ------------------------------------------------------------------

/// A line for lists of stock-takes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InventorySummary {
    pub id: InventoryId,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    pub status: InventoryStatus,
    pub tasks: usize,
    pub savable_minutes: f64,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub updated_at: OffsetDateTime,
}

fn not_found(id: &InventoryId) -> CoreError {
    CoreError::Rejected {
        code: "INVENTORY_NOT_FOUND",
        message: format!("no inventory {id} in this workspace"),
        hint: Some("get_work_inventory without id lists the inventories".into()),
    }
}

fn folder(workspace: &Path) -> PathBuf {
    workspace.join(FOLDER)
}

fn path_of(workspace: &Path, id: &InventoryId) -> CoreResult<PathBuf> {
    if !id.is_well_formed() {
        return Err(invalid(format!("invalid inventory id: {id}")));
    }
    Ok(folder(workspace).join(format!("{id}.json")))
}

/// Every stock-take of the workspace, the latest changed first.
pub fn list(workspace: &Path) -> CoreResult<Vec<InventorySummary>> {
    let dir = folder(workspace);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match fs::read(&path)
            .map_err(CoreError::from)
            .and_then(|b| Ok(serde_json::from_slice::<WorkInventory>(&b)?))
        {
            Ok(inventory) => out.push(inventory.summary()),
            Err(e) => {
                tracing::warn!(error = %e, file = %path.display(), "cannot read a stock-take")
            }
        }
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.updated_at));
    Ok(out)
}

pub fn load(workspace: &Path, id: &InventoryId) -> CoreResult<WorkInventory> {
    let path = path_of(workspace, id)?;
    match fs::read(&path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(not_found(id)),
        Err(e) => Err(e.into()),
    }
}

pub fn save(workspace: &Path, inventory: &WorkInventory) -> CoreResult<()> {
    let path = path_of(workspace, &inventory.id)?;
    fs::create_dir_all(folder(workspace))?;
    let mut json = serde_json::to_vec_pretty(inventory)?;
    json.push(b'\n');
    write_atomic(&path, &json)
}

/// Holds the stock-takes' folder for one read-modify-write, across
/// processes (Writer and an AI client can save the same one at once);
/// released on drop.
struct FolderLock(fs::File);

impl Drop for FolderLock {
    fn drop(&mut self) {
        // The OS releases the lock when the handle closes anyway.
        let _ = self.0.unlock();
    }
}

fn lock_folder(workspace: &Path) -> CoreResult<FolderLock> {
    fs::create_dir_all(folder(workspace))?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(folder(workspace).join(".lock"))?;
    file.lock()?;
    Ok(FolderLock(file))
}

/// Applies a change and saves it: to the stock-take `patch.id`, or to a
/// new one when it has none. Concurrent changes to the same one are
/// applied one after the other, so neither is lost.
pub fn change(workspace: &Path, patch: &InventoryPatch, actor: Actor) -> CoreResult<WorkInventory> {
    let _lock = lock_folder(workspace)?;
    let mut inventory = match &patch.id {
        Some(id) => load(workspace, id)?,
        None => {
            let title = patch.title.as_deref().and_then(non_empty).ok_or_else(|| {
                invalid("a new inventory needs a title, e.g. 「経理課 月次の締め」")
            })?;
            WorkInventory::new(title, Some(actor))
        }
    };
    inventory.apply(patch)?;
    save(workspace, &inventory)?;
    Ok(inventory)
}

/// Removes a stock-take (its flows stay).
pub fn delete(workspace: &Path, id: &InventoryId) -> CoreResult<()> {
    let path = path_of(workspace, id)?;
    let _lock = lock_folder(workspace)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(not_found(id)),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::store::ActorKind;
    use serde_json::json;

    fn task(fields: Value) -> TaskPatch {
        serde_json::from_value(fields).unwrap()
    }

    fn sample() -> WorkInventory {
        let mut inv = WorkInventory::new("経理課", None);
        inv.apply(&InventoryPatch {
            tasks: vec![
                // 20 × 30 × 2 = 1200 min/month, 80% → 960: easy and big.
                task(json!({ "name": "受注入力", "frequency": { "times": 1, "per": "day" }, "minutes": 30, "people": 2, "manualShare": 80, "ease": "high" })),
                // 4.33 × 20 = 86.7 min, 50% → 43.3: easy, small.
                task(json!({ "name": "週報", "frequency": { "times": 1, "per": "week" }, "minutes": 20, "manualShare": 50, "ease": "medium" })),
                // 1 × 600 = 600, 100% → 600: big but hard.
                task(json!({ "name": "紙の請求書", "frequency": { "times": 1, "per": "month" }, "minutes": 600, "manualShare": 100, "ease": "low" })),
                task(json!({ "name": "予算会議", "frequency": { "times": 1, "per": "year" }, "minutes": 600, "manualShare": 10, "ease": "low", "notNow": "判断が中心" })),
                task(json!({ "name": "電話対応" })),
            ],
            ..Default::default()
        })
        .unwrap();
        inv
    }

    #[test]
    fn tasks_get_ids_in_order() {
        let inv = sample();
        let ids: Vec<&str> = inv.tasks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["t1", "t2", "t3", "t4", "t5"]);
    }

    #[test]
    fn assess_orders_by_group_then_priority() {
        let a = assess(&sample());
        let order: Vec<(&str, Group, Option<u32>)> = a
            .tasks
            .iter()
            .map(|t| (t.task_id.as_str(), t.group, t.rank))
            .collect();
        assert_eq!(
            order,
            [
                ("t1", Group::First, Some(1)),
                ("t2", Group::Later, Some(2)),
                ("t3", Group::Split, Some(3)),
                ("t5", Group::Unknown, None),
                ("t4", Group::NotNow, None),
            ]
        );
        assert_eq!(a.first.as_deref(), Some("t1"));
        assert_eq!(a.tasks[0].monthly_minutes, Some(1200.0));
        assert_eq!(a.tasks[0].savable_minutes, Some(960.0));
        assert_eq!(a.tasks[1].savable_minutes, Some(43.3));
        assert_eq!(a.savable_minutes, 960.0 + 43.3 + 600.0);
        assert_eq!(a.incomplete, 1);
        assert_eq!(
            a.tasks[3].missing,
            ["frequency", "minutes", "manualShare", "ease"]
        );
    }

    #[test]
    fn a_mistake_that_costs_more_ranks_higher() {
        let mut inv = WorkInventory::new("x", None);
        inv.apply(&InventoryPatch {
            tasks: vec![
                task(json!({ "name": "a", "frequency": { "times": 1, "per": "day" }, "minutes": 30, "manualShare": 100, "ease": "high" })),
                task(json!({ "name": "b", "frequency": { "times": 1, "per": "day" }, "minutes": 30, "manualShare": 100, "ease": "high", "errorImpact": "high" })),
            ],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(assess(&inv).first.as_deref(), Some("t2"));
    }

    #[test]
    fn changes_merge_and_null_clears() {
        let mut inv = sample();
        inv.apply(&InventoryPatch {
            tasks: vec![task(json!({ "id": "t1", "minutes": 15, "note": "見積り" }))],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(inv.tasks[0].minutes, Some(15.0));
        assert_eq!(inv.tasks[0].people, Some(2));
        inv.apply(&InventoryPatch {
            tasks: vec![task(json!({ "id": "t1", "note": null }))],
            remove_tasks: vec!["t5".into()],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(inv.tasks[0].note, None);
        assert_eq!(inv.tasks.len(), 4);
        // A new task after a removal does not reuse an ID in use.
        inv.apply(&InventoryPatch {
            tasks: vec![task(json!({ "name": "新しい" }))],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(inv.tasks.last().unwrap().id, "t5");
    }

    #[test]
    fn bad_changes_change_nothing() {
        let mut inv = sample();
        let before = inv.clone();
        for bad in [
            json!({ "id": "t1", "manualShare": 120 }),
            json!({ "id": "t1", "people": 0 }),
            json!({ "id": "t1", "minutes": -5 }),
            json!({ "id": "t1", "frequency": { "times": 0, "per": "day" } }),
            json!({ "id": "t1", "ease": "easy" }),
            json!({ "id": "t9", "minutes": 5 }),
            json!({ "minutes": 5 }),
        ] {
            let patch = InventoryPatch {
                title: Some("変えない".into()),
                tasks: vec![task(bad.clone())],
                ..Default::default()
            };
            assert!(inv.apply(&patch).is_err(), "{bad}");
            assert_eq!(inv, before);
        }
    }

    #[test]
    fn saves_lists_and_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let actor = Actor::named(ActorKind::Mcp, "claude-code");
        assert!(list(dir.path()).unwrap().is_empty());
        assert!(change(dir.path(), &InventoryPatch::default(), actor.clone()).is_err());
        let made = change(
            dir.path(),
            &InventoryPatch {
                title: Some("経理課".into()),
                tasks: vec![task(json!({ "name": "受注入力" }))],
                ..Default::default()
            },
            actor.clone(),
        )
        .unwrap();
        let again = change(
            dir.path(),
            &InventoryPatch {
                id: Some(made.id.clone()),
                status: Some(InventoryStatus::Done),
                ..Default::default()
            },
            actor,
        )
        .unwrap();
        assert_eq!(again.tasks.len(), 1);
        assert_eq!(
            load(dir.path(), &made.id).unwrap().status,
            InventoryStatus::Done
        );
        let listed = list(dir.path()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "経理課");
        delete(dir.path(), &made.id).unwrap();
        assert!(list(dir.path()).unwrap().is_empty());
        assert!(load(dir.path(), &InventoryId::new("../x")).is_err());
    }

    #[test]
    fn changes_at_the_same_time_are_all_kept() {
        let dir = tempfile::tempdir().unwrap();
        let actor = Actor::named(ActorKind::Mcp, "claude-code");
        let made = change(
            dir.path(),
            &InventoryPatch {
                title: Some("経理課".into()),
                ..Default::default()
            },
            actor.clone(),
        )
        .unwrap();
        std::thread::scope(|s| {
            for n in 0..8 {
                let (root, id, actor) = (dir.path(), made.id.clone(), actor.clone());
                s.spawn(move || {
                    let patch = InventoryPatch {
                        id: Some(id),
                        tasks: vec![task(json!({ "name": format!("仕事 {n}") }))],
                        ..Default::default()
                    };
                    change(root, &patch, actor).unwrap();
                });
            }
        });
        assert_eq!(load(dir.path(), &made.id).unwrap().tasks.len(), 8);
        assert_eq!(list(dir.path()).unwrap().len(), 1);
    }
}
