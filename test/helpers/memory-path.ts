import { join, parse, sep } from "node:path";

const filesystemRoot = parse(process.cwd()).root;

/** Build a native absolute CWD from a platform-independent test path. */
export function testCwd(path: `/${string}`): string {
  return path === "/" ? filesystemRoot : join(filesystemRoot, ...path.slice(1).split("/"));
}

export function testCwds(...paths: `/${string}`[]): string[] {
  return paths.map(testCwd);
}

/** Preserve non-canonical segments for tests of command-input normalization. */
export function testCwdInput(path: `/${string}`): string {
  return `${filesystemRoot}${path.slice(1).split("/").join(sep)}`;
}
