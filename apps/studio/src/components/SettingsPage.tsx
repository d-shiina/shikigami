// The settings place: everything about this PC's Studio that is not part of a
// flow. One section per subject; a new setting goes into the section it
// is about, or becomes a new section here (and in SECTIONS), never a button
// elsewhere. Laid out like Windows 11 / VS Code settings: the sections are
// listed on the left, the settings fill the width on the right, one row each.
import { Bot, FolderOpen, Info, type LucideIcon, Monitor, Play, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAgent } from "../agent";
import { type BandSettings, loadBandSettings, saveBandSettings } from "../lib/bandSettings";
import { t } from "../lib/i18n";
import { AgentPicker } from "./AgentPane";
import { CHAT_AIS, type ChatAi, useAiWay } from "../lib/aiWay";
import { api } from "../lib/api";
import { ApiKeyBox } from "./AgentApiKey";
import { AboutSection, McpSetupRow } from "./AppMenu";
import { DistributionSettings } from "./Distribution";
import { PolicySection } from "./PolicySection";
import { SettingsGroup, SettingsRow } from "./settingsLayout";
import { LanguageSwitch, ThemeSwitch, WorkspaceSection } from "./StatusBar";

const IDS = ["workspace", "display", "run", "policy", "agent", "about"] as const;
type SectionId = (typeof IDS)[number];

function sections(): { id: SectionId; title: string; icon: LucideIcon; body: () => ReactNode }[] {
  return [
    { id: "workspace", title: t.shell.workspaceSection, icon: FolderOpen, body: () => (
        <div className="space-y-6">
          <WorkspaceSection />
          <DistributionSettings />
        </div>
      ) },
    { id: "display", title: t.shell.displaySection, icon: Monitor, body: () => <DisplaySection /> },
    { id: "run", title: t.band.settingsSection, icon: Play, body: () => <RunSection /> },
    { id: "policy", title: t.policy, icon: ShieldCheck, body: () => <PolicySection /> },
    { id: "agent", title: t.shell.agentSection, icon: Bot, body: () => <AgentSection /> },
    { id: "about", title: t.shell.aboutSection, icon: Info, body: () => <AboutSection /> },
  ];
}

function DisplaySection() {
  return (
    <SettingsGroup>
      <SettingsRow label={t.bar.language}>
        <div className="flex">
          <LanguageSwitch labeled />
        </div>
      </SettingsRow>
      <SettingsRow label={t.bar.theme}>
        <div className="flex">
          <ThemeSwitch labeled />
        </div>
      </SettingsRow>
    </SettingsGroup>
  );
}

