// The patterns every value from outside must match before it's used: in a path, a
// unit name, a user name, a Caddy file, or an argument. Each is strict enough that
// nothing matching it can mean anything else (no "/", "..", spaces, or quotes).

/** A product's name: lowercase letters, digits, and hyphens, 2 to 29 long (so "mh-" + name fits a 32-character user name). */
export const isName = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9-]{0,27}[a-z0-9]$/.test(value) && !value.includes("--");

/** A domain: lowercase labels of letters, digits, and hyphens, at least two, ending in letters. */
export const isDomain = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);

/** A GitHub repository, as owner/name. */
export const isRepo = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(value) &&
  !value.includes("..") &&
  !value.endsWith(".git");

/** A commit: 40 lowercase hex characters, as GitHub sends them. */
export const isCommit = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

/** A port a product can listen on: above the ones only root can use. */
export const isPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1024 && (value as number) <= 65535;

/** Repositories compare without case, as GitHub's do. */
export const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
