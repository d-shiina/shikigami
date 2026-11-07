// An AI reply drawn from its Markdown. Everything is built as React elements
// from the tree in lib/markdown.ts (never as HTML), and a link opens only an
// http(s) page in the person's own browser, never inside Studio.
import { Check, Copy } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { agent } from "../lib/api";
import { t } from "../lib/i18n";
import { type Block, type Inline, parseMarkdown } from "../lib/markdown";

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="md min-w-0 space-y-2 text-[13px] leading-relaxed text-ink">{blocks.map(block)}</div>;
}

function block(b: Block, key: number): ReactNode {
  switch (b.kind) {
    case "heading": {
      const size = b.level === 1 ? "text-[15px]" : b.level === 2 ? "text-[14px]" : "text-[13px]";
      return (
        <div key={key} role="heading" aria-level={b.level} className={`${size} pt-1 font-semibold leading-snug text-ink`}>
          {inlines(b.children)}
        </div>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="break-words">
          {inlines(b.children)}
        </p>
      );
    case "code":
      return <CodeBlock key={key} lang={b.lang} text={b.text} />;
    case "list": {
      const items = b.items.map((item, i) => (
        <li key={i} className={item.task === null ? "pl-0.5" : "-ml-4 flex list-none items-start gap-1.5"}>
          {item.task !== null && (
            <span
              aria-hidden
              className={`mt-[4px] grid h-3 w-3 shrink-0 place-items-center rounded-[3px] border ${item.task ? "border-brand-500 bg-brand-500 text-on-primary" : "border-slate-300 bg-sheet"}`}
            >
              {item.task && <Check size={9} strokeWidth={3} />}
            </span>
          )}
          <div className="min-w-0 space-y-1">{item.children.map(block)}</div>
        </li>
      ));
      return b.ordered ? (
        <ol key={key} start={b.start} className="list-decimal space-y-0.5 pl-5 marker:text-slate-500">
          {items}
        </ol>
      ) : (
        <ul key={key} className="list-disc space-y-0.5 pl-5 marker:text-slate-400">
          {items}
        </ul>
      );
    }
    case "quote":
      return (
        <blockquote key={key} className="space-y-1.5 border-l-2 border-slate-300 pl-3 text-slate-600">
          {b.children.map(block)}
        </blockquote>
      );
    case "table":
      return (
        <div key={key} className="overflow-x-auto rounded-md border border-slate-200">
          <table className="w-full border-collapse text-[12px]">
            <thead className="bg-slate-50">
              <tr>
                {b.head.map((cell, i) => (
                  <th key={i} style={{ textAlign: b.align[i] ?? "left" }} className="border-b border-slate-200 px-2 py-1 font-semibold whitespace-nowrap text-slate-700">
                    {inlines(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r} className="border-t border-slate-200 first:border-t-0">
                  {row.map((cell, i) => (
                    <td key={i} style={{ textAlign: b.align[i] ?? "left" }} className="px-2 py-1 align-top">
                      {inlines(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr key={key} className="border-slate-200" />;
  }
}

function inlines(nodes: Inline[]): ReactNode[] {
  return nodes.map(inline);
}

function inline(n: Inline, key: number): ReactNode {
  switch (n.kind) {
    case "text":
      return n.text;
    case "break":
      return <br key={key} />;
    case "code":
      return (
        <code key={key} className="rounded-[4px] border border-slate-200 bg-slate-50 px-1 py-px font-mono text-[0.88em] break-all text-slate-700">
          {n.text}
        </code>
      );
    case "strong":
      return (
        <strong key={key} className="font-semibold">
          {inlines(n.children)}
        </strong>
      );
    case "em":
      return (
        <em key={key} className="italic">
          {inlines(n.children)}
        </em>
      );
    case "del":
      return (
        <del key={key} className="text-slate-500">
          {inlines(n.children)}
        </del>
      );
    case "link":
      return (
        <a
          key={key}
          href={n.href}
          title={n.href}
          rel="noreferrer noopener"
          className="break-all text-brand-600 underline decoration-brand-300 underline-offset-2 hover:decoration-brand-600"
          // Studio's own window never goes to the page: the system browser does.
          onClick={(e) => {
            e.preventDefault();
            void agent.openLink(n.href).catch(() => {});
          }}
        >
          {inlines(n.children)}
        </a>
      );
  }
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Nothing to tell: the text is still there to select.
    }
  };
  return (
    <div className="group relative min-w-0 rounded-md border border-slate-200 bg-paper">
      <div className="flex h-6 items-center justify-between border-b border-slate-200 pr-1 pl-2.5 text-[10.5px] text-slate-500">
        <span className="font-mono">{lang}</span>
        <button
          type="button"
          onClick={() => void copy()}
          title={t.agent.copyCode}
          aria-label={t.agent.copyCode}
          className="flex h-5 items-center gap-1 rounded px-1.5 text-slate-500 hover:bg-slate-100 hover:text-ink"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t.agent.copiedCode : t.agent.copyCode}
        </button>
      </div>
      <pre className="overflow-x-auto px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] text-slate-700">
        <code>{text}</code>
      </pre>
    </div>
  );
}
