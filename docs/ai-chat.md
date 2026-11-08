# Building flows with an AI chat that has no MCP

English | [日本語](ja/ai-chat.md)

Some workplaces allow only one AI, such as Microsoft Copilot, and it cannot connect to SpellSheet's MCP server. Such an AI can still write flows: it reads a guide that describes the flow format, every node and every function, answers with JSON, and you paste the answer into Studio. Studio checks it, opens it, and shows what is left for you to do.

The AI never runs anything and never sees your screen or your passwords. What it writes is saved as the working content; unattended runs use it only after a person reviews and publishes it ([policy.md](policy.md)).

## 1. Give the AI the guide

The guide is two files, made from the nodes installed on your PC:

| File | What it is | Where it goes |
| --- | --- | --- |
| `shikigami-ai-instructions.md` | How to answer (under 8,000 characters) | The agent's instructions |
| `shikigami-ai-reference.md` | The flow format, every node with its params and examples, every function | Knowledge (an attached file) |

Save them from Studio (Flows › **Paste an AI answer** › **Save the guide**; they go to `Downloads\SpellSheet AI 仕様書`) or with the command line:

```
shikigami ai-guide --dir <folder>
```

A copy for the built-in nodes is in [docs/ai/](ai/), for people who have not installed SpellSheet yet. Node plugins are only in the files you save on your PC.

- **Microsoft Copilot Studio agent**: paste the whole of `shikigami-ai-instructions.md` into the agent's instructions and add `shikigami-ai-reference.md` as a knowledge source. Everyone who uses the agent then asks it for flows directly.
- **A chat without agents**: attach both files at the start of the conversation (or paste the instructions and attach the reference) and ask the AI to follow them. The reference is long, so a chat that reads only part of an attachment may miss nodes; an agent with the reference as knowledge works better.

Save the guide again after updating SpellSheet or installing a plugin, and replace the files the AI has.

## 2. Ask for a flow

Tell the AI what to automate in plain words: the site or app, the order of the work, the files it reads and writes. It asks about what it needs and answers with one JSON block (the "answer": a summary, questions for you, and the flow).

Because the AI cannot see the screen, it does not guess buttons or fields. It names each one as a **part** and describes where it is ("the Save button at the top right"); you point at it in Studio. It also never writes passwords: it names a login, and you register it in Studio.

## 3. Paste the answer into Studio

Open **Paste an AI answer** (on the Flows page, in the AI pane, or by right-clicking the flow chart), paste the AI's whole reply (text around the JSON is fine) and press **Take in**. You can add it as a new flow or replace the content of the open flow (Undo brings the old content back).

- **When it cannot be read** (broken JSON, unknown fields), nothing is changed. Press **Copy text for the AI** and paste it into the chat: it lists each problem and asks for the whole answer again.
- **When it is taken in**, Studio shows two lists:
  - **To do before it runs**: what only you can do, each with its button. *Pick on the screen* (opens the part; click the element with Pick on screen), *Register the login* (opens the secret form with the name filled in), *Put the file in the flow's folder* (opens the folder). Nodes that wait for you carry a **To do** mark on the flow chart, and the title bar counts them. Each item leaves the list when it is done.
  - **For the AI to fix**: mistakes in how the flow is written (a missing param, an unknown node). **Copy text for the AI** copies the problems together with the current flow; paste it into the chat and take the new answer in again.

The AI's summary and questions go to **Review** like the changes of an AI connected by MCP: answer the questions there, try the flow, and publish it.

## 4. Change a flow with the AI

To have the AI change an existing flow, right-click the flow chart and choose **Copy for an AI** (or use the button in the paste dialog). It copies the flow and how to answer; paste it into the chat, write what to change, and take the answer in with *replace the content of the open flow*. The AI keeps the node IDs and the parts you picked, so the review shows only what changed.

## The answer format

```json
{
  "format": "shikigami.answer",
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

A part without `target` waits for a person to pick it (`PART_NOT_PICKED`); the nodes that use it do not validate until then, so the flow cannot run with a guess in it. Studio also takes a bare flow (`{ "name": …, "steps": [ … ] }`).
