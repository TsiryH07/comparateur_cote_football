import { createServer } from "node:http";

const PORT: number = 3000;

const server = createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end("Bonjour depuis Node.js + TypeScript !");
});

server.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});