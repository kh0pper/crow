"""Unit tests for pi-setup's pure helpers (boot_config, bt_main_conf, bt_controllers).
Run by tests/kiosk-pi-scripts.test.js; never copied to the Pi."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import boot_config  # noqa: E402

MARK = "# crow-kiosk: onboard Bluetooth off (pi-setup --usb-bt)"
LINE = "dtoverlay=disable-bt"

# The shape of a stock Raspberry Pi OS (trixie) /boot/firmware/config.txt
STOCK = """# For more options and information see
# http://rptl.io/configtxt
dtparam=audio=on
dtoverlay=vc4-kms-v3d
arm_64bit=1

[cm4]
otg_mode=1

[cm5]
dtoverlay=dwc2,dr_mode=host

[pi5]
dtoverlay=nospi10

[all]
"""


class BootConfigEnable(unittest.TestCase):
    def test_appends_the_marked_overlay_to_a_trailing_all_section(self):
        out = boot_config.enable(STOCK)
        self.assertTrue(out.startswith(STOCK), "every existing line is kept, in order")
        self.assertEqual(out[len(STOCK) :], f"{MARK}\n{LINE}\n")

    def test_a_file_ending_inside_a_conditional_section_gets_an_all_header(self):
        text = "arm_64bit=1\n\n[pi4]\narm_boost=1\n"
        self.assertEqual(boot_config.enable(text), text + f"[all]\n{MARK}\n{LINE}\n")

    def test_no_section_headers_at_all_needs_no_header(self):
        self.assertEqual(
            boot_config.enable("arm_64bit=1\n"), f"arm_64bit=1\n{MARK}\n{LINE}\n"
        )

    def test_idempotent(self):
        once = boot_config.enable(STOCK)
        self.assertEqual(boot_config.enable(once), once)

    def test_a_users_own_disable_bt_in_all_is_respected(self):
        for text in (
            "dtoverlay=disable-bt\n[pi4]\narm_boost=1\n",
            STOCK + "dtoverlay=disable-bt\n",
            "dtoverlay=pi3-disable-bt\n",
        ):
            self.assertEqual(boot_config.enable(text), text, text)

    def test_a_commented_or_conditional_disable_bt_does_not_count(self):
        text = "#dtoverlay=disable-bt\n[pi4]\ndtoverlay=disable-bt\n"
        self.assertEqual(boot_config.enable(text), text + f"[all]\n{MARK}\n{LINE}\n")

    def test_crlf_is_kept(self):
        text = "arm_64bit=1\r\n[pi4]\r\narm_boost=1\r\n"
        self.assertEqual(
            boot_config.enable(text), text + f"[all]\r\n{MARK}\r\n{LINE}\r\n"
        )

    def test_no_trailing_newline(self):
        self.assertEqual(
            boot_config.enable("arm_64bit=1"), f"arm_64bit=1\n{MARK}\n{LINE}\n"
        )

    def test_empty_file(self):
        self.assertEqual(boot_config.enable(""), f"{MARK}\n{LINE}\n")

    def test_miniuart_bt_is_detected(self):
        self.assertTrue(boot_config.has_miniuart("dtoverlay=miniuart-bt\n"))
        self.assertTrue(boot_config.has_miniuart("[pi3]\ndtoverlay=pi3-miniuart-bt\n"))
        self.assertFalse(boot_config.has_miniuart("#dtoverlay=miniuart-bt\n"))
        self.assertFalse(boot_config.has_miniuart(STOCK))


class BootConfigDisable(unittest.TestCase):
    def test_removes_only_the_marked_pair(self):
        self.assertEqual(boot_config.disable(boot_config.enable(STOCK)), STOCK)

    def test_an_added_all_header_stays(self):
        text = "arm_64bit=1\n[pi4]\narm_boost=1\n"
        once = boot_config.disable(boot_config.enable(text))
        self.assertEqual(once, text + "[all]\n")
        self.assertEqual(
            boot_config.enable(once),
            once + f"{MARK}\n{LINE}\n",
            "re-enable reuses the header",
        )
        self.assertEqual(boot_config.disable(boot_config.enable(once)), once)

    def test_a_users_own_line_is_never_removed(self):
        for text in (
            "dtoverlay=disable-bt\n",
            f"{LINE}\n{MARK}\n",
            f"{MARK}\n# {LINE}\n",
        ):
            self.assertEqual(boot_config.disable(text), text, text)

    def test_crlf_and_no_trailing_newline(self):
        self.assertEqual(
            boot_config.disable(f"a=1\r\n{MARK}\r\n{LINE}\r\nb=2\r\n"), "a=1\r\nb=2\r\n"
        )
        self.assertEqual(boot_config.disable(f"a=1\n{MARK}\n{LINE}"), "a=1\n")

    def test_marked(self):
        self.assertTrue(boot_config.marked(boot_config.enable(STOCK)))
        self.assertFalse(boot_config.marked(STOCK))
        self.assertFalse(
            boot_config.marked("dtoverlay=disable-bt\n"), "only our own pair counts"
        )


if __name__ == "__main__":
    unittest.main()
