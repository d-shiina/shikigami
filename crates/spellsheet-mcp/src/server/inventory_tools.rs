//! 業務の棚卸し: the tools an AI client uses to interview a person about
//! their work and find what to automate first, and the prompt that starts it.
//! The data, the formulas and the storage are in spellsheet_core::inventory.

use rmcp::model::{
    GetPromptRequestParams, GetPromptResult, ListPromptsResult, Prompt, PromptArgument,
    PromptMessage, Role,
};
use spellsheet_core::InventoryId;
use spellsheet_core::inventory::{self, InventoryPatch};

use super::*;

/// The name AI clients list the interview under.
pub const PROMPT_NAME: &str = "find_what_to_automate";

/// How to run the interview. Returned by get_work_inventory, so it reaches
/// clients that do not show MCP prompts too.
pub const GUIDE: &str = "\
How to take stock of the person's work (業務の棚卸し) and find what to automate first. You are a consultant who listens; SpellSheet keeps the record and computes the numbers and the order.\n\
Goal: in about 15 minutes, the person's tasks with the time each takes, and the one or two worth automating first with SpellSheet. Then offer to build the first one.\n\
Rules:\n\
- Ask one or two short questions per message, in the person's language and their business words. No jargon (RPA, ROI, KPI, automation candidates). In Writer's AI chat use ask_user_to_choose for questions with fixed answers (how often, how many people, about how long).\n\
- Never ask for passwords, real customer or employee names, amounts, or screenshots. When an example helps, ask for column names only (取引先名、金額).\n\
- Save as you go: call save_work_inventory after each answer that adds or changes something (without id it starts a new inventory; keep the id it returns). The person may stop any time and continue later.\n\
- Record what the person said. Where you estimate, say so in the task's note and ask them to confirm. Do not rank tasks yourself or invent numbers: the assessment save_work_inventory returns is the order.\n\
Steps:\n\
1. The whole picture: department and role, and the systems used every day (web systems, Windows business apps, Excel, mail, paper or FAX). Save title (e.g. 「経理課 月次の締め」), about and systems.\n\
2. List the work: walk through last week from Monday morning, then month-end and month-start, closing, and work done a few times a year. Also ask what is tedious, what they fear getting wrong, and what only they can do. Aim for 5 to 15 tasks; save each with name and a one-line description, and frequency and minutes when said.\n\
3. Go deeper on the 3 to 5 that take the most time (monthlyMinutes in the assessment): frequency (times per day, week, month, quarter or year), minutes each time, how many people do it, what share of that time is hands-only work (copying, typing, downloading, checking against a list) rather than judging or talking (manualShare, percent), where the input comes from (data or paper), whether the steps are fixed, how often exceptions happen, the screens and files used (steps, systems, inputs, outputs), and what a mistake costs (errorImpact).\n\
4. Judge ease (high, medium, low) and write easeReasons: data input, fixed steps and few exceptions make it easier; web systems and Excel are usually high, Windows business apps medium, remote desktops (Citrix) and paper low (paper needs OCR). Check SpellSheet can do it: call list_step_types and put the node types a flow would use in stepTypes, and plugins it needs in plugins. Mark work that does not suit automation now (judgment at its core, once a year, a system about to be replaced) with notNow and the reason.\n\
5. Confirm: tell the person the result in a few lines (the order, hours a month now, hours a flow could save, what is still missing), ask whether the numbers look right, fix them, and set status \"done\". In Writer the person reads it as a sheet under 業務の棚卸し (the menu at the top left) and can correct numbers there.\n\
6. Offer to build the next one (assessment.next: the highest ranked task that has no flow yet): build the flow as usual, then save_work_inventory with that task's flowIds so the inventory points to it and the next task comes up. When the person comes back to an inventory, start from assessment.next.";

const SAVE_HINT: &str = "Saved. assessment.tasks is the order to build them (rank 1 first); `missing` lists what to ask next for each task. Follow the guide from get_work_inventory.";

