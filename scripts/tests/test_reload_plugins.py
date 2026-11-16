"""Tests for scripts/reload-plugins: which Rex panes get /reload-plugins.

Run: just test-scripts
"""

import importlib.machinery
import importlib.util
import unittest
from pathlib import Path

_path = Path(__file__).resolve().parent.parent / "reload-plugins"
_loader = importlib.machinery.SourceFileLoader("reload_plugins", str(_path))
_spec = importlib.util.spec_from_loader("reload_plugins", _loader)
rp = importlib.util.module_from_spec(_spec)
_loader.exec_module(rp)

RULE = "─" * 80
STATUS = "  skills | Ctx Used: 15.0% | Model: Opus 5.5\n  ⏵⏵ auto mode on (shift+tab to cycle)"


class Classify(unittest.TestCase):
    def test_empty_box(self):
        self.assertEqual(rp.classify(f"done\n{RULE}\n❯ \n{RULE}\n{STATUS}"), "empty")

    def test_empty_box_under_a_labelled_border(self):
        self.assertEqual(rp.classify(f"done\n{'─' * 60} refactor-workflow ──\n❯\xa0\n{RULE}\n{STATUS}"), "empty")

    def test_unsent_text(self):
        self.assertEqual(rp.classify(f"done\n{RULE}\n❯ update the plugin\n{RULE}\n{STATUS}"), "typed")

    def test_unsent_text_wrapped_over_two_lines(self):
        self.assertEqual(rp.classify(f"done\n{RULE}\n❯ a long\n  line\n{RULE}\n{STATUS}"), "typed")

    def test_shell_mode_box(self):
        self.assertEqual(rp.classify(f"done\n{RULE}\n! \n{RULE}\n  ! for shell mode"), "shell")

    def test_open_dialog(self):
        screen = (f"{RULE}\n❯ 1. Adopt it\n     It becomes D1's contract.\n  2. Talk more first\n{RULE}\n"
                  "  3. Chat about this\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n")
        self.assertEqual(rp.classify(screen), "dialog")

    def test_shell_prompt_is_not_claude(self):
        self.assertEqual(rp.classify("cr-sede-pc …/dotfiles\n❯ systemctl --user stop x\ncr-sede-pc …/dotfiles\n❯ "), "other")


if __name__ == "__main__":
    unittest.main()
