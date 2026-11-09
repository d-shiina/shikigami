# Extensions

English | [日本語](ja/extensions.md)

Extensions add nodes to SpellSheet after the fact: a cloud AI-OCR service, an in-house system, a business SaaS API — integrations only some people need, added without rebuilding SpellSheet. As with VS Code extensions, only what you install shows up in the palette, and you can turn an extension off or remove it again.

- An extension runs as **a separate program** (Node.js, Python, .NET, PowerShell, anything with stdin/stdout). If it misbehaves, Writer and runs keep going; only its node fails.
- Its nodes work like built-in ones: they are listed in the palette, their settings form is built from what the extension declares, and validation, retries, timeouts and secret masking apply as usual.
- AI clients get them too: MCP `list_step_types` / `get_step_schema` and Writer's "save the spec" include extension nodes.

The design is in [design/plugins.md](design/plugins.md) (Japanese; the code calls extensions "plugins").

## Using extensions

### Writer's Extensions place

The sidebar's Extensions place lists installed extensions (on/off, check for update, uninstall) and, in the Catalog tab, the registry below. Install takes a source and shows what the extension is (its nodes, the data they send outside, the secrets they need, the program it starts) before installing. Changes take effect after Writer restarts (the place offers a Restart button).

An extension's nodes are listed in the palette under the extension's name, with its tag (e.g. "AI-OCR") before node names; their settings form is built from the manifest's JSON Schema.

### Installing

| From | Write |
|---|---|
| A zip file or folder on this PC | `C:\Downloads\azureocr-0.1.0.zip` |
| A GitHub repository (its latest release) | `https://github.com/<owner>/<repo>` |
| A zip URL (https only) | `https://example.com/azureocr-0.1.0.zip` |

