/**
 * How-to guide shown on the settings page.
 * The README How-to guide repeats these titles, paragraphs, steps, and commands.
 */

/** @typedef {{ kind: "p", text: string } | { kind: "steps", items: string[] } | { kind: "code", text: string }} HowToBlock */

/** @type {{ title: string, blocks: HowToBlock[] }[]} */
export const howToSections = [
  {
    title: "Connect the Android app",
    blocks: [
      {
        kind: "p",
        text: "Install the Android APK from the link on this page. The Google Play button stays hidden until a store link is set. A later Android build can show Public access On or Off. This page shows that state today.",
      },
      {
        kind: "p",
        text: "Tailscale is the safer way to connect the phone. Install Tailscale on the phone and sign in to the same Tailscale account as this PC. In the app, open http://<this-PC-tailscale-name>:<port>/ and sign in with the Drivebay username and password. You do not forward that port on the router.",
      },
      {
        kind: "p",
        text: "Regular mode, or Both with public access on, uses the local network or the public internet. On the same Wi-Fi, open http://<this PC local IP>:<port>/. From outside the network, open http://<public-ip>:<port>/ after the router forwards that port. In Both mode, turn Public access on first. While it is off, the phone sees a refusal page and no sign-in form.",
      },
    ],
  },
  {
    title: "Install Tailscale and sign in",
    blocks: [
      {
        kind: "p",
        text: "On this PC, setup can download the official Tailscale installer for Windows from pkgs.tailscale.com. Sign in, or create a free Tailscale account. You can also skip that step and install Tailscale later from https://tailscale.com/download/windows.",
      },
      {
        kind: "steps",
        items: [
          "On the PC, open Tailscale and click Sign in, or create a free account if you do not have one.",
          "Finish sign-in in the browser. Wait until this PC shows as connected.",
          "On the phone, install Tailscale and sign in to that same account.",
          "On the phone, open http://<this-PC-tailscale-name>:<port>/ and sign in to Drivebay.",
        ],
      },
    ],
  },
  {
    title: "The three ways other devices reach this PC",
    blocks: [
      {
        kind: "p",
        text: "Tailscale (Recommended) is the safer choice and the default. Nothing is opened to the internet. Only your own signed-in devices can reach Drivebay. You do not forward the port on the router.",
      },
      {
        kind: "p",
        text: "Tailscale + Local (Both) keeps Tailscale, and adds a public path you can turn on later. That path starts off. Drivebay still answers on Tailscale while public access is off.",
      },
      {
        kind: "p",
        text: "No Tailscale (Regular mode) exposes the port publicly. Other devices reach this PC only after the router forwards the port. Use a strong password. It is the lock for every drive on this PC.",
      },
    ],
  },
  {
    title: "Turn public access on and off",
    blocks: [
      {
        kind: "p",
        text: "Public access is only for Tailscale + Local (Both). Settings shows Public access: On or Public access: Off. A new install starts off.",
      },
      {
        kind: "p",
        text: "This PC and a signed-in device on Tailscale can turn it on or off. A public or other LAN address cannot change it, even after sign-in. The other server lock settings stay on this PC only.",
      },
      {
        kind: "p",
        text: "While public access is off, a browser that is not on this PC and not on Tailscale gets a refusal page and no sign-in form. While it is on, that browser gets the normal sign-in. Tailscale keeps working either way.",
      },
      {
        kind: "p",
        text: "When you turn it on, you can leave it on, or turn it off automatically after 1 hour, 4 hours, or 24 hours. The page shows the time it will turn off.",
      },
    ],
  },
  {
    title: "Forward the port on your router",
    blocks: [
      {
        kind: "p",
        text: "Regular mode and Both mode use these steps. Tailscale-only skips them. In Both, public access starts off, so the forward matters when you turn that path on.",
      },
      {
        kind: "steps",
        items: [
          "Find this PC's local IP. This page prints it when Regular or Both mode is on. If it is missing, run ipconfig and use the IPv4 address.",
          "Log in to the router. The page is usually http://192.168.0.1 or http://192.168.1.1.",
          "Add a port forward for TCP the Drivebay port to that local IP.",
          "Give this PC a reserved or static IP in the router's DHCP settings so the address does not change.",
          "Find the public IP. From outside the network, open http://<public-ip>:<port>/.",
          "If Windows Firewall asks, allow Drivebay or that TCP port as well.",
        ],
      },
      {
        kind: "p",
        text: "Some ISPs use CGNAT and block this. Tailscale is the easy fallback.",
      },
    ],
  },
  {
    title: "What each server lock option does",
    blocks: [
      {
        kind: "p",
        text: "Server lock is changed on this PC only. A phone, another computer, and the Android app can read the lock and cannot change it.",
      },
      {
        kind: "steps",
        items: [
          "Port from this page: when this is off, Settings cannot save a new port.",
          "Delete: when this is off, files cannot be deleted.",
          "Rename: when this is off, files and folders cannot be renamed.",
          "New folder: when this is off, new folders cannot be created.",
          "Upload: when this is off, uploads are blocked.",
          "Max upload (MB): the largest upload, from 1 to 8192 MB.",
          "All drives: every drive on this PC can be opened. Choose drives limits the list to the drives and folders you pick.",
        ],
      },
      {
        kind: "p",
        text: "Save server lock. Most changes take effect immediately. If the page asks you to restart, use Restart Drivebay.",
      },
    ],
  },
  {
    title: "Change the port and restart",
    blocks: [
      {
        kind: "p",
        text: "Pick Static to keep the same port every start, or Random to get a new port each start. A static port must be a free number from 1024 to 65535. The suggested port is 8765. Ports from 42000 to 42999 are left for Pinokio's Caddy.",
      },
      {
        kind: "p",
        text: "Save the port, then stop Drivebay and start it again. In Pinokio, stop it there and click Start. From the tray icon, restart the server. If you use Regular or Both, update the router forward to the new port.",
      },
    ],
  },
  {
    title: "Update Drivebay and uninstall",
    blocks: [
      {
        kind: "p",
        text: "To update, run the install command again. Drivebay stops, the program files are replaced, and the account, password, mode, and settings stay. A saved port outside 42000-42999 stays. A saved port in that range moves to 8765, or the next free port outside that range. Setup prints the new address and updates the firewall rule and the shortcut. It does not ask for a port, username, password, or Tailscale. The last line is Drivebay updated to 3.31.",
      },
      {
        kind: "p",
        text: "Paste this in PowerShell:",
      },
      {
        kind: "code",
        text: "irm https://raw.githubusercontent.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/main/install.ps1 | iex",
      },
      {
        kind: "p",
        text: "The .exe installer updates the same way when you run it again. The finish page says Drivebay updated to 3.31. In Pinokio, use Update.",
      },
      {
        kind: "p",
        text: "To uninstall, paste this in PowerShell:",
      },
      {
        kind: "code",
        text: "irm https://raw.githubusercontent.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/main/uninstall.ps1 | iex",
      },
      {
        kind: "p",
        text: "Uninstall stops Drivebay, removes shortcuts and the startup entry, and deletes the program files. It asks before deleting the saved password and settings. Type YES to delete them. Set DRIVEBAY_UNINSTALL_KEEP_DATA=1 to keep them, or DRIVEBAY_UNINSTALL_FORCE=1 to delete them without asking. The last line is Drivebay is uninstalled. If a Pinokio copy is still running, uninstall says so and leaves that copy running.",
      },
    ],
  },
  {
    title: "Common problems",
    blocks: [
      {
        kind: "p",
        text: "Port already in use. Setup names the program that holds the port. Pinokio's Caddy (z:\\pinokio\\bin\\miniforge\\Library\\bin\\caddy.exe) takes ports from 42000 to 42999 while Pinokio is running, even when Drivebay is not installed in Pinokio. Setup asks for a different port outside that range. The suggested port is 8765. The message can say That is a Pinokio copy of Drivebay. An update ignores this Drivebay when it still holds its own port. A saved port from 42000 to 42999 moves automatically. Any other saved port stays.",
      },
      {
        kind: "p",
        text: "Cannot reach this PC. On Tailscale, both devices must be signed in to the same account, and the phone must use http://<this-PC-tailscale-name>:<port>/. On Regular, the same Wi-Fi uses this PC's local IP, and outside the network uses the public IP after the router forward. Allow the port in Windows Firewall if Windows asks. In Both mode, a public or LAN address stays on the refusal page until public access is on.",
      },
      {
        kind: "p",
        text: "Some ISPs use CGNAT and block a router forward, so http://<public-ip>:<port>/ never opens. Tailscale is the easy fallback, because nothing is opened to the internet.",
      },
    ],
  },
];

/** Strings the README How-to guide must contain, in order. */
export function howToSyncLines() {
  const lines = ["How-to guide"];
  for (const section of howToSections) {
    lines.push(section.title);
    for (const block of section.blocks) {
      if (block.kind === "steps") lines.push(...block.items);
      else lines.push(block.text);
    }
  }
  return lines;
}
