import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import update_data


class TrackerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = update_data.read_json(update_data.CONFIG_PATH, {})
        fixture = Path(__file__).parent / "fixtures" / "legislation.json"
        cls.source = update_data.read_json(fixture, [])[0]

    def test_normalization_uses_session_and_bill_number_as_identity(self):
        bill = update_data.normalize_bill(
            self.source, self.config["session"], self.config["topics"]
        )
        self.assertEqual(bill["id"], "2026RS:HB0001")
        self.assertEqual(bill["bill_number"], "HB0001")
        self.assertIn("civil_rights_elections", bill["topics"])

    def test_title_change_is_detected(self):
        old = update_data.normalize_bill(
            self.source, self.config["session"], self.config["topics"]
        )
        changed_source = json.loads(json.dumps(self.source))
        changed_source["Title"] = "Open Government - Revised Public Information Requirements"
        new = update_data.normalize_bill(
            changed_source, self.config["session"], self.config["topics"]
        )
        events = update_data.detect_changes([old], [new], "2026-01-21T12:00:00+00:00")
        title_events = [event for event in events if event["field"] == "title"]
        self.assertEqual(len(title_events), 1)
        self.assertEqual(title_events[0]["old_value"], self.source["Title"])

    def test_automatic_regular_session_candidate_advances_with_year(self):
        config = {"session": "2026rs", "automatic_session_rollover": True}
        candidate = update_data.candidate_regular_session(
            config, datetime(2027, 1, 13, tzinfo=timezone.utc)
        )
        self.assertEqual(candidate, "2027rs")

    def test_rollover_can_announce_new_session_bills(self):
        bill = update_data.normalize_bill(
            self.source, "2027rs", self.config["topics"]
        )
        events = update_data.detect_changes(
            [], [bill], "2027-01-13T12:00:00+00:00", announce_all_new=True
        )
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["change_type"], "new_bill")
        self.assertEqual(events[0]["bill_id"], "2027RS:HB0001")

    def test_atomic_json_write(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.json"
            update_data.write_json(path, {"ready": True})
            self.assertEqual(update_data.read_json(path, {}), {"ready": True})


if __name__ == "__main__":
    unittest.main()
