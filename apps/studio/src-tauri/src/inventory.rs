//! 業務の棚卸し in Writer: the stock-takes an AI made with the person, read
//! as a sheet, corrected by hand, and written out for Excel. The data and its
//! formulas are in spellsheet_core::inventory, shared with the MCP server.

use serde::Serialize;
use spellsheet_core::inventory::{
    self, Assessment, InventoryPatch, InventorySummary, WorkInventory,
};
use spellsheet_core::{ErrorPayload, FlowId, InventoryId};
use tauri::State;

use crate::AppState;

type CmdResult<T> = Result<T, ErrorPayload>;

/// One stock-take and its numbers, as the sheet shows them.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryView {
    pub inventory: WorkInventory,
    pub assessment: Assessment,
}

fn view(inventory: WorkInventory) -> InventoryView {
    let assessment = inventory::assess(&inventory);
    InventoryView {
        inventory,
        assessment,
    }
}

#[tauri::command]
pub fn list_inventories(state: State<'_, AppState>) -> CmdResult<Vec<InventorySummary>> {
    Ok(inventory::list(state.service.store().root())?)
}

#[tauri::command]
pub fn get_inventory(state: State<'_, AppState>, id: InventoryId) -> CmdResult<InventoryView> {
    Ok(view(inventory::load(state.service.store().root(), &id)?))
}

/// A correction the person made on the sheet (a number, the ease, a flow).
#[tauri::command]
pub fn change_inventory(
    state: State<'_, AppState>,
    patch: InventoryPatch,
) -> CmdResult<InventoryView> {
    let saved = inventory::change(
        state.service.store().root(),
        &patch,
        spellsheet_core::Actor::new(spellsheet_core::ActorKind::Studio),
    )?;
    Ok(view(saved))
}

/// The interview to paste into an AI chat that cannot reach SpellSheet.
#[tauri::command]
pub fn inventory_chat_guide() -> &'static str {
    inventory::CHAT_GUIDE
}

/// Takes in the stock-take such an AI chat wrote: as a new one, or into `id`
/// (its tasks matched by name). Made by the chat, as save_work_inventory is.
#[tauri::command]
pub fn paste_inventory_answer(
    state: State<'_, AppState>,
    text: String,
    id: Option<InventoryId>,
) -> CmdResult<InventoryView> {
    let root = state.service.store().root();
    let existing = id.map(|id| inventory::load(root, &id)).transpose()?;
    let patch = inventory::answer_patch(&text, existing.as_ref())?;
    let saved = inventory::change(
        root,
        &patch,
        spellsheet_core::Actor::new(spellsheet_core::ActorKind::Chat),
    )?;
    Ok(view(saved))
}

#[tauri::command]
pub fn delete_inventory(state: State<'_, AppState>, id: InventoryId) -> CmdResult<()> {
    Ok(inventory::delete(state.service.store().root(), &id)?)
}

/// Writes the sheet as an Excel workbook to the Downloads folder and
/// returns its path.
#[tauri::command]
pub fn export_inventory(
    state: State<'_, AppState>,
    id: InventoryId,
    english: bool,
) -> CmdResult<String> {
    let found = inventory::load(state.service.store().root(), &id)?;
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| err("STORAGE_ERROR", "no Downloads folder"))?;
    let path = free_path(
        &dir,
        &found.title,
        if english {
            "automation"
        } else {
            "業務の棚卸し"
        },
    );
    let names = |flow: &str| state.service.get(&FlowId::new(flow)).ok().map(|f| f.name);
    spellsheet_excel::inventory::write(&path, &found, english, &names)
        .map_err(|e| err("STORAGE_ERROR", e))?;
    Ok(path.display().to_string())
}

fn err(code: &str, message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        code: code.to_owned(),
        message: message.into(),
        details: None,
    }
}

/// `<title>_業務の棚卸し.xlsx`, numbered when that name is taken.
fn free_path(dir: &std::path::Path, title: &str, suffix: &str) -> std::path::PathBuf {
    let stem: String = title
        .chars()
        .map(|c| {
            if r#"\/:*?"<>|"#.contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let stem = stem.trim();
    let stem = if stem.is_empty() { "inventory" } else { stem };
    let mut path = dir.join(format!("{stem}_{suffix}.xlsx"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem}_{suffix} ({n}).xlsx"));
        n += 1;
    }
    path
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn names_the_file_after_the_title_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let first = free_path(dir.path(), "経理課/月次", "業務の棚卸し");
        assert_eq!(first.file_name().unwrap(), "経理課_月次_業務の棚卸し.xlsx");
        std::fs::write(&first, b"x").unwrap();
        let second = free_path(dir.path(), "経理課/月次", "業務の棚卸し");
        assert_eq!(
            second.file_name().unwrap(),
            "経理課_月次_業務の棚卸し (2).xlsx"
        );
    }
}
