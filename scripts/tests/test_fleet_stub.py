"""fleet/bin/fleet and fleet/bin/fleet-run: stubs that exec the first same-named command on PATH that is not themselves."""

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = str(Path(shutil.which("readlink")).parent)
MOVED = "fleet moved to the fleet plugin: run `fleet agent install`\n"


class FleetStubTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()

    def run_stub(self, name, path, *args, home=None):
        return subprocess.run([str(ROOT / "fleet" / "bin" / name), *args], capture_output=True, text=True, timeout=30,
                              env={"PATH": f"{path}:{TOOLS}", "HOME": str(home or self.tmp / "home")})

    def command(self, folder, name, body):
        (self.tmp / folder).mkdir(exist_ok=True)
        path = self.tmp / folder / name
        path.write_text(f"#!/bin/sh\n{body}\n")
        path.chmod(0o755)
        return str(path.parent)

    def test_it_execs_the_command_on_path_with_its_arguments_and_exit(self):
        for name in ("fleet", "fleet-run"):
            with self.subTest(name=name):
                real = self.command(f"real-{name}", name, 'echo "ran $*"; exit 3')
                r = self.run_stub(name, real, "tab", "--help")
                self.assertEqual((r.returncode, r.stdout, r.stderr), (3, "ran tab --help\n", ""))

    def test_it_refuses_itself_and_says_where_the_fleet_went(self):
        for name in ("fleet", "fleet-run"):
            with self.subTest(name=name):
                r = self.run_stub(name, str(ROOT / "fleet" / "bin"))
                self.assertEqual((r.returncode, r.stdout, r.stderr), (127, "", MOVED))

    def test_it_refuses_itself_through_a_symlink_and_runs_the_next_one(self):
        link = self.tmp / "links"
        link.mkdir()
        (link / "fleet").symlink_to(ROOT / "fleet" / "bin" / "fleet")
        real = self.command("real", "fleet", "echo real")
        r = self.run_stub("fleet", f"{link}:{real}")
        self.assertEqual((r.returncode, r.stdout), (0, "real\n"))
        self.assertEqual(self.run_stub("fleet", str(link)).returncode, 127)


    def test_a_fleet_on_path_that_runs_the_stub_again_is_refused_not_looped(self):
        for name in ("fleet", "fleet-run"):
            with self.subTest(name=name):
                back = self.command(f"back-{name}", name, f'exec "{ROOT / "fleet" / "bin" / name}" "$@"')
                r = self.run_stub(name, back, "tab")
                self.assertEqual(r.returncode, 127)
                self.assertEqual(r.stderr, f"{name}: the {name} on PATH runs this tstack stub again; point it at the fleet repo's apps/cli\n")

    def test_the_fleet_repos_own_install_wins_over_path(self):
        home = self.tmp / "home"
        for name in ("fleet", "fleet-run"):
            for where in (".claude/plugins/marketplaces/fleet", "repos/luizhcrocha/fleet-live"):
                with self.subTest(name=name, where=where):
                    bin_dir = home / where / "apps" / "cli" / "bin"
                    bin_dir.mkdir(parents=True, exist_ok=True)
                    cli = bin_dir / name
                    cli.write_text(f'#!/bin/sh\necho "{where} $*"\n')
                    cli.chmod(0o755)
                    other = self.command(f"path-{name}", name, "echo path")
                    r = self.run_stub(name, other, "tab", home=home)
                    self.assertEqual(r.stdout, f"{where} tab\n")
                    cli.unlink()

    def test_the_fleet_repos_install_runs_without_the_loop_guard_set(self):
        bin_dir = self.tmp / "home" / ".claude/plugins/marketplaces/fleet" / "apps" / "cli" / "bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "fleet").write_text('#!/bin/sh\necho "guard=${FLEET_TSTACK_STUB:-unset}"\n')
        (bin_dir / "fleet").chmod(0o755)
        self.assertEqual(self.run_stub("fleet", self.command("none", "true", "true")).stdout, "guard=unset\n")

if __name__ == "__main__":
    unittest.main()
