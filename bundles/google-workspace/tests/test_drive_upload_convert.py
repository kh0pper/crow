"""gdrive_upload_file's convert_to option: a pptx/docx/xlsx upload becomes a
native Slides/Docs/Sheets file.

The Drive client is a mock, so nothing leaves the process.

Run with:
    python -m unittest discover -s tests -v
"""

import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from google_workspace_mcp import drive  # noqa: E402

SLIDES = "application/vnd.google-apps.presentation"
FOLDER = "folder-1"


def drive_service():
    # Stub through `.return_value`, never by calling the mock: calling create() here
    # would register a call of the fixture's own and make the "refused before any
    # call" assertion below impossible to make (it would see the setup call).
    service = mock.MagicMock()
    service.files.return_value.create.return_value.execute.return_value = {
        "id": "file-1",
        "name": "deck",
        "mimeType": SLIDES,
        "parents": [FOLDER],
    }
    return service


class UploadConvertTests(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        self.addCleanup(os.unlink, self.path)

    def run_upload(self, service, **kwargs):
        with mock.patch.object(drive, "get_drive_service", return_value=service), \
                mock.patch.object(drive, "MediaFileUpload"):
            return asyncio.run(
                drive.gdrive_upload_file(self.path, FOLDER, name="deck", **kwargs)
            )

    def body(self, service):
        return service.files().create.call_args.kwargs["body"]

    def test_convert_to_asks_drive_for_the_native_type(self):
        service = drive_service()
        result = self.run_upload(service, convert_to=SLIDES)
        self.assertTrue(result["success"])
        self.assertEqual(self.body(service)["mimeType"], SLIDES)
        self.assertEqual(self.body(service)["parents"], [FOLDER])

    def test_no_convert_to_leaves_the_upload_alone(self):
        service = drive_service()
        result = self.run_upload(service)
        self.assertTrue(result["success"])
        self.assertNotIn("mimeType", self.body(service))

    def test_a_missing_local_file_is_refused_before_any_call(self):
        service = drive_service()
        with mock.patch.object(drive, "get_drive_service", return_value=service):
            result = asyncio.run(
                drive.gdrive_upload_file(
                    f"{self.path}.missing", FOLDER, convert_to=SLIDES
                )
            )
        self.assertFalse(result["success"])
        self.assertIn("not found", result["error"])
        service.files().create.assert_not_called()


if __name__ == "__main__":
    unittest.main()