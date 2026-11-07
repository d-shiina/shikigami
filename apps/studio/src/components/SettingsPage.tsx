// The settings place: everything about this PC's Studio that is not part of a
// flow. One section per subject; a new setting goes into the section it
// is about, or becomes a new section here (and in SECTIONS), never a button
// elsewhere. Laid out like Windows 11 / VS Code settings: the sections are
// listed on the left, the settings fill the width on the right, one row each.
import { Bot, FolderOpen, Info, type LucideIcon, Monitor, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAgent } from "../agent";
import { t } from "../lib/i18n";
import { AgentPicker } from "./AgentPane";
import { AboutSection } from "./AppMenu";
import { PolicySection } from "./PolicySection";
import { SettingsGroup, SettingsRow } from "./settingsLayout";
import { LanguageSwitch, ThemeSwitch, WorkspaceSection } from "./StatusBar";

const IDS = ["workspace", "display", "policy", "agent", "about"] as const;
type SectionId = (typeof IDS)[number];

function sections(): { id: SectionId; title: string; icon: LucideIcon; body: () => ReactNode }[] {
  return [
    { id: "workspace", title: t.shell.workspaceSection, icon: FolderOpen, body: () => <WorkspaceSection /> },
    { id: "display", title: t.shell.displaySection, icon: Monitor, body: () => <DisplaySection /> },
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

function AgentSection() {
  const info = useAgent((s) => s.info);
  return (
    <SettingsGroup>
      <SettingsRow label={t.shell.agentPick} hint={t.shell.agentPickHint} htmlFor="settings-agent">
        <div className="flex max-w-md">
          <AgentPicker id="settings-agent" />
        </div>
        {!info?.available && <p className="mt-1 text-[12px] text-shu-600">{info?.problem ?? t.shell.agentNone}</p>}
      </SettingsRow>
      {info?.command && (
        <SettingsRow label={t.shell.agentCommand}>
          <code className="block truncate font-mono text-[12px] text-slate-600" title={info.command}>
            {info.command}
          </code>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

export function SettingsPage() {
  const list = sections();
  const scroller = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<SectionId>("workspace");

  // Mark the section being read in the list: the last one whose top has
  // passed the upper part of the pane (or the last one at the very bottom).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => {
      const top = el.getBoundingClientRect().top + 80;
      let found: SectionId = IDS[0];
      for (const id of IDS) {
        const node = el.querySelector(`#settings-${id}`);
        if (node && node.getBoundingClientRect().top <= top) found = id;
      }
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) found = "about";
      setCurrent(found);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, []);

  const go = (id: SectionId) => {
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
                className={`flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-[13px] ${
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
