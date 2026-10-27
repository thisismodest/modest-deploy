import assert from "node:assert/strict";
import { test } from "node:test";
import { onServer, PRODUCT } from "../test/helpers.ts";
import { allot, type Machine, parseMemory, shares } from "./memory.ts";
import { readProduct, writeWhole } from "./products.ts";

const MB = 1024 ** 2;
const GB = 1024 * MB;
/** What a "1GB" server reports: the kernel keeps some. */
const SMALL: Machine = { total: 960 * MB, cores: 1 };
const MEDIUM: Machine = { total: 4 * GB, cores: 2 };
const LARGE: Machine = { total: 16 * GB, cores: 8 };

test("a server keeps memory for itself, and deploys build within it: products have the rest", () => {
  assert.deepEqual(shares(SMALL), { reserve: 384, deploy: 192, products: 576 });
  assert.deepEqual(shares(MEDIUM), { reserve: 1024, deploy: 512, products: 3072 });
  assert.deepEqual(shares(LARGE), { reserve: 4096, deploy: 1024, products: 12288 });
  for (const machine of [SMALL, MEDIUM, LARGE, { total: 2 * GB, cores: 1 }, { total: 512 * MB, cores: 1 }]) {
    const { reserve, deploy, products } = shares(machine);
    assert.ok(reserve + products <= machine.total / MB, "never more than the machine has");
    assert.ok(deploy < reserve, "a deploy leaves the system some of its share");
  }
});

test("a memory size is whole megabytes or gigabytes, at least 128M, or max", () => {
  for (const [text, mb] of [
    ["512M", 512],
    ["1G", 1024],
    ["2g", 2048],
    ["128m", 128],
    ["max", "max"],
  ] as const)
    assert.equal(parseMemory(text), mb, text);
  for (const text of ["", "512", "0.5G", "1.5G", "64M", "1T", "-1G", "512MB", "1 G", "1G\n", " 1G", "max ", "99999999G", undefined, 512])
    assert.equal(parseMemory(text), null, JSON.stringify(text));
});

test("a product is given memory only if it fits beside the others, and max gives what's left", () => {
  const product = (name: string, memory: number) => ({ ...PRODUCT, name, memory });
  assert.equal(allot(512, [], SMALL), 512);
  assert.equal(allot("max", [], SMALL), 576);
  assert.throws(() => allot(1024, [], SMALL), /room for at most 576M/);
  assert.throws(() => allot(512, [product("blog", 512)], SMALL), /no room for another product/);
  assert.equal(allot(256, [product("blog", 256)], SMALL), 256, "two at 256M fit");
  assert.equal(allot("max", [product("blog", 1024)], MEDIUM), 2048);
  assert.throws(() => allot(3072, [product("blog", 1024)], MEDIUM), /room for at most 2G/);
});

test("settings from before memory have 512M, and one changed by hand to an odd size is refused when read", async () => {
  await onServer(async (paths) => {
    const write = (memory: unknown) =>
      writeWhole(paths.product("shop"), JSON.stringify({ name: "shop", domain: "shop.example.org", repo: "example/shop", port: 4100, memory }));
    await writeWhole(paths.product("shop"), JSON.stringify({ name: "shop", domain: "shop.example.org", repo: "example/shop", port: 4100 }));
    assert.equal((await readProduct(paths, "shop"))?.memory, 512);
    await write(768);
    assert.equal((await readProduct(paths, "shop"))?.memory, 768);
    for (const odd of ["lots", 64, 1.5, -512, 10 ** 9, null]) {
      await write(odd);
      await assert.rejects(readProduct(paths, "shop"), /memory/, JSON.stringify(odd));
    }
  });
});
