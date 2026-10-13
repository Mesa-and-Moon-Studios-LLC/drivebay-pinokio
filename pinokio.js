module.exports = {
  version: "3.21",
  title: "Drivebay",
  description: "Password-locked file browser for every drive on this machine.",
  icon: "icon.png",
  menu: async (_kernel, info) => {
    const installed = info.exists("app/node_modules");
    const running = {
      install: info.running("install.js"),
      start: info.running("start.js"),
      update: info.running("update.js"),
      reset: info.running("reset.js"),
      port: info.running("port.js"),
    };

    if (running.install) {
      return [{ default: true, icon: "fa-solid fa-plug", text: "Installing", href: "install.js" }];
    }

    if (running.port) {
      return [{ default: true, icon: "fa-solid fa-ethernet", text: "Setting port", href: "port.js" }];
    }

    if (installed) {
      if (running.start) {
        const local = info.local("start.js");
        if (local && local.url) {
          const settings = String(local.url).indexOf("/settings") !== -1;
          return [
            {
              default: true,
              icon: settings ? "fa-solid fa-gear" : "fa-solid fa-folder-open",
              text: settings ? "Open settings" : "Open Drivebay",
              href: local.url,
            },
            { icon: "fa-solid fa-terminal", text: "Terminal", href: "start.js" },
          ];
        }
        return [{ default: true, icon: "fa-solid fa-terminal", text: "Terminal", href: "start.js" }];
      }

      if (running.update) {
        return [{ default: true, icon: "fa-solid fa-terminal", text: "Updating", href: "update.js" }];
      }

      if (running.reset) {
        return [{ default: true, icon: "fa-solid fa-terminal", text: "Resetting", href: "reset.js" }];
      }

      return [
        { default: true, icon: "fa-solid fa-power-off", text: "Start", href: "start.js" },
        { icon: "fa-solid fa-ethernet", text: "Set port", href: "port.js" },
        { icon: "fa-solid fa-rotate", text: "Update", href: "update.js" },
        { icon: "fa-solid fa-plug", text: "Reinstall", href: "install.js" },
        { icon: "fa-regular fa-circle-xmark", text: "Factory reset", href: "reset.js" },
      ];
    }

    return [{ default: true, icon: "fa-solid fa-plug", text: "Install", href: "install.js" }];
  },
};
