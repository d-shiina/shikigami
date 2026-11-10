# Building flows with an AI chat that has no MCP

English | [日本語](ja/ai-chat.md)

Some workplaces allow only one AI, such as Microsoft Copilot, and it cannot connect to SpellSheet's MCP server. Such an AI can still write flows: Writer puts the request together (how to answer, the flow as it is, your words), copies it and opens the AI chat. You bring the AI's answer back, and Writer checks it, takes it in, and shows what changed and what is left for you to do.

The AI never runs anything and never sees your screen or your passwords. What it writes is saved as the working content; unattended runs use it only after a person reviews and publishes it ([policy.md](policy.md)).

## 0. Say which AI you use

With no AI on the PC that Writer can run (such as Claude Code), Writer first asks which AI you use: on the flows page under "What do you want to automate?" while there are no flows yet, or else the first time you open the AI chat. You pick it by name; Writer decides whether it can use MCP.

- **Microsoft Copilot**: work account (Microsoft 365 Copilot) or personal account. Both are used by copying into the chat.
- **ChatGPT, Gemini, Claude**: the chat in the browser or app, or the version installed on the PC (Codex, Antigravity, Claude Code). With the installed version, Writer runs the AI, which looks at the screen and tests as it builds the flow.
- **GitHub Copilot, Cursor**: Writer runs them.
- **Not sure**: an AI already on this PC if there is one, else copying into a chat.

You can change it later under **Settings → AI**, "How to work with AI".

## 1. Ask

Write what you want to automate in the AI chat box (the sites or apps, the order of the work, the files it reads and writes). **Copy and open Microsoft 365 Copilot** (it shows the AI you chose) copies the request and opens the AI chat in the browser. Paste it there and send. With a flow open, the request carries the flow as it is, so you can ask for changes in plain words too.

In a new chat, attach the reference `spellsheet-ai-reference.md` (the flow format, every node's parameters with examples, the functions) once. **Open the reference file** in the chat box opens the folder it is saved in (`Downloads\SpellSheet AI 仕様書`). The reference is made from the nodes on this PC, plugins included.

The AI cannot see the screen, so it never guesses buttons or fields. It names each one as a **part** and says where it is ("the Save button at the top right"); you point at the element in Writer. It never writes passwords either, only the name of a login, which you register in Writer.

### Set it up once for your AI

Instead of attaching it every time, you can put the reference into the AI you use. Save the two files with **Settings → AI → Save reference** (or `spellsheet ai-guide --dir <folder>`), then add them as below. A version with the built-in nodes only is in [docs/ai/](ai/).

| AI | Where | Instructions (paste the whole of `spellsheet-ai-instructions.md`) | File (add `spellsheet-ai-reference.md`) |
|---|---|---|---|
| Microsoft Copilot | A Copilot Studio agent | The agent's instructions | Knowledge |
| ChatGPT | A project | Project instructions | Project files |
| Gemini | A Gem | The Gem's instructions | Knowledge (files) |
| Claude | A project | Project instructions | Project knowledge |

Whether you can use these depends on your plan and your company's settings. Once set up, start new chats inside that agent, project or Gem and skip attaching the reference (you can skip that step in Writer's guide). Save and replace the files after updating SpellSheet or adding plugins.

## 2. Bring the answer back

### Adding a screen

The AI cannot see your screen, so on its own it only names the buttons and fields, and you pick each later with "Pick on screen". With **Add a screen** above the box, the request also lists the names and kinds of that screen's buttons, fields and lists, and the AI can point at them.

- **Click an app's window**: Writer gets out of the way; click the window you want the AI to see.
- **Web page address**: opens and reads the page in Writer's browser. The pages the flow opens are offered. For a page that needs a login, log in in that browser, then press **Open and add** again.

Only the names and kinds of the parts go into the request: no typed values, text on the screen, data rows of tables and lists, or pictures. The screens go with the next request you copy, and are taken off after it.

Copy the AI's answer and come back to Writer: when the answer is on the clipboard, **Take in from the clipboard** appears (Writer looks only while it waits for an answer, when you come back to it; you can turn this off under Settings → AI). Pasting it into the box and pressing **Take in** works too. Text around the answer is fine, and so are comments and trailing commas the AI adds to its JSON.

- **Taken in**: the flow opens, and the card shows three things.
  - **Changes**: the nodes added, changed and removed.
  - **Your part**: what only you can do, each with its button: pick the element on the screen, register a login (the form opens with the name filled in), put a file in the flow's folder. Done items leave the list.
  - **For the AI to fix**: mistakes in how the flow is written (a required parameter missing, a node that does not exist). **Copy fix request**, paste it into the chat, and take in the new answer. When the same mistake is still there after three answers in a row, **Fix by hand** appears and opens that node's settings.
  - **Questions from the AI**: what the AI decided on its own (a closing date, who gets the mail). Pick **Right** or **Wrong** for each, write what is right for the wrong ones, and **Send the answers to the AI** copies a request with your answers. These are the same answers as in **Review**.
  - **Try a run**: runs the flow just taken in. If it stops, **Ask <AI> to fix** on the band below copies a request with where it stopped and what the screen looked like.
- **Not readable** (broken JSON, unknown fields): nothing changes. **Copy fix request** sends it back to the chat.
- **Cut off** (the chat stopped a long answer midway): **Copy request to continue**, paste it into the chat, and take in what comes back; Writer reads it together with the first part.

The AI's summary and questions go to **Review**, just like changes from an AI connected through MCP. Answer the questions, try the flow, then publish.

A try run never starts by itself: a flow really works on files and apps, so you start it.

To take in an answer from a chat begun elsewhere, use **Paste AI answer** at the top of the AI chat, beside **New** on the flows page, or in the flow chart's right-click menu.

## The answer format

```json
{
  "format": "spellsheet.answer",
  "summary": "Search the order list\nLogs in and searches by order number.",
  "checks": ["Is the order number the right thing to search by?"],
  "flow": {
    "name": "Search orders",
    "parts": { "searchBox": { "label": "Search box above the order list", "app": "browser" } },
    "steps": [
      { "type": "browser.open", "params": { "url": "https://example.com/orders" } },
      { "type": "browser.fill", "params": { "target": { "part": "searchBox" }, "value": "{{ orderNo }}" } }
    ]
  }
}
```

A part without `target` waits for a person to pick it (`PART_NOT_PICKED`); the nodes that use it do not validate until then, so the flow cannot run with a guess in it. Writer also takes a bare flow (`{ "name": …, "steps": [ … ] }`).
