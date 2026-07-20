import { existsSync } from "node:fs";
import { resolve } from "node:path";

const indexPath = resolve("apps/web/dist/index.html");
if (!existsSync(indexPath)) {
  process.stderr.write(
    "Web build is missing. Run `npm run build` before `npm start`; deployment installs may then use `npm ci --omit=dev`.\n"
  );
  process.exitCode = 1;
}
