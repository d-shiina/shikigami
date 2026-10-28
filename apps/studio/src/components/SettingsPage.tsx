// The settings place: everything about this PC's Studio that is not part of a
// scenario. One section per subject; a new setting goes into the section it
// is about, or becomes a new section here, never a button elsewhere.
import type { ReactNode } from "react";
import { useAgent } from "../agent";
import { t } from "../lib/i18n";
import { AboutSection } from "./AppMenu";
import { LanguageSwitch, ThemeSwitch, WorkspaceSection } from "./StatusBar";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-[4px] border border-slate-200 bg-sheet p-4 shadow-sheet">
      <h3 className="mb-3 text-[13px] font-bold">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1 text-[13px]">
      <span className="w-28 shrink-0 text-slate-500">{label}</span>
      {children}
    </div>
  );
}

function AgentSection() {
  const info = useAgent((s) => s.info);
  return (
    <div className="text-[13px]">
      <Row label={t.shell.name}>
        <span className="font-semibold">{info?.name ?? "AI"}</span>
        {!info?.available && <span className="text-shu-600">{info?.problem ?? t.shell.agentNone}</span>}
      </Row>
      {info?.command && (
        <Row label="command">
          <code className="truncate font-mono text-[12px] text-slate-600">{info.command}</code>
        </Row>
      )}
    </div>
  );
}

export function SettingsPage() {
  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[640px] space-y-4 px-6 py-6">
        <h2 className="text-lg font-bold">{t.shell.settings}</h2>
        <Section title={t.shell.workspaceSection}>
          <WorkspaceSection />
        </Section>
        <Section title={t.shell.displaySection}>
          <Row label={t.bar.language}>
            <LanguageSwitch />
          </Row>
          <Row label={t.bar.theme}>
            <ThemeSwitch />
          </Row>
        </Section>
        <Section title={t.shell.agentSection}>
          <AgentSection />
        </Section>
        <Section title={t.shell.aboutSection}>
          <AboutSection />
        </Section>
      </div>
    </div>
  );
}
