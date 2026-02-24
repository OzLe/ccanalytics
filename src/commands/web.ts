/**
 * @module commands/web
 *
 * CLI command: `ccanalytics web`
 *
 * Launches the web analytics dashboard by starting both the Express API
 * server and the Vite frontend server (dev or preview mode). Handles
 * graceful shutdown of both child processes on SIGINT/SIGTERM.
 *
 * Usage:
 *   ccanalytics web               # Start API + Vite preview (production build)
 *   ccanalytics web --dev         # Start API + Vite dev server (hot reload)
 *   ccanalytics web --port 8080   # Custom Vite port
 *   ccanalytics web --no-open     # Skip auto-opening browser
 *   ccanalytics web --api-only    # Only start the API server
 */

import { Command } from "commander";

/**
 * Register the `web` subcommand on the parent program.
 *
 * Spawns two child processes:
 *   1. Express API server (`npm run server` in dashboard/)
 *   2. Vite dev or preview server (`npm run dev` or `npm run preview`)
 *
 * @param parent - The parent Commander program
 */
export function registerWebCommand(parent: Command): void {
  parent
    .command("web")
    .description("Launch the web analytics dashboard")
    .option("--port <number>", "Vite dev/preview server port", "5173")
    .option("--api-port <number>", "API server port", "3001")
    .option("--no-open", "Do not open browser automatically")
    .option("--dev", "Run in development mode with hot reload", false)
    .option("--api-only", "Only start the API server (no frontend)", false)
    .action(async (options) => {
      const { resolve, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const { spawn } = await import("node:child_process");
      type ChildProcess = import("node:child_process").ChildProcess;
      const { existsSync } = await import("node:fs");
      const { platform } = await import("node:os");

      // -----------------------------------------------------------------------
      // Resolve dashboard directory relative to the CLI source
      // -----------------------------------------------------------------------
      // In CJS bundles (dist/cli.cjs), import.meta.url is undefined, so fall
      // back to the global __dirname / __filename that CJS provides.
      let currentDir: string;
      if (typeof import.meta.url === "string") {
        currentDir = dirname(fileURLToPath(import.meta.url));
      } else if (typeof __dirname !== "undefined") {
        currentDir = __dirname;
      } else {
        currentDir = process.cwd();
      }
      // In source: src/commands/web.ts -> package root is ../..
      // In dist:   dist/cli.cjs        -> package root is ..
      // We try both and pick whichever contains dashboard/
      let packageRoot = resolve(currentDir, "../..");
      let dashboardDir = resolve(packageRoot, "dashboard");

      if (!existsSync(dashboardDir)) {
        packageRoot = resolve(currentDir, "..");
        dashboardDir = resolve(packageRoot, "dashboard");
      }

      if (!existsSync(dashboardDir)) {
        console.error("Error: Dashboard directory not found.");
        console.error("Searched in:");
        console.error(`  ${resolve(currentDir, "../..", "dashboard")}`);
        console.error(`  ${resolve(currentDir, "..", "dashboard")}`);
        console.error("");
        console.error("Make sure you are running ccanalytics from the project root,");
        console.error("or that the dashboard/ directory is included in the package.");
        process.exit(1);
      }

      const port = options.port as string;
      const apiPort = options.apiPort as string;
      const shouldOpen = options.open as boolean;
      const isDev = options.dev as boolean;
      const apiOnly = options.apiOnly as boolean;

      // -----------------------------------------------------------------------
      // Track child processes for cleanup
      // -----------------------------------------------------------------------
      const children: ChildProcess[] = [];
      let shuttingDown = false;

      function killAll() {
        if (shuttingDown) return;
        shuttingDown = true;

        console.log("\nShutting down...");
        for (const child of children) {
          if (child.pid && !child.killed) {
            // Kill the process group to ensure npm-spawned children also die
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {
              // If process group kill fails, try direct kill
              child.kill("SIGTERM");
            }
          }
        }

        // Force exit after 5 seconds if processes haven't stopped
        setTimeout(() => {
          console.log("Force exiting...");
          process.exit(1);
        }, 5000).unref();
      }

      process.on("SIGINT", killAll);
      process.on("SIGTERM", killAll);

      // -----------------------------------------------------------------------
      // 1. Start Express API server
      // -----------------------------------------------------------------------
      console.log("");
      console.log("  ccanalytics web");
      console.log("  " + "=".repeat(50));
      console.log("");

      console.log(`  Starting API server on port ${apiPort}...`);

      const apiProcess = spawn("npm", ["run", "server"], {
        cwd: dashboardDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PORT: apiPort },
        detached: true,
      });

      children.push(apiProcess);

      apiProcess.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          console.log(`  [api] ${line}`);
        }
      });

      apiProcess.stderr?.on("data", (data: Buffer) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          // Filter out npm lifecycle noise
          if (!line.includes("npm warn") && line.trim()) {
            console.error(`  [api] ${line}`);
          }
        }
      });

      apiProcess.on("exit", (code) => {
        if (!shuttingDown) {
          console.error(`  [api] API server exited with code ${code}`);
          killAll();
        }
      });

      // -----------------------------------------------------------------------
      // 2. Start Vite frontend server (unless --api-only)
      // -----------------------------------------------------------------------
      let frontendUrl = "";

      if (!apiOnly) {
        // Check if production build exists for preview mode
        const distDir = resolve(dashboardDir, "dist");
        const hasProductionBuild = existsSync(distDir);

        let frontendCommand: string[];
        if (isDev) {
          frontendCommand = ["run", "dev", "--", "--port", port];
          console.log(`  Starting Vite dev server on port ${port}...`);
        } else if (hasProductionBuild) {
          frontendCommand = ["run", "preview", "--", "--port", port];
          console.log(`  Starting Vite preview server on port ${port}...`);
        } else {
          console.log("  No production build found. Starting Vite dev server...");
          console.log(`  (Run 'cd dashboard && npm run build' for production mode)`);
          frontendCommand = ["run", "dev", "--", "--port", port];
        }

        frontendUrl = `http://localhost:${port}`;

        const viteProcess = spawn("npm", frontendCommand, {
          cwd: dashboardDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
          detached: true,
        });

        children.push(viteProcess);

        viteProcess.stdout?.on("data", (data: Buffer) => {
          const lines = data.toString().trim().split("\n");
          for (const line of lines) {
            console.log(`  [web] ${line}`);
          }
        });

        viteProcess.stderr?.on("data", (data: Buffer) => {
          const lines = data.toString().trim().split("\n");
          for (const line of lines) {
            if (!line.includes("npm warn") && line.trim()) {
              console.error(`  [web] ${line}`);
            }
          }
        });

        viteProcess.on("exit", (code) => {
          if (!shuttingDown) {
            console.error(`  [web] Vite server exited with code ${code}`);
            killAll();
          }
        });
      }

      // -----------------------------------------------------------------------
      // 3. Print summary and open browser
      // -----------------------------------------------------------------------
      // Give servers a moment to start before printing summary
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));

      if (!shuttingDown) {
        console.log("");
        console.log("  " + "-".repeat(50));
        console.log(`  API server:       http://localhost:${apiPort}`);
        if (!apiOnly) {
          console.log(`  Dashboard:        ${frontendUrl}`);
        }
        console.log("  " + "-".repeat(50));
        console.log("  Press Ctrl+C to stop");
        console.log("");

        // Open browser
        if (shouldOpen && !apiOnly && frontendUrl) {
          const os = platform();
          let openCommand: string;
          let openArgs: string[];

          if (os === "darwin") {
            openCommand = "open";
            openArgs = [frontendUrl];
          } else if (os === "win32") {
            openCommand = "cmd";
            openArgs = ["/c", "start", frontendUrl];
          } else {
            // Linux and others
            openCommand = "xdg-open";
            openArgs = [frontendUrl];
          }

          try {
            const browserProcess = spawn(openCommand, openArgs, {
              stdio: "ignore",
              detached: true,
            });
            browserProcess.unref();
          } catch {
            // Silently ignore if we can't open the browser
          }
        }
      }

      // -----------------------------------------------------------------------
      // 4. Keep the process alive until interrupted
      // -----------------------------------------------------------------------
      // The process stays alive because the child processes have piped stdio.
      // We just need to wait for a shutdown signal.
      await new Promise<void>(() => {
        // This promise intentionally never resolves.
        // The process will exit via killAll() on SIGINT/SIGTERM.
      });
    });
}
