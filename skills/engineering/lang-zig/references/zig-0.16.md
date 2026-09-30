# Zig 0.15 and 0.16: what changed

Read before writing I/O, containers, `main` or `build.zig`. Sources: the [0.15.1](https://ziglang.org/download/0.15.1/release-notes.html) and [0.16.0](https://ziglang.org/download/0.16.0/release-notes.html) release notes and the 0.16.0 `lib/init` templates on Codeberg.

## main (0.16, "Juicy Main")

```zig
pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);
    _ = .{ gpa, io, args };
}
```

Before: `var gpa = std.heap.GeneralPurposeAllocator(.{}){};` and `std.process.args()`. `GeneralPurposeAllocator` is now `std.heap.DebugAllocator`.

## Writers and readers (0.15 "Writergate", 0.16 paths)

`std.Io.Writer` and `std.Io.Reader` are concrete types with the buffer in the interface. `GenericWriter`, `AnyWriter`, `getStdOut().writer()`, `FixedBufferStream` and `null_writer` are gone.

```zig
var buf: [4096]u8 = undefined;
var stdout_writer: std.Io.File.Writer = .init(.stdout(), io, &buf);
const out = &stdout_writer.interface;
try out.print("{d} items\n", .{count});
try out.flush();
```

Format: `{f}` calls a type's `format` method; `{}` on such a type is a compile error; `{any}` skips it. `std.fmt.format` became `Io.Writer.print`.

## Containers

```zig
var list: std.ArrayList(u32) = .empty; // unmanaged: no stored allocator
defer list.deinit(gpa);
try list.append(gpa, 42);
```

The managed variant is `std.array_list.Managed`, slated for removal.

## I/O as an interface (0.16)

Everything that blocks or is nondeterministic takes `io: std.Io`:

| Before | 0.16 |
|---|---|
| `std.fs.cwd().openFile("p", .{})` | `std.Io.Dir.cwd().openFile(io, "p", .{})` |
| `file.close()` | `file.close(io)` |
| `std.fs.File`, `std.fs.Dir` | `std.Io.File`, `std.Io.Dir` |
| `std.process.Child.init(argv, gpa)` | `std.process.spawn(io, .{ .argv = argv, .stdin = .pipe })` |
| `std.crypto.random.bytes(&buf)` | `io.random(&buf)` (`io.randomSecure` for keys) |
| `std.time.nanoTimestamp()` | `std.Io.Timestamp.now(io)`; `Io.Clock`, `Io.Duration`, `Io.Timeout` |
| `std.Thread.Mutex`, `Condition`, `Semaphore`, `RwLock`, `ResetEvent`, `WaitGroup` | `Io.Mutex`, `Io.Condition`, `Io.Semaphore`, `Io.RwLock`, `Io.Event`, `Io.Group` |
| `std.Thread.Pool`, `std.once` | removed |

A `std.Random` from `io`: `var src: std.Random.IoSource = .{ .io = io }; const rng = src.interface();`.

Implementations: `Io.Threaded` (default, complete), `Io.Evented` (experimental), `Io.Uring` and `Io.Kqueue` (proof of concept), `Io.failing` (every operation fails), `std.testing.io` in tests.

Tasks:

```zig
var fut = io.async(fetch, .{ io, url });
defer if (fut.cancel(io)) |r| r.deinit() else |_| {};
const body = try fut.await(io);

var group: std.Io.Group = .init;
defer group.cancel(io);
group.async(io, work, .{ io, item });
try group.await(io);
```

`io.async` may run the function inline; `io.concurrent` demands real concurrency. All I/O can return `error.Canceled`.

## Language changes

- `usingnamespace`, `async`, `await` and `@frameSize` removed (0.15). Conditional declarations: `pub const foo = if (have_foo) 123 else @compileError("unsupported");`.
- `@Type` replaced by `@Int`, `@Pointer`, `@Tuple`, `@Fn`, `@Struct`, `@Union`, `@Enum`, `@EnumLiteral` (0.16).
- `@floor`/`@ceil`/`@round`/`@trunc` convert straight to an integer; `@intFromFloat` is deprecated (0.16).
- Returning the address of a local is a compile error; runtime vector indexing is forbidden; packed unions need an explicit backing integer; extern enums need an explicit tag type (0.16).
- `ArenaAllocator` is thread-safe; `ThreadSafeAllocator` is removed (0.16).
- Error renames: `RenameAcrossMountPoints`/`NotSameFileSystem` to `CrossDevice`, `SharingViolation` to `FileBusy`, `EnvironmentVariableNotFound` to `EnvironmentVariableMissing` (0.16).

## build.zig skeleton (0.16 template)

```zig
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const mod = b.addModule("app", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
    });

    const exe = b.addExecutable(.{
        .name = "app",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{ .name = "app", .module = mod }},
        }),
    });
    b.installArtifact(exe);

    const test_step = b.step("test", "Run tests");
    const mod_tests = b.addTest(.{ .root_module = mod });
    test_step.dependOn(&b.addRunArtifact(mod_tests).step);
    const exe_tests = b.addTest(.{ .root_module = exe.root_module });
    test_step.dependOn(&b.addRunArtifact(exe_tests).step);
}
```

`root_module` is required since 0.15; `.root_source_file`, `.target` and `.optimize` directly on `addExecutable`/`addTest` no longer exist. `@cImport` is moving to `b.addTranslateC(...)`. `b.addTest(.{ .timeout = ... })` sets a unit-test timeout (0.16).

## build.zig.zon

```zig
.{
    .name = .app,
    .version = "0.0.0",
    .fingerprint = 0x..., // generated once by `zig init`; never edit
    .minimum_zig_version = "0.16.0",
    .dependencies = .{}, // `zig fetch --save <url>` fills .url and .hash
    .paths = .{ "build.zig", "build.zig.zon", "src" },
}
```