/** How Writer makes way for a run that works on the screen (the run band). */
function RunSection() {
  const [settings, setSettings] = useState<BandSettings>(loadBandSettings);
  const change = (next: BandSettings) => {
    setSettings(next);
    saveBandSettings(next);
  };
  return (
    <SettingsGroup>
      <SettingsRow label={t.band.shrink} hint={t.band.shrinkHint} htmlFor="settings-band-shrink">
        <input
          id="settings-band-shrink"
          type="checkbox"
          checked={settings.shrink}
          onChange={(e) => change({ ...settings, shrink: e.target.checked })}
        />
      </SettingsRow>
      <SettingsRow label={t.band.restore} hint={t.band.restoreHint} htmlFor="settings-band-restore">
        <input
          id="settings-band-restore"
          type="checkbox"
          checked={settings.restoreAtEnd}
          disabled={!settings.shrink}
          onChange={(e) => change({ ...settings, restoreAtEnd: e.target.checked })}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

const select = "h-7 min-w-0 rounded-lg border border-slate-300 bg-sheet px-1.5 text-[12px]";
const plain = "flex h-7 items-center rounded-lg border border-slate-300 bg-sheet px-2.5 text-[12px] text-slate-700 hover:bg-slate-50";

function AgentSection() {
  const info = useAgent((s) => s.info);
  const setOpen = useAgent((s) => s.setOpen);
  const way = useAiWay((s) => s.way);
  const setWay = useAiWay((s) => s.setWay);
  const askAgain = useAiWay((s) => s.askAgain);
  const chat = useAiWay((s) => s.chat);
  const setChat = useAiWay((s) => s.setChat);
  const autoRead = useAiWay((s) => s.autoRead);
  const setAutoRead = useAiWay((s) => s.setAutoRead);
  const [saved, setSaved] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const c = t.aiChat.settings;
  const paste = way === "paste";
  const saveGuide = async () => {
    try {
      setSaved(await api.saveAiGuide());
      setSaveError(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <SettingsGroup>
      <SettingsRow label={c.way} hint={c.wayHint} htmlFor="settings-ai-way">
        <div className="flex max-w-md items-center gap-2">
          <select
            id="settings-ai-way"
            className={`${select} flex-1`}
            value={paste ? "paste" : "agent"}
            onChange={(e) => setWay(e.target.value === "paste" ? "paste" : "agent")}
          >
            <option value="agent">{c.agent}</option>
            <option value="paste">{c.paste}</option>
          </select>
          <button
            type="button"
            onClick={() => {
              askAgain();
              setOpen(true);
            }}
            className={plain}
          >
            {c.ask}
          </button>
        </div>
      </SettingsRow>
      {paste ? <>
        <SettingsRow label={c.chat} htmlFor="settings-ai-chat">
          <select id="settings-ai-chat" className={`${select} max-w-md`} value={chat} onChange={(e) => setChat(e.target.value as ChatAi)}>
            {CHAT_AIS.map((ai) => (
              <option key={ai.id} value={ai.id}>
                {ai.id === "other" ? c.other : ai.name}
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow label={c.autoRead} hint={c.autoReadHint} htmlFor="settings-ai-autoread">
          <input id="settings-ai-autoread" type="checkbox" checked={autoRead} onChange={(e) => setAutoRead(e.target.checked)} />
        </SettingsRow>
        <SettingsRow label={c.guide} hint={c.guideHint}>
          <button type="button" onClick={() => void saveGuide()} className={plain}>
            {c.saveGuide}
          </button>
          {saved && <p className="mt-1 text-[12px] break-all text-moegi-600">{t.paste.savedGuide(saved)}</p>}
          {saveError && <p className="mt-1 text-[12px] text-shu-600">{saveError}</p>}
        </SettingsRow>
      </> : <AgentRows info={info} setOpen={setOpen} />}
    </SettingsGroup>
  );
}

function AgentRows({ info, setOpen }: { info: ReturnType<typeof useAgentInfo>; setOpen: (open: boolean) => void }) {
  return (
    <>
      <SettingsRow label={t.shell.agentPick} hint={t.shell.agentPickHint} htmlFor="settings-agent">
        <div className="flex max-w-md">
          <AgentPicker id="settings-agent" />
        </div>
        {!info?.available && <p className="mt-1 text-[12px] text-shu-600">{info?.problem ?? t.shell.agentNone}</p>}
        {info && !info.available && info.installable && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-1.5 flex h-7 items-center rounded-lg border border-slate-300 bg-sheet px-2.5 text-[12px] text-slate-700 hover:bg-slate-50"
          >
            {t.agent.setup.title}
          </button>
        )}
      </SettingsRow>
      {info?.usesApiKey && (
        <SettingsRow label={t.shell.agentApiKey} align="start">
          <ApiKeyBox inSettings />
        </SettingsRow>
      )}
      {info?.command && (
        <SettingsRow label={t.shell.agentCommand}>
          <code className="block truncate font-mono text-[12px] text-slate-600" title={info.command}>
            {info.command}
          </code>
        </SettingsRow>
      )}
      <McpSetupRow />
    </>
  );
}

const useAgentInfo = () => useAgent((s) => s.info);

export function SettingsPage() {
  const list = sections();
  const scroller = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<SectionId>("workspace");

  // A section picked in the list stays marked while the pane scrolls to it,
  // even when it is too near the bottom to reach the top.
  const picked = useRef<SectionId | null>(null);

  // Mark the section being read in the list: the last one whose top has
  // passed the upper part of the pane (or the last one once scrolled to the
  // very bottom).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => {
      if (picked.current) return setCurrent(picked.current);
      const top = el.getBoundingClientRect().top + 80;
      let found: SectionId = IDS[0];
      for (const id of IDS) {
        const node = el.querySelector(`#settings-${id}`);
        if (node && node.getBoundingClientRect().top <= top) found = id;
      }
      const scrolled = el.scrollTop > 0 && el.scrollHeight > el.clientHeight + 2;
      if (scrolled && el.scrollTop + el.clientHeight >= el.scrollHeight - 2) found = "about";
      setCurrent(found);
    };
    // The person scrolling by hand ends a pick.
    const release = () => {
      picked.current = null;
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    el.addEventListener("wheel", release, { passive: true });
    el.addEventListener("pointerdown", release);
    el.addEventListener("keydown", release);
    return () => {
      el.removeEventListener("scroll", update);
      el.removeEventListener("wheel", release);
      el.removeEventListener("pointerdown", release);
      el.removeEventListener("keydown", release);
    };
  }, []);

  const go = (id: SectionId) => {
    picked.current = id;
    setCurrent(id);
    scroller.current?.querySelector(`#settings-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="@container/settings flex h-full bg-paper">
      <nav aria-label={t.shell.settings} className="hidden w-[200px] shrink-0 border-r border-slate-200 px-3 py-4 @min-[760px]/settings:block">
        <ul className="space-y-0.5">
          {list.map(({ id, title, icon: Icon }) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => go(id)}
                aria-current={current === id ? "true" : undefined}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${
                  current === id ? "bg-slate-100 font-semibold text-ink" : "text-slate-600 hover:bg-slate-100 hover:text-ink"
                }`}
              >
                <Icon size={15} strokeWidth={1.75} className="shrink-0" />
                <span className="truncate">{title}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div ref={scroller} className="@container min-w-0 flex-1 overflow-y-auto">
        <div className="max-w-[960px] space-y-7 px-8 pt-4 pb-10">
          {list.map(({ id, title, body }) => (
            <section key={id} id={`settings-${id}`} aria-labelledby={`settings-${id}-title`} className="scroll-mt-4 space-y-3">
              <h3 id={`settings-${id}-title`} className="text-[15px] font-bold">
                {title}
              </h3>
              {body()}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
