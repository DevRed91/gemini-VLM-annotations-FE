// Node module-customization hooks for tests that must load src/utils/*.ts:
//  - resolve extensionless relative imports ("./obb") to .ts
//  - alias @sparkjsdev/spark to a tiny fake (no WebGL in node)
//  - fully transpile .ts with TypeScript (strip-only mode rejects parameter properties)
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const FAKE_SPARK = new URL("./fakeSpark.ts", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "@sparkjsdev/spark") return next(FAKE_SPARK, context);
  if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) {
    try { return await next(specifier + ".ts", context); } catch { /* fall through */ }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith("file:") && url.endsWith(".ts") && !url.includes("/node_modules/")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    const { outputText } = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, useDefineForClassFields: true },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  }
  return next(url, context);
}
