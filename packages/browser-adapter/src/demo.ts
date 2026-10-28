// One-command browser demo: serves the demo site and runs
// examples/browser-demo.json with the Shikigami CLI (no AI involved).
//
//   pnpm demo:browser
//
// The browser window is visible and slowed down so you can follow along
// (set SHIKIGAMI_BROWSER_SLOWMO=0 to run at full speed).
//
// The demo account is registered as the secret 「デモ受注システム」 first, so the
// scenario never contains the password; the login is kept between runs
// (run it twice: the second run skips the login page).
//
// The CLI is built into target/demo so a shikigami.exe already running from
// target/debug (e.g. the MCP server) does not block the build on Windows.

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
if (code === 0) code = await cli(["run", "examples/browser-demo.json", "--input", `siteUrl=${url}`]);
server.close();
process.exit(code);
