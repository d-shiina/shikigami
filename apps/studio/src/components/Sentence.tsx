import type { Part } from "../lib/sentence";

/** A step's sentence, with the values it names as chips. */
export function Sentence({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) =>
        "text" in p ? (
          <span key={i}>{p.text}</span>
        ) : (
          <code key={i} className="mx-0.5 rounded bg-brand-50 px-1 font-mono text-[12.5px] text-brand-600">
            {p.code}
          </code>
        ),
      )}
    </>
  );
}