For a GitHub repository, the first `.zip` attached to the latest release is used (the release's source zip when none is attached).

```powershell
spellsheet plugin install https://github.com/<owner>/<repo>        # only shows what it is
spellsheet plugin install https://github.com/<owner>/<repo> --yes  # installs it
```

Before installing, SpellSheet shows the extension's name, publisher, nodes, **the data they send outside**, the secrets they take and the program it starts. An extension runs as a program on this PC: install only what you trust.

Extensions are installed into `%LOCALAPPDATA%\SpellSheet\plugins\<name>\`, never into the workspace (a program placed in a shared workspace must not start on everyone's PC). Restart Writer and AI clients after installing, updating or turning one off.

### Listing, turning off, updating, removing

```powershell
spellsheet plugin list              # loaded, turned off, and not loadable (with reasons)
spellsheet plugin disable azureocr  # kept, but its nodes are not loaded
spellsheet plugin enable azureocr
spellsheet plugin update azureocr   # fetch the new version from where it was installed from (--yes to update)
spellsheet plugin remove azureocr
```

A flow using a node of a turned-off extension fails validation with `PLUGIN_NOT_INSTALLED`, as if it were not installed (the flow itself is kept). Flows record the extensions and versions they use in `requires` (`{ "plugin:azureocr": "^0.1.0" }`), so another PC knows what is missing.

### Registry

A list of extensions for your organisation or community is one JSON index file. No server is needed: the raw URL of a file in a Git repository is enough.

```powershell
spellsheet plugin registry --set https://example.com/shikigami-extensions.json
spellsheet plugin registry          # show the list
```

```json
{
  "extensions": [
    {
      "name": "azureocr",
      "label": "Azure AI-OCR",
      "description": "Reads images and PDFs with Azure AI Document Intelligence",
      "version": "0.1.0",
      "publisher": "SpellSheet samples",
      "homepage": "https://github.com/<owner>/<repo>",
      "source": "https://github.com/<owner>/<repo>"
    }
  ]
}
```

`source` is where to install from (a GitHub repository or a zip URL). The index URL is kept in the user's config file (`extensions.registry` in `%APPDATA%\SpellSheet\config.json`).

### Data sent outside, and what may run

A node that sends data to a cloud service says so in its manifest's `external`.

- Writer's review panel (before publishing) lists it under the effects outside, e.g. "Sent to Azure AI Document Intelligence: the file to read (image or PDF)".
- A setting holding the address it sends to (declared in `targets` as a `site`) is checked against the workspace `policy.json` `sites`. With only `https://<resource>.cognitiveservices.azure.com` there, nothing can be sent anywhere else ([policy.md](policy.md)).
- An extension node's `risk` decides whether AI clients need approval to run it (`policy.json` `ai.runFlow` / `ai.testStep`). Make nodes that send files outside `interactive` or higher so an AI cannot try them without a person's approval.

### Secrets

Register API keys and the like in Writer (Secrets) and pick them by name in a node's settings. The value is never written into the flow or shown to AI.

- An extension only receives secrets in the settings listed in `secretParams`.
- A secret reaches an extension only if its allowed sites include `plugin:<name>` (e.g. `plugin:azureocr`); otherwise the node fails with `SECRET_PLUGIN_NOT_ALLOWED`.
- With `credentials` in the manifest naming the kind (`login` / `apiKey` / `oauth`), Writer offers secrets of that kind and opens the new-secret form with it.

## Writing an extension

### Folder

```text
azureocr/
├─ shikigami-plugin.json   … manifest (declares the nodes)
├─ main.mjs                … the program (JSON-RPC on stdin/stdout)
└─ README.md
```

To share it, zip the folder (zipping the folder itself or only its contents both work). Attach the zip to a GitHub release and it installs from the repository URL.

Two samples:

| Sample | Shows |
|---|---|
| [examples/plugins/azure-ocr](../examples/plugins/azure-ocr) | Cloud AI-OCR (Azure AI Document Intelligence): sending outside, an API key, a file setting, naming settings |
| [examples/plugins/hello](../examples/plugins/hello) | The smallest one; file locking (`resources`) |

### Manifest

See the Japanese page for the full field table; in short:

| Field | Required | Meaning |
|---|---|---|
| `manifestVersion`, `name`, `version`, `label`, `command` | yes | Format `1`; node type prefix (`azureocr` → `azureocr.readDocument`); semver; display name (also the palette group); the program to start (`node` is the Node.js shipped with SpellSheet) |
| `description`, `publisher`, `homepage` | - | Shown in the extension list (`homepage` must be https) |
| `tag` | - | The "where" tag before node names (`AI-OCR`); defaults to `label` |
| `icon` | - | A [Lucide](https://lucide.dev/icons) icon name (`scan-text`) |
| `credentials` | - | Secrets taken: `kind` (`login` / `apiKey` / `oauth`), `label`, `description`, `params` (the `secretParams` taking it) |
| `steps[]` | yes | `action`, `label` (a noun), `description` (for AI), `summary` (one sentence for people, shown in Writer), `params` (JSON Schema; Writer's form), `examples` (validated on load), and optional `hasOutput`, `risk`, `secretParams`, `pathParams` (relative paths resolved from the flow's folder), `targets`, `external` (`service`, `data`, `param`), `resources`, `defaultTimeoutMs`, `deprecated` |

A setting's name in Writer is its schema `title`, the line under it `description`; display names for `enum` values go in `x-enumLabels`. Unknown manifest fields are errors.

### Protocol

One JSON-RPC 2.0 message per line on stdin, answers on stdout. `method` is the node's `action`; `params` are its settings (templates filled in) plus `runId` and `timeoutMs` (stop by then). Errors carry `data.code`, `retryable` and `details.hint` (shown to people and AI). `closeRun` (`{ "runId" }`) comes at the end of a run. Calls may overlap (parallel branches). stdout is for answers only; log to stderr (secret values are masked there). Exit when stdin closes.

### Checking

```powershell
spellsheet plugin check examples\plugins\azure-ocr   # manifest, schemas, examples
$env:SPELLSHEET_PLUGINS = "$PWD\examples\plugins"     # load without installing (development)
spellsheet step-types                                  # lists azureocr.readDocument
node --test examples\plugins\azure-ocr\test.mjs      # against a stand-in for Azure
```

Extensions loaded from `SPELLSHEET_PLUGINS` are listed, but cannot be turned off, updated or removed (your working folder is left alone).

## Sample: Azure AI-OCR

[examples/plugins/azure-ocr](../examples/plugins/azure-ocr) adds the node "AI-OCR の読み取り", reading text, tables and invoice or receipt fields from images and PDFs with Azure AI Document Intelligence.

1. Create a Document Intelligence resource in the Azure portal and open "Keys and Endpoint".
2. In Writer (Secrets), register the key as an API key and add `plugin:azureocr` to its allowed sites.
3. In the node's settings, set the endpoint, the API key (the registered name), the file and the kind of reading.
4. Keep the result with `saveAs` and use it as `{{ invoice.fields.InvoiceTotal }}` or `{{ invoice.text }}`.

Other cloud AI-OCR services (Google Document AI, Japanese AI-OCR services, …) follow the same shape: replace the request and response handling in `main.mjs`.
