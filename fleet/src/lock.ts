/**
 * An exclusive `flock(2)` on an open file, the lock Python's `fcntl.flock` takes: the chat's appenders,
 * Python's and these, take the same one, so ids stay sequential while both write one store.
 */
import { dlopen, FFIType } from "bun:ffi";

const LOCK_EX = 2;

const LOCK_UN = 8;

function open() {
  return dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
}

let libc: ReturnType<typeof open> | undefined;

/** Run `body` while holding an exclusive lock on the open file `fd`; the lock is released after. */
export function withExclusiveLock<T>(fd: number, body: () => T): T {
  libc ??= open();
  const { flock } = libc.symbols;

  for (let tries = 0; flock(fd, LOCK_EX) !== 0 && tries < 100; tries += 1) {
    // EINTR: try again
  }

  try {
    return body();
  } finally {
    flock(fd, LOCK_UN);
  }
}
