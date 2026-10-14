module.exports = {
  run: [
    {
      method: "input",
      params: {
        title: "Drivebay port",
        description:
          "Static keeps the same port every Start (easier to forward). Random lets Pinokio pick a new one each time.",
        form: [
          {
            type: "select",
            key: "style",
            title: "Port style",
            items: [
              { value: "static", text: "Static — I pick the port" },
              { value: "random", text: "Random — new port each Start" },
            ],
            default: "static",
          },
          {
            key: "port",
            title: "Port number (static only)",
            description: "Ignored if you chose Random. Suggested: 8765. Avoid 42000-42999 while Pinokio is running.",
            default: "8765",
          },
        ],
      },
    },
    {
      method: "shell.run",
      params: {
        message: "node save-port.cjs",
        env: {
          DRIVEBAY_PORT_STYLE: "{{input.style}}",
          DRIVEBAY_PORT: "{{input.port}}",
        },
      },
    },
    {
      method: "shell.run",
      params: {
        path: "app",
        message: "npm install",
      },
    },
    {
      method: "notify",
      params: {
        html: "Drivebay installed. Click <b>Start</b>. Change this later with <b>Set port</b>.",
      },
    },
  ],
};
