# Work inventory: finding what to automate

English | [日本語](ja/inventory.md)

People who start with RPA often do not know which of their work to automate first. In the **work inventory** (業務の棚卸し), the AI interviews the person the way a consultant would: what their work is, how often it comes, how long it takes, how much of it is hands-only work. SpellSheet keeps what was said and works out, with fixed formulas, how many hours a month each piece of work takes, how many a flow could save, and the order to build them in. The person reads it as one sheet in Writer and has the AI build the first flow from it.

## How it goes

1. **Start.** In Writer: the empty flow list's "Find what to automate with the AI", the sidebar's "Work inventory", or the search box at the top. From another AI client (Claude Code, Cursor, …): the MCP prompt `find_what_to_automate`, or just ask "what should I automate?".
2. **Interview.** The AI asks one or two questions at a time, in about four stages: the work as a whole (department, systems used every day), listing the work (last week from Monday on, then month-end, closing and work done a few times a year), more detail on the 3 to 5 pieces that take the most time, and confirming the numbers. In Writer's AI chat, questions with fixed answers come as cards. What is said is saved as it goes, so the person can stop and continue later ("Continue with the AI").
3. **The sheet.** Writer shows the inventory beside the chat and fills it in as the AI saves: hours a month now, hours a flow could save, the work to build first, a chart of time to save against ease, and the work in order. Numbers can be corrected on the sheet (click one); the order is worked out again.
4. **Build.** "Have the AI build it" on a row asks the AI for a flow, with what was heard about that work (systems, files, steps, exceptions). The flow is linked to the row.
5. **Pass it on.** "Export to Excel" writes the sheet to the Downloads folder, to show a manager or keep.

The AI never asks for passwords, real customer names, amounts, or screenshots.

## The numbers

| Value | How |
|---|---|
| Hours a month | times a month × minutes each time × people. A day counts 20 working days a month, a week 52/12 |
| Hours a flow could save | hours a month × the share of hands-only work (copying, typing, downloading, checking against a list). Judging, phoning and talking stay with people |
| Ease | high, medium or low, with the reasons: input that is data, fixed steps and few exceptions make it easier; web systems and Excel are usually high, Windows business apps medium, remote desktops (Citrix) and paper low |
| Order | Hours that could be saved, weighted by ease (high 1, medium 0.6, low 0.3) and by what a mistake costs (high 1.5, medium 1.2) |

Each piece of work falls into one of these groups:

| Group | When |
|---|---|
| Build first | Ease high or medium, and saves 5 hours a month or more |
| Build later | Ease high or medium, saves less |
| Split it up | Saves 5 hours a month or more, but ease low: start with a part |
| Still asking | How often, how long, the share or the ease is not known yet |
| Not now | The AI noted a reason (judgment at its core, once a year, a system about to be replaced), or little to save and hard |

The AI only records facts; it does not rank the work itself, so the order is the same whichever AI asked.

## Where it is kept

`<workspace>/inventory/<id>.json`, one file per inventory (shape: `WorkInventory` in `schemas/api.schema.json`). It sits in the workspace with the flows, so a shared workspace shares it.

## MCP

| Tool | Class | What it does |
|---|---|---|
| `get_work_inventory` | read | Without `id`: the inventories and the `guide` for the interview. With `id`: the inventory, its `assessment` (order, hours, what is still missing) and the guide |
| `save_work_inventory` | write | Records what was heard. Without `id` it starts an inventory (`title`). `tasks` adds work (no task `id`) or changes it (only the fields given; `null` clears one). Returns the inventory and its assessment |

The prompt `find_what_to_automate` (argument `about`: whose work) starts the same interview in clients that show MCP prompts. The interview guide is returned by `get_work_inventory` too, so clients without prompts follow the same steps.

## Command line

```sh
spellsheet inventory list
spellsheet inventory show <id> [--json]
spellsheet inventory export <id> out.xlsx [--english]
```

## Limits

- Hours that were actually saved (from the runs of the flows made for a row) are not shown yet.
- AIs that only chat (no MCP, [ai-chat.md](ai-chat.md)) cannot save an inventory.
