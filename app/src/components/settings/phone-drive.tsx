import { useEffect, useState } from "react";
import { toast } from "sonner";
import { forgetPhoneDrive, listPhoneDrives, mountPhoneDrive, remountPhoneDrive } from "@/lib/files/phone-drive.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** This PC only. The phone app has to be sharing folders first. */
export function PhoneDriveMount() {
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [letter, setLetter] = useState("Z");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [phones, setPhones] = useState<{ key: string; url: string; peer: string; seenAt: number }[]>([]);

  async function refresh() {
    try {
      const listed = await listPhoneDrives();
      setPhones(listed.phones);
    } catch {
      setPhones([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function mount() {
    setBusy(true);
    try {
      const next = await mountPhoneDrive({ data: { url: url.trim(), secret: secret.trim(), letter: letter.trim() } });
      setResult(next.message);
      if (next.ok) {
        toast.success("Phone mounted");
        setSecret("");
        await refresh();
      } else toast.error(next.message);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not mount the phone";
      setResult(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  async function remount(key: string) {
    setBusy(true);
    try {
      const next = await remountPhoneDrive({ data: { key, letter: letter.trim() } });
      setResult(next.message);
      if (next.ok) toast.success("Phone mounted");
      else toast.error(next.message);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not mount the phone";
      setResult(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  async function forget(key: string) {
    setBusy(true);
    try {
      await forgetPhoneDrive({ data: { key } });
      await refresh();
      toast.success("Forgot that phone");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not forget that phone";
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Mount phone as drive</p>
      <div className="space-y-3 rounded-md border border-border bg-bg-elevated p-4 text-sm">
        <p className="text-xs text-fg-muted">
          Turn on Phone as a drive in the Android app, pick the folders, and copy the token. This maps that phone on
          Tailscale or your LAN. It does not open the phone to the public internet.
        </p>
        <div className="space-y-1">
          <Label htmlFor="phone-url">Phone address</Label>
          <Input
            id="phone-url"
            value={url}
            placeholder="http://100.x.x.x:8780/"
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="phone-token">Token</Label>
          <Input
            id="phone-token"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="phone-letter">Windows drive letter</Label>
          <Input id="phone-letter" value={letter} onChange={(e) => setLetter(e.target.value)} className="w-20" />
        </div>
        {phones.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-fg-muted">Saved on this PC. The token stays here and is not shown again.</p>
            {phones.map((phone) => (
              <div key={phone.key} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 break-all text-xs text-fg">{phone.url}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void remount(phone.key)}
                >
                  Remount
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void forget(phone.key)}>
                  Forget
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        <Button type="button" disabled={busy || !url.trim() || secret.trim().length < 8} onClick={() => void mount()}>
          {busy ? "Mounting…" : "Mount phone as drive"}
        </Button>
        {result ? <p className="text-xs break-words text-fg-muted">{result}</p> : null}
      </div>
    </section>
  );
}
