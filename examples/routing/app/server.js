const http = require("node:http");

const port = Number(process.env.PORT || "3000");
const instance = process.env.APP_INSTANCE || "unknown";
const dbUrl = process.env.DATABASE_URL || "";

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    json(res, 400, { error: "Missing URL." });
    return;
  }

  if (req.url === "/healthz") {
    json(res, 200, { ok: true, instance, port });
    return;
  }

  json(res, 200, {
    ok: true,
    app: "devrouter-routing",
    instance,
    port,
    dbConfigured: dbUrl.length > 0,
    timestamp: new Date().toISOString(),
  });
});

server.listen(port, () => {
  process.stdout.write(`[devrouter-routing] ${instance} listening on ${port}\n`);
});
