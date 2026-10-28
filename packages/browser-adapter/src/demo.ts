// One-command browser demo: serves the demo site and runs
// examples/browser-demo.json with the Shikigami CLI (no AI involved).
//
//   pnpm demo:browser
//
// The browser window is visible and slowed down so you can follow along
// (set SHIKIGAMI_BROWSER_SLOWMO=0 to run at full speed).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { startDemoSite } from "./demo-site.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const { server, url } = await startDemoSite(8787);
console.log(`デモサイト: ${url}`);

const child = spawn(
  "cargo",
  ["run", "-q", "-p", "shikigami-cli", "--", "run", "examples/browser-demo.json", "--input", `siteUrl=${url}`],
  {
    cwd: repo,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { SHIKIGAMI_BROWSER_SLOWMO: "400", ...process.env },
  },
);
child.on("exit", (code) => {
  server.close();
  process.exit(code ?? 1);
});
