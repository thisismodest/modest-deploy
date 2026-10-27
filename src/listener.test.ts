import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { APP, COMMIT, onServer, passed, sign, withApp } from "../test/helpers.ts";
import { createListener, MOST_BYTES } from "./listener.ts";
import type { Layout } from "./paths.ts";
import { enqueue, takeAll } from "./queue.ts";

/** A listener on a free port for the test, closed after. */
async function listening(paths: Layout, run: (url: string) => Promise<void>) {
  const server = createListener(paths);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

const send = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${url}/deploy/shop`, { method: "POST", body, headers: { "x-github-event": "workflow_run", "x-hub-signature-256": sign(body), ...headers } });

const waiting = async (paths: Layout) => readdir(paths.requests).catch(() => [] as string[]);

test("a signed message for a passed CI run leaves one deploy request, for that app and commit", () =>
  onServer(async (paths) => {
    await withApp(paths);
    await listening(paths, async (url) => {
      const res = await send(url, JSON.stringify(passed()));
      assert.equal(res.status, 202);
      assert.match(await res.text(), /Deploying 0123456/);
    });
    assert.deepEqual(await waiting(paths), ["shop"]);
    assert.equal(await readFile(join(paths.requests, "shop"), "utf8"), COMMIT);
  }));

test("an unsigned, wrongly signed, or changed message leaves nothing, and is told so", () =>
  onServer(async (paths) => {
    await withApp(paths);
    await listening(paths, async (url) => {
      const body = JSON.stringify(passed());
      for (const headers of [
        { "x-hub-signature-256": "" },
        { "x-hub-signature-256": sign(body, "b".repeat(64)) },
        { "x-hub-signature-256": sign(`${body} `) },
      ]) {
        assert.equal((await send(url, body, headers)).status, 401);
      }
    });
    assert.deepEqual(await waiting(paths), []);
  }));

test("a signed message that shouldn't deploy (a failed run, another branch) leaves nothing", () =>
  onServer(async (paths) => {
    await withApp(paths);
    await listening(paths, async (url) => {
      for (const payload of [passed({}, { conclusion: "failure" }), passed({}, { head_branch: "x" }), passed({ action: "requested" })]) {
        const res = await send(url, JSON.stringify(payload));
        assert.equal(res.status, 202);
        assert.match(await res.text(), /Ignored/);
      }
      assert.match(await (await send(url, "{}", { "x-github-event": "ping" })).text(), /Ignored: GitHub's test message/);
    });
    assert.deepEqual(await waiting(paths), []);
  }));

test("an app that doesn't exist, or has no secret, or broken settings, gets the same answer as a wrong signature, so the answers don't say which exist", () =>
  onServer(async (paths) => {
    await withApp(paths);
    await writeFile(paths.secret("shop"), "  \n");
    await writeFile(paths.app("broken"), "{ not json");
    await listening(paths, async (url) => {
      const body = JSON.stringify(passed());
      assert.equal((await send(url, body)).status, 401, "an empty secret is no secret");
      for (const name of ["other", "broken"]) {
        const res = await fetch(`${url}/deploy/${name}`, { method: "POST", body, headers: { "x-hub-signature-256": sign(body) } });
        assert.equal(res.status, 401, name);
        assert.match(await res.text(), /Not signed with this app's secret/);
      }
      for (const path of ["/deploy/..%2Fshop", "/deploy/shop/x", "/deploy/", "/", "/deploy/shop?x=1"]) {
        assert.equal((await fetch(url + path, { method: "POST", body: "{}" })).status, 404, path);
      }
    });
    assert.deepEqual(await waiting(paths), []);
  }));

test("a delivery is acted on once: the same one sent again is ignored", () =>
  onServer(async (paths) => {
    await withApp(paths);
    await listening(paths, async (url) => {
      const body = JSON.stringify(passed());
      const first = await send(url, body, { "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958" });
      assert.match(await first.text(), /Deploying/);
      await takeAll(paths);
      const again = await send(url, body, { "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958" });
      assert.match(await again.text(), /already received/);
    });
    assert.deepEqual(await waiting(paths), []);
  }));

test("only POST", () =>
  onServer(async (paths) => {
    await withApp(paths);
    await listening(paths, async (url) => {
      assert.equal((await fetch(`${url}/deploy/shop`)).status, 405);
    });
  }));

test("a body over 1MB is refused, by its stated length or as it arrives, and never read whole", () =>
  onServer(async (paths) => {
    await withApp(paths);
    await listening(paths, async (url) => {
      const big = "x".repeat(MOST_BYTES + 1);
      assert.equal((await send(url, big)).status, 413);
      // Sent without a length, in pieces: cut off once past the limit.
      const port = Number(new URL(url).port);
      const status = await new Promise<string>((resolve) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write("POST /deploy/shop HTTP/1.1\r\nhost: x\r\ntransfer-encoding: chunked\r\n\r\n");
          const piece = "y".repeat(64 * 1024);
          for (let i = 0; i < 20; i++) socket.write(`${piece.length.toString(16)}\r\n${piece}\r\n`);
        });
        socket.on("data", (data) => resolve(data.toString().split("\r\n")[0] ?? ""));
        socket.on("error", () => resolve("closed"));
      });
      assert.match(status, /413|closed/);
    });
    assert.deepEqual(await waiting(paths), []);
  }));

test("a signed message that isn't JSON is refused", () =>
  onServer(async (paths) => {
    await withApp(paths);
    await listening(paths, async (url) => {
      assert.equal((await send(url, "{not json")).status, 400);
    });
  }));

test("a newer request for an app replaces one still waiting; anything in the queue that isn't a request is thrown away", () =>
  onServer(async (paths) => {
    await withApp(paths);
    await enqueue(paths, "shop", "tip");
    await enqueue(paths, "shop", COMMIT);
    await writeFile(join(paths.requests, "../requests/evil name"), COMMIT);
    await writeFile(join(paths.requests, "other"), "rm -rf /");
    const taken = await takeAll(paths);
    assert.deepEqual(taken, [{ name: "shop", commit: COMMIT }]);
    assert.deepEqual(await waiting(paths), [], "all taken");
    await assert.rejects(enqueue(paths, "../x", COMMIT));
    await assert.rejects(enqueue(paths, "shop", "HEAD"));
    assert.equal(APP.name, "shop");
  }));

test("a pipe or a link left in the deploy queue is thrown away, never read: it can't stall deploys or point root elsewhere", () =>
  onServer(async (paths) => {
    await withApp(paths);
    await enqueue(paths, "shop", COMMIT);
    const { execFileSync } = await import("node:child_process");
    const { symlink } = await import("node:fs/promises");
    execFileSync("mkfifo", [join(paths.requests, "piped")]);
    await symlink("/dev/zero", join(paths.requests, "linked"));
    const taken = await Promise.race([takeAll(paths), new Promise((_, stop) => setTimeout(() => stop(new Error("stalled")), 5000))]);
    assert.deepEqual(taken, [{ name: "shop", commit: COMMIT }]);
    assert.deepEqual(await waiting(paths), []);
  }));
