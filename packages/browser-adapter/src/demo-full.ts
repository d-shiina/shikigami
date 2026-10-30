// One-command full-feature demo: serves the demo site and runs
// examples/full-demo.shikigami.json with the Shikigami CLI (no AI involved).
//
//   pnpm demo:full
//
// Unlike `pnpm demo:browser` (which runs only the browser flow), this runs the
// whole full-feature bundle on screen: a start dialog, config, CSV, Excel
// (write/read, multi-sheet), loops/conditions/try, a Word invoice per
// customer, a ZIP, the browser shipping sub-scenario, Notepad driven and read
// back with OCR, an Excel macro, an Outlook draft, OAuth, the output folder in
// Explorer and a result dialog. Each of those is wrapped in a try, so an app
// that is missing is skipped. Set 実環境を使う = false in config/設定.json for
// unattended runs.
//
// The browser window is visible and slowed down (set SHIKIGAMI_BROWSER_SLOWMO=0
// for full speed). The demo account is registered as the secret 「デモ受注システム」
// first, so the scenario never contains the password; the login is kept between
// runs. The CLI is built into target/demo so a shikigami.exe already running
// from target/debug (e.g. the MCP server) does not block the build on Windows.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { startDemoSite } from "./demo-site.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const { server, url } = await startDemoSite(8787);
console.log(`デモサイト: ${url}`);

const SECRET = "デモ受注システム";

/** Runs the Shikigami CLI; `input` is written to its stdin. */
function cli(args: string[], input?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("cargo", ["run", "-q", "--target-dir", "target/demo", "-p", "shikigami-cli", "--", ...args], {
      cwd: repo,
      stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
      shell: process.platform === "win32",
      env: { SHIKIGAMI_BROWSER_SLOWMO: "400", ...process.env },
    });
    if (input !== undefined) child.stdin?.end(input);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

let code = await cli(
  ["secret", "set", SECRET, "--username", "demo", "--password-stdin", "--site", url],
  "shikigami\n",
);
if (code === 0) code = await cli(["run", "examples/full-demo.shikigami.json", "--input", `siteUrl=${url}`]);
server.close();
process.exit(code);
