import { describe, expect, it } from "vitest";
import {
	getJapaneseHolidayName,
	getJapaneseHolidaysForYear,
} from "../src/japaneseHolidays";

describe("japaneseHolidays", () => {
	it("computes 2026 holidays including Golden Week substitute holiday and Silver Week citizens' holiday", () => {
		const holidays = getJapaneseHolidaysForYear(2026);
		expect(holidays.get("2026-01-01")).toBe("元日");
		expect(holidays.get("2026-01-12")).toBe("成人の日");
		expect(holidays.get("2026-02-11")).toBe("建国記念の日");
		expect(holidays.get("2026-02-23")).toBe("天皇誕生日");
		expect(holidays.get("2026-03-20")).toBe("春分の日");
		expect(holidays.get("2026-04-29")).toBe("昭和の日");
		expect(holidays.get("2026-05-03")).toBe("憲法記念日");
		expect(holidays.get("2026-05-04")).toBe("みどりの日");
		expect(holidays.get("2026-05-05")).toBe("こどもの日");
		expect(holidays.get("2026-05-06")).toBe("振替休日");
		expect(holidays.get("2026-07-20")).toBe("海の日");
		expect(holidays.get("2026-08-11")).toBe("山の日");
		expect(holidays.get("2026-09-21")).toBe("敬老の日");
		expect(holidays.get("2026-09-22")).toBe("国民の休日");
		expect(holidays.get("2026-09-23")).toBe("秋分の日");
		expect(holidays.get("2026-10-12")).toBe("スポーツの日");
		expect(holidays.get("2026-11-03")).toBe("文化の日");
		expect(holidays.get("2026-11-23")).toBe("勤労感謝の日");
		expect(holidays.has("2026-12-23")).toBe(false);
	});

	it("handles historical 2019 10-day Golden Week and enthronement holidays", () => {
		expect(getJapaneseHolidayName("2019-04-29")).toBe("昭和の日");
		expect(getJapaneseHolidayName("2019-04-30")).toBe("国民の休日");
		expect(getJapaneseHolidayName("2019-05-01")).toBe("天皇の即位の日");
		expect(getJapaneseHolidayName("2019-05-02")).toBe("国民の休日");
		expect(getJapaneseHolidayName("2019-05-03")).toBe("憲法記念日");
		expect(getJapaneseHolidayName("2019-05-04")).toBe("みどりの日");
		expect(getJapaneseHolidayName("2019-05-05")).toBe("こどもの日");
		expect(getJapaneseHolidayName("2019-05-06")).toBe("振替休日");
		expect(getJapaneseHolidayName("2019-10-22")).toBe("即位礼正殿の儀");
		expect(getJapaneseHolidayName("2019-02-23")).toBeNull();
	});

	it("applies 2020 and 2021 Olympic holiday shifts and Sunday Mountain Day substitute holiday", () => {
		expect(getJapaneseHolidayName("2020-07-23")).toBe("海の日");
		expect(getJapaneseHolidayName("2020-07-24")).toBe("スポーツの日");
		expect(getJapaneseHolidayName("2020-08-10")).toBe("山の日");
		expect(getJapaneseHolidayName("2020-10-12")).toBeNull();

		expect(getJapaneseHolidayName("2021-07-22")).toBe("海の日");
		expect(getJapaneseHolidayName("2021-07-23")).toBe("スポーツの日");
		expect(getJapaneseHolidayName("2021-08-08")).toBe("山の日");
		expect(getJapaneseHolidayName("2021-08-09")).toBe("振替休日");
	});

	it("computes 2024 and 2027 equinoxes and substitute holidays accurately", () => {
		expect(getJapaneseHolidayName("2024-03-20")).toBe("春分の日");
		expect(getJapaneseHolidayName("2024-09-22")).toBe("秋分の日");
		expect(getJapaneseHolidayName("2024-09-23")).toBe("振替休日");

		expect(getJapaneseHolidayName("2027-03-21")).toBe("春分の日");
		expect(getJapaneseHolidayName("2027-03-22")).toBe("振替休日");
		expect(getJapaneseHolidayName("2027-09-23")).toBe("秋分の日");
	});

	it("returns null for normal weekdays, invalid strings, and out-of-range years", () => {
		expect(getJapaneseHolidayName("2026-11-20")).toBeNull();
		expect(getJapaneseHolidayName("2026-13-01")).toBeNull();
		expect(getJapaneseHolidayName("invalid")).toBeNull();
		expect(getJapaneseHolidayName("1947-11-03")).toBeNull();
		expect(getJapaneseHolidaysForYear(2200).size).toBe(0);
	});
});
