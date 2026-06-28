const http = require("http");

const workspace = process.env.WORKSPACE || "unset";
const port = Number(process.env.PORT || 3000);

http
  .createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, workspace, port }) + "\n");
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`devcontainer example listening on ${port} (workspace=${workspace})`);
  });