impl SpellSheetMcp {
    fn workspace(&self) -> &std::path::Path {
        self.svc().store().root()
    }

    fn inventory_view(&self, inventory: &inventory::WorkInventory) -> Value {
        json!({
            "inventory": inventory,
            "assessment": inventory::assess(inventory),
        })
    }

    pub(super) fn prompts() -> Vec<Prompt> {
        vec![
            Prompt::new(
                PROMPT_NAME,
                Some("業務の棚卸し: interview the person about their work, find what takes time, and pick what to automate first with SpellSheet."),
                Some(vec![PromptArgument::new("about").with_description(
                    "Whose work, if known: department and role (e.g. 経理課の請求担当).",
                )]),
            )
            .with_title("何を自動化するか相談する"),
        ]
    }

    pub(super) fn prompt(
        &self,
        request: &GetPromptRequestParams,
    ) -> Result<GetPromptResult, ErrorData> {
        if request.name != PROMPT_NAME {
            return Err(ErrorData::invalid_params(
                format!("no prompt {}", request.name),
                None,
            ));
        }
        let about = request
            .arguments
            .as_ref()
            .and_then(|a| a.get("about"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let mut text = String::from(
            "何を自動化すればよいか相談したいです。業務の棚卸しをして、時間を取られている仕事と、自動化の効果が大きい仕事を見つけてください。\n\n",
        );
        if let Some(about) = about {
            text.push_str(&format!("私の仕事：{about}\n\n"));
        }
        text.push_str(GUIDE);
        text.push_str("\n\nFirst call get_work_inventory: continue an unfinished inventory the person had, or start a new one.");
        Ok(
            GetPromptResult::new(vec![PromptMessage::new_text(Role::User, text)])
                .with_description("業務の棚卸し"),
        )
    }

    pub(super) fn list_prompts_result() -> ListPromptsResult {
        ListPromptsResult::with_all_items(Self::prompts())
    }
}

#[tool_router(router = inventory_tools, vis = "pub(super)")]
impl SpellSheetMcp {
    /// 業務の棚卸し (a stock-take of the person's work). Use when the person does not know what to
    /// automate, or asks to find the work that takes their time. Without `id`: the inventories of
    /// this workspace (to continue one) and the `guide` for the interview. With `id`: that
    /// inventory, its `assessment` (the tasks in the order to build them, time per month, time a
    /// flow could save, what is still missing) and the guide.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_work_inventory(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<GetWorkInventoryParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = (|| {
            let root = self.workspace();
            Ok(match &p.id {
                Some(id) => {
                    let found = inventory::load(root, &InventoryId::new(id.as_str()))?;
                    let mut view = self.inventory_view(&found);
                    view["guide"] = json!(GUIDE);
                    view
                }
                None => json!({
                    "inventories": inventory::list(root)?,
                    "guide": GUIDE,
                }),
            })
        })();
        self.finish("get_work_inventory", &peer, None, outcome)
    }

    /// Record what the person said about their work (業務の棚卸し), as you go. Without `id` it starts
    /// a new inventory (`title` needed) and returns its id. `tasks` adds work (no task `id`) or
    /// changes it (the task's `id`; only the fields given change, `null` clears one). Fields:
    /// name, description, steps, frequency { times, per: day | week | month | quarter | year },
    /// minutes (one time, one person), people, manualShare (percent of the time that is
    /// hands-only work), ease and errorImpact (high | medium | low), easeReasons, systems,
    /// inputs, outputs, exceptions, stepTypes (from list_step_types), plugins, notNow (why it does
    /// not suit automation now), flowIds (flows built for it), note. Returns the inventory and its
    /// `assessment`, computed by SpellSheet; Writer shows it to the person as a sheet.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn save_work_inventory(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<InventoryPatch>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = (|| {
            let saved = inventory::change(self.workspace(), &p, actor(&peer))?;
            let mut view = self.inventory_view(&saved);
            view["hint"] = json!(SAVE_HINT);
            Ok(view)
        })();
        self.finish("save_work_inventory", &peer, None, outcome)
    }
}
