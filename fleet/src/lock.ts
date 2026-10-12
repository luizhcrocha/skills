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

/** How many times a failing `flock` is tried (a signal interrupts a wait: EINTR) before it fails. */
const TRIES = 100;

/** `flock` failed every time it was tried (ENOLCK, EBADF, ...): the caller must not go on unlocked. */
export class LockFailed extends Error {}

/** Take an exclusive lock on the open file `fd`, waiting for it; the function returned releases it. Throws
 * {@link LockFailed} when it cannot be taken: nothing runs unlocked. */
export function holdExclusiveLock(fd: number): () => void {
  libc ??= open();
  const { flock } = libc.symbols;
  let tries = 0;

  while (flock(fd, LOCK_EX) !== 0) {
    tries += 1;

    if (tries >= TRIES) throw new LockFailed(`flock(LOCK_EX) failed ${String(TRIES)} times on fd ${String(fd)}`);
  }

  return () => {
    flock(fd, LOCK_UN);
  };
}

/** Run `body` while holding an exclusive lock on the open file `fd`; the lock is released after. */
export function withExclusiveLock<T>(fd: number, body: () => T): T {
  const release = holdExclusiveLock(fd);

  try {
    return body();
  } finally {
    release();
  }
}
