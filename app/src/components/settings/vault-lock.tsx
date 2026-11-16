import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setupLinkedVault, unlockLinkedVault } from "@/lib/files/linked-machines.functions";
import { CANNOT_RECOVER_MESSAGE } from "@/lib/files/linked-copy.mjs";
import { signinBridgeUrl } from "@/lib/files/mesa-signin.mjs";

type Vault = {
  ready?: boolean;
  unlocked?: boolean;
  hasPassphrase?: boolean;
  hasPasskey?: boolean;
  hasRecovery?: boolean;
  cannotRecover?: string;
};

type Config = { authDomain?: string; signinBridge?: string; ready?: boolean };

function passkeyUrl(config: Config, action: "create" | "get", state: string) {
  const bridge = signinBridgeUrl(config).replace(/drivebay-signin\.html$/, "drivebay-passkey.html");
  if (!bridge) return "";
  const url = new URL(bridge);
  url.searchParams.set("action", action);
  url.searchParams.set("state", state);
  url.searchParams.set("return", `${window.location.origin}/settings`);
  return url.toString();
}

async function requestPrf(config: Config, action: "create" | "get"): Promise<{ prfOutput: string; credentialId: string; prfSalt?: string } | null> {
  const state = `${action}-${crypto.randomUUID()}`;
  const url = passkeyUrl(config, action, state);
  if (!url) {
    toast.error("The passkey page is not published yet. You can still use a passphrase.");
    return null;
  }
  return new Promise((resolve) => {
    const popup = window.open(url, "drivebay-passkey", "width=480,height=640");
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, 180_000);
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || data.type !== "drivebay-prf" || data.state !== state) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      popup?.close();
      if (!data.prfOutput) {
        resolve(null);
        return;
      }
      resolve({ prfOutput: String(data.prfOutput), credentialId: String(data.credentialId || ""), prfSalt: data.prfSalt });
    }
    window.addEventListener("message", onMessage);
  });
}

export function VaultLock({
  vault,
  config,
  signedIn,
  onDone,
}: {
  vault?: Vault | null;
  config?: Config;
  signedIn: boolean;
  onDone: () => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [shownKey, setShownKey] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [usePasskey, setUsePasskey] = useState(false);

  if (!signedIn) return null;

  if (shownKey) {
    return (
      <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3" data-testid="vault-recovery-key">
        <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Recovery key</p>
        <p className="text-sm text-fg">Write this recovery key down now. Drivebay will not show it again.</p>
        <p className="break-all font-mono text-lg tracking-wide text-fg" data-testid="vault-recovery-key-value">
          {shownKey}
        </p>
        <p className="text-xs text-fg-muted">{CANNOT_RECOVER_MESSAGE}</p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={ack} onChange={(event) => setAck(event.target.checked)} />
          <span>I have saved this recovery key in a safe place.</span>
        </label>
        <Button
          type="button"
          size="sm"
          disabled={!ack}
          onClick={() => {
            setShownKey("");
            setAck(false);
            onDone();
          }}
        >
          I saved the recovery key
        </Button>
      </div>
    );
  }

  if (vault?.ready && vault.unlocked) {
    return (
      <div className="space-y-1 rounded-lg border border-border p-3">
        <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Locked machine list</p>
        <p className="text-xs text-fg-muted">
          This device can read the machine list. Mesa and Moon only holds data it cannot read.
          {vault.hasPasskey ? " A passkey is set." : ""}
        </p>
      </div>
    );
  }

  if (vault?.ready && !vault.unlocked) {
    return (
      <div className="space-y-3 rounded-lg border border-border p-3" data-testid="vault-unlock">
        <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Unlock the machine list</p>
        <p className="text-xs text-fg-muted">{vault.cannotRecover || CANNOT_RECOVER_MESSAGE}</p>
        <div className="space-y-1">
          <Label htmlFor="vault-unlock-pass">Passphrase or recovery key</Label>
          <Input id="vault-unlock-pass" type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy || passphrase.length < 8}
            onClick={() => {
              setBusy(true);
              const looksLikeKey = /^[A-Za-z0-9-]{20,}$/.test(passphrase.replace(/\s/g, "")) && passphrase.includes("-");
              void unlockLinkedVault({
                data: looksLikeKey ? { recoveryKey: passphrase } : { passphrase },
              })
                .then((result) => {
                  if (result.ok) {
                    toast.success(result.message);
                    onDone();
                  } else toast.error(result.message);
                })
                .finally(() => setBusy(false));
            }}
          >
            Unlock
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void requestPrf(config || {}, "get")
                .then((prf) => {
                  if (!prf) {
                    toast.error("Passkey was not available. Use the passphrase or recovery key.");
                    return;
                  }
                  return unlockLinkedVault({ data: { prfOutput: prf.prfOutput, wrapId: undefined } });
                })
                .then((result) => {
                  if (!result) return;
                  if (result.ok) {
                    toast.success(result.message);
                    onDone();
                  } else toast.error(result.message);
                })
                .finally(() => setBusy(false));
            }}
          >
            Unlock with a passkey
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="vault-setup">
      <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Lock the machine list</p>
      <p className="text-sm text-fg">
        Before Drivebay keeps this computer on your account, set a passphrase. Your devices will encrypt the machine
        list with it, so Mesa and Moon only holds data it cannot read.
      </p>
      <p className="text-xs text-fg-muted">{CANNOT_RECOVER_MESSAGE}</p>
      <div className="space-y-1">
        <Label htmlFor="vault-pass">Recovery passphrase</Label>
        <Input id="vault-pass" type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="vault-pass-2">Type it again</Label>
        <Input id="vault-pass-2" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={usePasskey} onChange={(event) => setUsePasskey(event.target.checked)} />
        <span>Also save a passkey on this device (iCloud Keychain, Google Password Manager, or Windows Hello). The passphrase stays as the backup.</span>
      </label>
      <Button
        type="button"
        size="sm"
        disabled={busy || passphrase.length < 8 || passphrase !== confirm}
        onClick={() => {
          setBusy(true);
          void (async () => {
            let prf: { prfOutput: string; credentialId: string; prfSalt?: string } | null = null;
            if (usePasskey) {
              prf = await requestPrf(config || {}, "create");
              if (!prf) toast.error("Passkey was not created. The list will still lock with the passphrase.");
            }
            const result = await setupLinkedVault({
              data: {
                passphrase,
                prfOutput: prf?.prfOutput,
                credentialId: prf?.credentialId,
                prfSalt: prf?.prfSalt,
              },
            });
            if (result.ok) {
              setPassphrase("");
              setConfirm("");
              setShownKey(result.recoveryKey);
              toast.success("The machine list is locked.");
            } else toast.error(result.message);
          })().finally(() => setBusy(false));
        }}
      >
        Lock the machine list
      </Button>
    </div>
  );
}
