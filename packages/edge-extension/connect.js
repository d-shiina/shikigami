// Opened by SpellSheet with the relay address and its token: asks the worker
// to connect, and the person to approve SpellSheet the first time.

const lang = navigator.language.startsWith("ja") ? "ja" : "en";
document.documentElement.lang = lang;
for (const el of document.querySelectorAll("[data-ja]")) el.textContent = el.dataset[lang];

const query = new URLSearchParams(location.search);
const request = { relay: query.get("relay"), token: query.get("token"), title: query.get("title") || undefined, url: query.get("url") || undefined };

function show(id) {
  for (const section of document.querySelectorAll("main > section")) section.hidden = section.id !== id;
}

async function closeTab() {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
}

async function send(type) {
  const answer = await chrome.runtime.sendMessage({ type, ...request });
  if (answer?.ok) {
    await closeTab();
  } else if (answer?.needApproval) {
    show("ask");
  } else {
    document.getElementById("reason").textContent = answer?.error ?? "";
    show("failed");
  }
}

document.getElementById("allow").addEventListener("click", () => void send("approve"));
document.getElementById("deny").addEventListener("click", () => show("denied"));
void send("connect");
