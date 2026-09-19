import io
import unittest
from unittest.mock import patch

import share_new_posts


class FakeResponse:
    def __init__(self, status=200, headers=None, body=b'{"ok": true}'):
        self.status = status
        self.headers = headers or {}
        self.body = io.BytesIO(body)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self.body.read()


class ShareNewPostsTests(unittest.TestCase):
    @patch("share_new_posts.urllib.request.urlopen")
    def test_image_preflight_requires_success_and_content_length(self, urlopen):
        urlopen.return_value = FakeResponse(headers={"Content-Length": "123"})
        self.assertTrue(share_new_posts.check_image_url("https://example.test/card.jpg"))

        urlopen.return_value = FakeResponse(headers={})
        self.assertFalse(share_new_posts.check_image_url("https://example.test/card.jpg"))

        urlopen.return_value = FakeResponse(status=404, headers={"Content-Length": "123"})
        self.assertFalse(share_new_posts.check_image_url("https://example.test/card.jpg"))

    @patch("share_new_posts.urllib.request.urlopen")
    def test_invalid_blocks_does_not_emit_error_classifier_line(self, urlopen):
        urlopen.return_value = FakeResponse(body=b'{"ok": false, "error": "invalid_blocks"}')
        with patch("builtins.print") as printer:
            result = share_new_posts.post_to_slack("xoxb-test", "channel", [], "fallback")
        self.assertEqual(result, "invalid_blocks")
        line = " ".join(str(part) for part in printer.call_args.args)
        self.assertIn("rejected image blocks", line)
        self.assertNotIn("slack error", line)


if __name__ == "__main__":
    unittest.main()
