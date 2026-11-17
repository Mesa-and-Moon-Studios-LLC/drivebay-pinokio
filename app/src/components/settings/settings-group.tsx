import type { ReactNode } from "react";

export const SETTINGS_GROUPS = [
  { id: "account", label: "Account" },
  { id: "edition", label: "Edition" },
  { id: "this-machine", label: "This machine" },
  { id: "my-machines", label: "My machines" },
  { id: "sharing", label: "Sharing with others" },
  { id: "updates", label: "Updates" },
  { id: "advanced", label: "Advanced" },
] as const;

export function SettingsNav() {
  return (
    <nav aria-label="Settings sections" className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-muted">
      {SETTINGS_GROUPS.map((group) => (
        <a key={group.id} href={`#${group.id}`} className="underline-offset-4 hover:text-fg hover:underline">
          {group.label}
        </a>
      ))}
    </nav>
  );
}

export function SettingsGroup({
  id,
  title,
  hint,
  children,
}: {
  id: (typeof SETTINGS_GROUPS)[number]["id"];
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-16 space-y-4" aria-labelledby={`${id}-title`}>
      <div className="border-b border-border pb-2">
        <h2 id={`${id}-title`} className="text-lg font-medium text-fg">
          {title}
        </h2>
        {hint ? <p className="mt-1 text-xs text-fg-muted">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** A collapsed block for things most people never open. */
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group rounded-md border border-border bg-bg-elevated">
      <summary className="cursor-pointer list-none px-4 py-3 text-sm text-fg marker:hidden">
        <span className="mr-2 inline-block text-fg-muted transition-transform group-open:rotate-90">›</span>
        {title}
      </summary>
      <div className="space-y-3 border-t border-border p-4">{children}</div>
    </details>
  );
}
