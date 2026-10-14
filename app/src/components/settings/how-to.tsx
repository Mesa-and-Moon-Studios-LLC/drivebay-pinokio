import { howToSections } from "@/lib/files/howto.mjs";

export function HowToGuide() {
  return (
    <section className="space-y-3">
      <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">How-to guide</p>
      <div className="space-y-2">
        {howToSections.map((section) => (
          <details key={section.title} className="rounded-md border border-border bg-bg-elevated px-4 py-3">
            <summary className="cursor-pointer text-sm text-fg">{section.title}</summary>
            <div className="mt-3 space-y-2 text-xs leading-relaxed text-fg-muted">
              {section.blocks.map((block, index) => {
                if (block.kind === "steps") {
                  return (
                    <ol key={index} className="list-decimal space-y-1 pl-5">
                      {block.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ol>
                  );
                }
                if (block.kind === "code") {
                  return (
                    <p key={block.text} className="break-all font-mono text-[11px] text-fg">
                      {block.text}
                    </p>
                  );
                }
                return <p key={block.text}>{block.text}</p>;
              })}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
