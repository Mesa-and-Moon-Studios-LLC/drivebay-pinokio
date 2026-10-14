import { useEffect, useId, useRef, useState } from "react";
import { donateLinks } from "@/lib/donate.mjs";
import { Button } from "@/components/ui/button";

export function DonateMenu() {
  const links = donateLinks();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (links.length === 0) return null;

  return (
    <section className="space-y-3">
      <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Support Drivebay</p>
      <div className="rounded-md border border-border bg-bg-elevated p-4">
        <p className="text-xs text-fg-muted">GitHub Sponsors, PayPal, or Ko-fi.</p>
        <div className="relative mt-3" ref={rootRef}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={open}
            aria-haspopup="menu"
            aria-controls={menuId}
            onClick={() => setOpen((value) => !value)}
          >
            Donate
          </Button>
          {open ? (
            <div
              id={menuId}
              role="menu"
              className="absolute left-0 z-20 mt-1 min-w-44 rounded-md border border-border bg-bg p-1 shadow-sm"
            >
              {links.map((link) => (
                <a
                  key={link.label}
                  role="menuitem"
                  href={link.url}
                  target="_blank"
                  rel="noopener"
                  className="block rounded-sm px-2.5 py-1.5 text-sm text-fg hover:bg-bg-subtle"
                  onClick={() => setOpen(false)}
                >
                  {link.label}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
