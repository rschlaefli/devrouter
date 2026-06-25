// Trivial zero-dependency HTTP app. It echoes the WORKSPACE it was started with so
// you can see, in the browser/curl, which parallel instance answered a request.
const http = require("http");

const workspace = process.env.WORKSPACE || "unset";
const port = Number(process.env.PORT || 3000);

http
  .createServer((_req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end(`hello from devrouter workspace="${workspace}"\n`);
  })
  .listen(port, () => {
    console.log(`listening on ${port} (workspace=${workspace})`);
  });
