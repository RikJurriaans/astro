import type { AstroConfig, AstroIntegration } from "astro";
import ts from "typescript";

import { build, createFilter, type FilterPattern } from "vite";
import { qwikVite } from "@builder.io/qwik/optimizer";
import { getQwikLoaderScript } from "@builder.io/qwik/server";

import { join, normalize, relative } from "node:path";
import fs, { rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import fsExtra from "fs-extra";
import os from "os";

export type Options = Partial<{
  include: FilterPattern;
  exclude: FilterPattern;
}>;

export default function createIntegration(
  options: Options = {}
): AstroIntegration {
  let filter = createFilter(options.include, options.exclude);
  let distDir: string = "";
  let srcDir: string = "";
  let astroConfig: AstroConfig | null = null;
  let tempDir = join(distDir, ".tmp-" + hash());
  let entrypoints: Promise<string[]>;

  return {
    name: "@qwikdev/astro",
    hooks: {
      "astro:config:setup": async ({
        addRenderer,
        updateConfig,
        injectScript,
        config,
      }) => {
        // Update the global config
        astroConfig = config;
        // Retrieve Qwik files
        // from the project source directory
        srcDir = relative(
          astroConfig.root.pathname,
          astroConfig.srcDir.pathname
        );

        // used in server.ts for dev mode
        process.env.SRC_DIR = relative(
          astroConfig.root.pathname,
          astroConfig.srcDir.pathname
        );

        entrypoints = getQwikEntrypoints(srcDir, filter);
        if ((await entrypoints).length !== 0) {
          addRenderer({
            name: "@qwikdev/astro",
            serverEntrypoint: "@qwikdev/astro/server",
          });
          // Update the global dist directory relative
          // to the current project directory
          distDir = relative(
            astroConfig.root.pathname,
            astroConfig.outDir.pathname
          );
          // adds qwikLoader once (instead of per container)
          injectScript("head-inline", getQwikLoaderScript());
          updateConfig({
            vite: {
              build: {
                rollupOptions: {
                  output: {
                    inlineDynamicImports: false,
                  },
                },
              },
              outDir: astroConfig.outDir.pathname,
              plugins: [
                qwikVite({
                  devSsrServer: false,
                  entryStrategy: {
                    type: "smart",
                  },
                  srcDir,
                  client: {
                    /* In order to make a client build, we need to know
                      all of the entry points to the application so
                      that we can generate the manifest. 
                    */
                    input: await entrypoints,
                    outDir: distDir,
                  },
                  ssr: {
                    input: "@qwikdev/astro/server",
                  },
                }),
              ],
            },
          });
        }
      },
      "astro:config:done": async ({ config }) => {
        astroConfig = config;
      },
      "astro:build:start": async ({ logger }) => {
        logger.info("astro:build:start");
        if ((await entrypoints).length > 0) {
          await build({ ...astroConfig?.vite });
          await moveArtifacts(distDir, tempDir);
        } else {
          logger.info("No entrypoints found. Skipping build.");
        }
      },
      "astro:build:done": async ({ logger }) => {
        if ((await entrypoints).length > 0 && astroConfig) {
          const outputPath =
            astroConfig.output === "server"
              ? astroConfig.build.client.pathname
              : astroConfig.outDir.pathname;

          let normalizedPath = normalize(outputPath);
          process.env.Q_BASE = normalizedPath;

          // checks all windows platforms and removes drive ex: C:\\
          if (os.platform() === "win32") {
            normalizedPath = normalizedPath.substring(3);
          }

          await moveArtifacts(tempDir, normalizedPath);
          // remove the temp dir folder
          rmSync(tempDir, { recursive: true });
        } else {
          logger.info("Build finished. No artifacts moved.");
        }
      },
    },
  };
}

function hash() {
  return Math.random().toString(26).split(".").pop();
}

async function moveArtifacts(srcDir: string, destDir: string) {
  // Ensure the destination dir exists, create if not
  await fsExtra.ensureDir(destDir);
  for (const file of await readdir(srcDir)) {
    // move files from source to destintation, overwrite if they exist
    await fsExtra.move(join(srcDir, file), join(destDir, file), {
      overwrite: true,
    });
  }
}

async function crawlDirectory(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  const files = await Promise.all(
    entries.map((entry) => {
      const fullPath = join(dir, entry.name);
      return entry.isDirectory() ? crawlDirectory(fullPath) : fullPath;
    })
  );

  // flatten files array
  return files.flat();
}

/**
 *
 * We need to find the Qwik entrypoints so that the client build will run successfully.
 *
 */
async function getQwikEntrypoints(
  dir: string,
  filter: (id: unknown) => boolean
): Promise<string[]> {
  const files = await crawlDirectory(dir);
  const qwikFiles = [];

  for (const file of files) {
    // Skip files not matching patterns w/ astro config include & exclude
    if (!filter(file)) {
      continue;
    }

    const fileContent = fs.readFileSync(file, "utf-8");
    const sourceFile = ts.createSourceFile(
      file,
      fileContent,
      ts.ScriptTarget.ESNext,
      true
    );

    let qwikImportFound = false;

    ts.forEachChild(sourceFile, function nodeVisitor(node) {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        if (node.moduleSpecifier.text === "@builder.io/qwik") {
          qwikImportFound = true;
        }
      }

      if (!qwikImportFound) {
        ts.forEachChild(node, nodeVisitor);
      }
    });

    if (qwikImportFound) {
      qwikFiles.push(file);
    }
  }

  return qwikFiles;
}
