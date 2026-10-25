// The one way modest-deploy runs another program: execFile, with a fixed program and a
// list of arguments, never a shell, so no argument can become a second command.
// Tests replace it with a recording.

import { execFile } from "node:child_process";

export type Ran = { code: number; stdout: string; stderr: string };
export type RunOptions = { cwd?: string; env?: Record<string, string>; input?: string; as?: string; timeout?: number };
export type Run = (program: string, args: string[], options?: RunOptions) => Promise<Ran>;

/** Runs a program, waiting for it; never throws for a non-zero exit (the caller decides). */
export const run: Run = (program, args, options = {}) =>
  new Promise((resolve) => {
    const system = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
    const env = options.env ?? system;
    // As another user: runuser (util-linux, on every Ubuntu) drops to that user, and env
    // starts the program with exactly this environment, and nothing of root's.
    const [file, list] = options.as
      ? ["runuser", ["-u", options.as, "--", "/usr/bin/env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), program, ...args]]
      : [program, args];
    const child = execFile(
      file,
      list,
      {
        cwd: options.cwd,
        // runuser itself is found on the system's PATH; the program it starts gets `env`.
        env: options.as ? system : env,
        timeout: options.timeout ?? 10 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && !stdout ? error.message : "")) });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

/** Runs a program, and throws, saying what failed, if it doesn't succeed. */
export async function must(runner: Run, program: string, args: string[], options?: RunOptions): Promise<string> {
  const ran = await runner(program, args, options);
  if (ran.code !== 0)
    throw new Error(`${program} ${args[0] ?? ""} failed: ${(ran.stderr || ran.stdout).trim().split("\n").filter(Boolean).slice(-12).join(" ")}`);
  return ran.stdout;
}
