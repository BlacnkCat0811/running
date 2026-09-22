import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

const assetExtension = /\.(?:js|css|png|jpe?g|webp|svg|ico|woff2?)$/i;
const spaPath = /^(?:\/(?:workouts(?:\/[^/.]+)?|zones|statistics|trends|predictions|data(?:\/audit)?|settings|more|week|body|ios)?)\/?$/;

/** Routes close over known build files; user paths are never passed to sendFile. */
export async function registerWebAssets(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, { root, serve: false, dotfiles: "deny" });
  const rootEntries = await readdir(root, { withFileTypes: true });
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || !/^[\w.-]+$/.test(entry.name)) continue;
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && assetExtension.test(entry.name)) {
        app.get(`/${file}`, async (_request, reply) => reply.sendFile(file));
      }
    }
  };
  if (rootEntries.some((entry) => entry.name === "assets" && entry.isDirectory())) await walk("assets");
  const favicon = rootEntries.find((entry) => entry.name === "favicon.ico" && entry.isFile());
  app.get("/favicon.ico", async (_request, reply) => favicon
    ? reply.sendFile("favicon.ico") : reply.code(204).send());
  if (!rootEntries.some((entry) => entry.name === "index.html" && entry.isFile())) return;
  app.get("/index.html", async (_request, reply) => reply.sendFile("index.html"));
  app.get("/*", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? "";
    if (!spaPath.test(path) || /[%\\\x00-\x1f]/.test(path)) {
      return reply.code(404).send({ code: "not_found", message: "未找到页面" });
    }
    return reply.sendFile("index.html");
  });
}
