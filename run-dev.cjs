const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

/** Windows opens settings on this PC. Other platforms still open the file browser. */
function readyLine(port, platform) {
  const base = "http://127.0.0.1:" + port;
  if (platform === "win32") return "Drivebay ready " + base + "/settings";
  return "Drivebay ready " + base + "/";
}

function announceWhenReady(port) {
  const line = readyLine(port, process.platform);
  const deadline = Date.now() + 90_000;
  const retry = () => {
    if (Date.now() >= deadline) {
      console.log(line);
      return;
    }
    setTimeout(probe, 300);
  };
  const probe = () => {
    const req = http.get(
      { hostname: "127.0.0.1", port: Number(port), path: "/login", timeout: 1500 },
      (res) => {
        res.resume();
        if (res.statusCode === 200) {
          console.log(line);
          return;
        }
        retry();
      },
    );
    req.on("error", retry);
    req.on("timeout", () => {
      req.destroy();
      retry();
    });
  };
  probe();
}

function main() {
  const portFile = path.join(__dirname, "drivebay.port");
  let mode = "random";
  let port = String(process.env.DRIVEBAY_FALLBACK_PORT || process.env.PORT || "42013").trim();

  if (fs.existsSync(portFile)) {
    const raw = fs.readFileSync(portFile, "utf8").trim().toLowerCase();
    if (raw === "random") {
      mode = "random";
    } else if (/^\d{2,5}$/.test(raw)) {
      mode = "static";
      port = raw;
    }
  }

  console.log(
    mode === "static"
      ? "Drivebay static port: " + port
      : "Drivebay random port: " + port,
  );

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(
    `${npmCmd} run dev -- --host 0.0.0.0 --port ${port}`,
    {
      cwd: path.join(__dirname, "app"),
      stdio: "inherit",
      env: {
        ...process.env,
        DRIVEBAY_PINOKIO: process.env.DRIVEBAY_PINOKIO || "true",
        DRIVEBAY_DATA_DIR: path.join(__dirname, "data"),
        DRIVEBAY_PORT_FILE: path.join(__dirname, "drivebay.port"),
      },
      shell: true,
    },
  );
  announceWhenReady(port);
  child.on("exit", (code) => process.exit(code == null ? 0 : code));
}

module.exports = { readyLine };

if (require.main === module) {
  main();
}
