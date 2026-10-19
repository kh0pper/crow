"""Unit tests for pi-setup's pure helpers (boot_config, bt_main_conf, bt_controllers).
Run by tests/kiosk-pi-scripts.test.js; never copied to the Pi."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import boot_config  # noqa: E402
import bt_main_conf  # noqa: E402
import bt_controllers  # noqa: E402

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


class BtMainConf(unittest.TestCase):
    def test_empty_file_gets_both_sections(self):
        self.assertEqual(bt_main_conf.fix(""), "[General]\nControllerMode = bredr\n\n[Policy]\nAutoEnable=true\n")

    def test_autoenable_is_added_to_an_existing_policy_section(self):
        out = bt_main_conf.fix("[General]\n#Name = BlueZ\n\n[Policy]\n#ReconnectAttempts=7\n")
        self.assertEqual(out, "[General]\n#Name = BlueZ\nControllerMode = bredr\n\n[Policy]\n#ReconnectAttempts=7\nAutoEnable=true\n")

    def test_autoenable_is_replaced_in_place(self):
        for line in ("#AutoEnable=true", "AutoEnable = false", "# AutoEnable=false"):
            out = bt_main_conf.fix(f"[General]\nControllerMode = bredr\n[Policy]\n{line}\nReconnectAttempts=7\n")
            self.assertEqual(out, "[General]\nControllerMode = bredr\n[Policy]\nAutoEnable=true\nReconnectAttempts=7\n", line)

    def test_policy_section_is_created_when_missing_and_bredr_kept(self):
        out = bt_main_conf.fix("[General]\nControllerMode = bredr\n\n[LE]\n#MinSleepTime=1\n")
        self.assertEqual(out, "[General]\nControllerMode = bredr\n\n[LE]\n#MinSleepTime=1\n\n[Policy]\nAutoEnable=true\n")

    def test_autoenable_outside_policy_is_left_alone(self):
        out = bt_main_conf.fix("[General]\n#AutoEnable=false\n")
        self.assertEqual(out, "[General]\n#AutoEnable=false\nControllerMode = bredr\n\n[Policy]\nAutoEnable=true\n")

    def test_idempotent(self):
        once = bt_main_conf.fix("[General]\n#ControllerMode = dual\n[Policy]\n#AutoEnable=true\n")
        self.assertEqual(bt_main_conf.fix(once), once)


# Placeholder addresses only (the repository is public).
ONBOARD, USB, SPEAKER = "AA:BB:CC:DD:EE:01", "AA:BB:CC:DD:EE:02", "00:11:22:33:44:55"
SERIAL_DEV = "sys/devices/platform/soc/3f201000.serial/3f201000.serial:0/3f201000.serial:0.0/serial0/serial0-0"
USB_IF = "sys/devices/platform/soc/3f980000.usb/usb1/1-1/1-1.2/1-1.2:1.0"
# `btmgmt info` as BlueZ 5.82 prints it on a Pi 3 with a USB adapter (the onboard hci0 is not managed)
MGMT_USB_ONLY = (f"Index list with 1 item\nhci1:\tPrimary controller\n\taddr {USB} version 10 manufacturer 93 "
                 "class 0x000000\n\tsupported settings: powered connectable br/edr le\n\tcurrent settings: ssp br/edr\n"
                 "\tname kiosk\n\tshort name \n")
MGMT_BOTH = (f"Index list with 2 items\nhci1:\tPrimary controller\n\taddr {USB} version 10 manufacturer 93 class 0x000000\n"
             f"\tname kiosk\nhci0:\tPrimary controller\n\taddr {ONBOARD} version 8 manufacturer 15 class 0x6c0000\n"
             "\tname kiosk #2\n")
MGMT_ONBOARD = f"Index list with 1 item\nhci0:\tPrimary controller\n\taddr {ONBOARD} version 8 manufacturer 15 class 0x6c0000\n"
LIST_USB = f"Controller {USB} kiosk [default]\n"
LIST_ONBOARD = f"Controller {ONBOARD} kiosk [default]\n"
SHOW_ON = f"Controller {USB} (public)\n\tPowered: yes\n\tPowerState: on\n\tModalias: usb:v1D6Bp0246d0552\n"
SHOW_BLOCKED = f"Controller {USB} (public)\n\tPowered: no\n\tPowerState: off-blocked\n\tModalias: usb:v1D6Bp0246d0552\n"


class FakeRoot:
    """A throwaway root with the sysfs links and /var/lib/bluetooth dirs bt_controllers reads."""

    def __init__(self):
        self.path = tempfile.mkdtemp(prefix="crow-kiosk-btc-")

    def controller(self, hci, devpath):
        os.makedirs(os.path.join(self.path, devpath), exist_ok=True)
        os.makedirs(os.path.join(self.path, "sys/class/bluetooth", hci))
        os.symlink(os.path.join(self.path, devpath), os.path.join(self.path, "sys/class/bluetooth", hci, "device"))
        return self

    def bond(self, controller, device):
        os.makedirs(os.path.join(self.path, "var/lib/bluetooth", controller, device))
        return self

    def cleanup(self):
        shutil.rmtree(self.path, ignore_errors=True)


class BtControllers(unittest.TestCase):
    def setUp(self):
        self.root = FakeRoot()
        self.addCleanup(self.root.cleanup)

    def test_parsing(self):
        self.assertEqual(bt_controllers.parse_mgmt(MGMT_BOTH), {USB: "hci1", ONBOARD: "hci0"})
        self.assertEqual(bt_controllers.parse_mgmt("Index list with 0 items\n"), {})
        self.assertEqual(bt_controllers.parse_list(LIST_USB + f"Controller {ONBOARD} kiosk #2\n"),
                         [(USB, True), (ONBOARD, False)])
        self.assertEqual(bt_controllers.default_of(f"Controller {ONBOARD} kiosk\n"), ONBOARD, "a lone controller is the default")
        self.assertIsNone(bt_controllers.default_of(""))

    def test_bus_from_the_sysfs_device_link_never_from_modalias(self):
        self.root.controller("hci0", SERIAL_DEV).controller("hci1", USB_IF)
        self.assertEqual(bt_controllers.bus_of(self.root.path, "hci0"), ("serial", "serial0-0"))
        self.assertEqual(bt_controllers.bus_of(self.root.path, "hci1"), ("usb", "1-1.2"))
        self.assertEqual(bt_controllers.bus_of(self.root.path, "hci7"), (None, None))
        self.assertTrue(bt_controllers.usb_present(self.root.path))
        self.assertTrue(bt_controllers.serial_present(self.root.path))

    def test_presence_without_a_usb_adapter(self):
        self.root.controller("hci0", SERIAL_DEV)
        self.assertFalse(bt_controllers.usb_present(self.root.path))
        empty = FakeRoot()
        self.addCleanup(empty.cleanup)
        self.assertFalse(bt_controllers.usb_present(empty.path))
        self.assertFalse(bt_controllers.serial_present(empty.path))

    def test_bond_held_by_the_onboard_controller_while_the_usb_adapter_is_the_default(self):
        # the kiosk's shape after a USB adapter was plugged in: onboard unmanaged, bond left on it
        self.root.controller("hci0", SERIAL_DEV).controller("hci1", USB_IF).bond(ONBOARD, SPEAKER).bond(USB, "cache")
        d = bt_controllers.diagnose(self.root.path, LIST_USB, MGMT_USB_ONLY, SHOW_ON, SPEAKER)
        self.assertEqual(d["status"], "bond_elsewhere")
        self.assertEqual(d["message"][0], f"warning: the speaker's pairing is held by {ONBOARD} (onboard, hci0) "
                                          f"but Bluetooth uses {USB} (USB, hci1).")
        self.assertIn("re-run with --usb-bt, reboot, then --repair-speaker", d["message"][1])
        self.assertIn("unplug the adapter and reboot", d["message"][1])

    def test_bond_on_the_default_controller_is_ok(self):
        self.root.controller("hci0", SERIAL_DEV).bond(ONBOARD, SPEAKER)
        d = bt_controllers.diagnose(self.root.path, LIST_ONBOARD, MGMT_ONBOARD, SHOW_ON, SPEAKER)
        self.assertEqual((d["status"], d["message"]), ("ok", []))

    def test_no_bond_anywhere_is_not_paired(self):
        self.root.controller("hci1", USB_IF)
        d = bt_controllers.diagnose(self.root.path, LIST_USB, MGMT_USB_ONLY, SHOW_ON, SPEAKER)
        self.assertEqual(d["status"], "not_paired")
        self.assertIn("--repair-speaker", d["message"][0])

    def test_a_bond_elsewhere_without_a_usb_adapter_is_not_a_bond_warning(self):
        self.root.controller("hci0", SERIAL_DEV).bond("AA:BB:CC:DD:EE:09", SPEAKER)
        d = bt_controllers.diagnose(self.root.path, LIST_ONBOARD, MGMT_ONBOARD, SHOW_ON, SPEAKER)
        self.assertEqual(d["status"], "not_paired")

    def test_no_controllers(self):
        d = bt_controllers.diagnose(self.root.path, "", "Index list with 0 items\n", "No default controller available\n", SPEAKER)
        self.assertEqual(d["status"], "no_controller")
        self.assertTrue(d["message"][0].startswith("warning: no Bluetooth controller"))

    def test_a_blocked_default(self):
        self.root.controller("hci1", USB_IF).bond(USB, SPEAKER)
        d = bt_controllers.diagnose(self.root.path, LIST_USB, MGMT_USB_ONLY, SHOW_BLOCKED, SPEAKER)
        self.assertEqual(d["status"], "default_blocked")
        self.assertIn("rfkill", d["message"][0])

    def test_without_a_speaker_only_the_controller_is_checked(self):
        self.root.controller("hci1", USB_IF)
        self.assertEqual(bt_controllers.diagnose(self.root.path, LIST_USB, MGMT_USB_ONLY, SHOW_ON, "")["status"], "ok")

    def test_resolve_the_controller_in_use_by_address(self):
        self.root.controller("hci0", SERIAL_DEV).controller("hci1", USB_IF)
        self.assertEqual(bt_controllers.resolve(self.root.path, LIST_USB, MGMT_USB_ONLY, ""),
                         {"hci": "hci1", "bus": "usb", "id": "1-1.2", "addr": USB})

    def test_resolve_falls_back_to_the_record_when_bluez_lost_the_controller(self):
        self.root.controller("hci1", USB_IF)
        record = f"bus=usb\nid=1-1.2\naddr={USB}\n"
        self.assertEqual(bt_controllers.resolve(self.root.path, "", "Index list with 0 items\n", record),
                         {"hci": "hci1", "bus": "usb", "id": "1-1.2", "addr": USB}, "found again by its port in sysfs")
        gone = FakeRoot()
        self.addCleanup(gone.cleanup)
        self.assertEqual(bt_controllers.resolve(gone.path, "", "", record),
                         {"hci": "", "bus": "usb", "id": "1-1.2", "addr": USB})
        self.assertEqual(bt_controllers.resolve(gone.path, "", "", ""), {"hci": "", "bus": "", "id": "", "addr": ""})

    def test_record_and_cli(self):
        self.root.controller("hci0", SERIAL_DEV).controller("hci1", USB_IF)
        r = bt_controllers.resolve(self.root.path, LIST_USB, MGMT_USB_ONLY, "")
        self.assertEqual(bt_controllers.record_text(r), f"bus=usb\nid=1-1.2\naddr={USB}\n")
        lst = os.path.join(self.root.path, "list")
        mgmt = os.path.join(self.root.path, "mgmt")
        with open(lst, "w") as f:
            f.write(LIST_USB)
        with open(mgmt, "w") as f:
            f.write(MGMT_USB_ONLY)
        here = os.path.dirname(os.path.abspath(__file__))
        cli = [sys.executable, os.path.join(here, "bt_controllers.py")]
        out = subprocess.run(cli + ["resolve", "--root", self.root.path, "--list", lst, "--mgmt", mgmt],
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(out, f"hci=hci1 bus=usb id=1-1.2 addr={USB}\n")
        self.assertEqual(subprocess.run(cli + ["usb-present", "--root", self.root.path]).returncode, 0)
        self.assertEqual(subprocess.run(cli + ["usb-present", "--root", os.path.join(self.root.path, "nope")]).returncode, 1)


if __name__ == "__main__":
    unittest.main()
