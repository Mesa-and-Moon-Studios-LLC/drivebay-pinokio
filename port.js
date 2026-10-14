module.exports = {
  run: [
    {
      method: "input",
      params: {
        title: "Change Drivebay port",
        description:
          "Stop Drivebay first if it is running. Static = same port every time. Random = Pinokio picks one each Start.",
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
      method: "notify",
      params: {
        html: "Saved. Click <b>Start</b> again.",
      },
    },
  ],
};
