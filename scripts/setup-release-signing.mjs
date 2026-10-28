// One-time setup for signed releases (docs/release.md).
//
// Creates the updater signing key in ~/.tauri and registers it with GitHub:
// the private key as the TAURI_SIGNING_PRIVATE_KEY secret and the public key
// as the TAURI_UPDATER_PUBKEY variable, which the release workflow puts into
// the app. Uses the GitHub CLI (`gh`) when it is signed in; otherwise it puts
// each value on the clipboard and opens the page to paste it into.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const REPO = "d-shiina/shikigami";
const keyFile = join(homedir(), ".tauri", "shikigami.key");
const pubFile = `${keyFile}.pub`;
const windows = process.platform === "win32";

if (existsSync(keyFile)) {
  console.log(`既存の鍵を使います: ${keyFile}`);
} else {
  // No password: the key lives only in your user folder and in GitHub Secrets.
  execFileSync(
    "pnpm",
    ["--filter", "@shikigami/studio", "exec", "tauri", "signer", "generate", "--ci", "-w", keyFile],
    { stdio: "inherit", shell: windows },
  );
}
const privateKey = readFileSync(keyFile, "utf8").trim();
const publicKey = readFileSync(pubFile, "utf8").trim();

const gh = spawnSync("gh", ["auth", "status"], { stdio: "ignore", shell: windows });
if (gh.status === 0) {
  execFileSync("gh", ["secret", "set", "TAURI_SIGNING_PRIVATE_KEY", "--repo", REPO], {
    input: privateKey,
    stdio: ["pipe", "inherit", "inherit"],
    shell: windows,
  });
  execFileSync("gh", ["variable", "set", "TAURI_UPDATER_PUBKEY", "--repo", REPO, "--body", publicKey], {
    stdio: "inherit",
    shell: windows,
  });
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const paste = async (value, url, what) => {
    execFileSync(windows ? "clip" : "pbcopy", { input: value });
    if (windows) spawnSync("cmd", ["/c", "start", "", url]);
    console.log(`\n${what}をクリップボードに入れました。開いたページ（${url}）で貼り付けて保存してください。`);
    await rl.question("終わったら Enter: ");
  };
  await paste(
    privateKey,
    `https://github.com/${REPO}/settings/secrets/actions/new`,
    "Name に TAURI_SIGNING_PRIVATE_KEY、Secret に秘密鍵",
  );
  await paste(
    publicKey,
    `https://github.com/${REPO}/settings/variables/actions/new`,
    "Name に TAURI_UPDATER_PUBKEY、Value に公開鍵",
  );
  rl.close();
}

console.log(`
準備ができました。秘密鍵 ${keyFile} はなくすと更新を配れなくなるので、バックアップしておいてください。`);
