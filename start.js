module.exports = {
  daemon: true,
  run: [
    {
      method: "shell.run",
      params: {
        env: {
          VITE_AUTH_ENABLED: "true",
          DRIVEBAY_PINOKIO: "true",
          DRIVEBAY_FALLBACK_PORT: "{{port}}",
        },
        message: "node run-dev.cjs",
        on: [
          {
            event: "/Drivebay ready (http:\\/\\/[0-9A-Za-z.:]+(?:\\/settings)?)/",
            done: true,
          },
        ],
      },
    },
    {
      method: "local.set",
      params: {
        url: "{{input.event[1]}}",
      },
    },
  ],
};
