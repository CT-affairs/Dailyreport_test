import unittest

from services.jobcan_service import JobcanService


class EffectiveWorkMinutesFromDailySummaryTest(unittest.TestCase):
    def test_special3_full_day_is_not_counted_as_work(self):
        summary = {
            "work": 360,
            "vacation_time": 360,
            "vacation_type": "special3",
        }

        self.assertEqual(
            JobcanService.effective_work_minutes_from_daily_summary(summary),
            0,
        )

    def test_special3_partial_leave_subtracts_only_vacation_time(self):
        summary = {
            "work": 360,
            "vacation_time": 120,
            "vacation_type": "special3",
        }

        self.assertEqual(
            JobcanService.effective_work_minutes_from_daily_summary(summary),
            240,
        )

    def test_other_vacation_types_keep_jobcan_work_minutes(self):
        for vacation_type in ("paid", "special4", None):
            with self.subTest(vacation_type=vacation_type):
                summary = {
                    "work": 360,
                    "vacation_time": 360,
                    "vacation_type": vacation_type,
                }

                self.assertEqual(
                    JobcanService.effective_work_minutes_from_daily_summary(summary),
                    360,
                )

    def test_special3_never_returns_negative_minutes(self):
        summary = {
            "work": 120,
            "vacation_time": 360,
            "vacation_type": "special3",
        }

        self.assertEqual(
            JobcanService.effective_work_minutes_from_daily_summary(summary),
            0,
        )


if __name__ == "__main__":
    unittest.main()
