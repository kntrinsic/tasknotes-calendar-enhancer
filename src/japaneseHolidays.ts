const MIN_SUPPORTED_YEAR = 1948;
const MAX_SUPPORTED_YEAR = 2150;
const MS_PER_DAY = 86_400_000;
const STRICT_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const yearHolidayCache = new Map<number, ReadonlyMap<string, string>>();

function formatUtcDate(year: number, month: number, day: number): string {
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getNthWeekdayOfMonth(
	year: number,
	month: number,
	targetWeekday: number,
	nth: number,
): number {
	const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
	const offset = (targetWeekday - firstWeekday + 7) % 7;
	return 1 + offset + (nth - 1) * 7;
}

function getVernalEquinoxDay(year: number): number {
	if (year <= 1979) {
		return Math.floor(
			20.8357 + 0.242194 * (year - 1980) - Math.floor((year - 1983) / 4),
		);
	}
	if (year <= 2099) {
		return Math.floor(
			20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4),
		);
	}
	return Math.floor(
		21.851 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4),
	);
}

function getAutumnalEquinoxDay(year: number): number {
	if (year <= 1979) {
		return Math.floor(
			23.2588 + 0.242194 * (year - 1980) - Math.floor((year - 1983) / 4),
		);
	}
	if (year <= 2099) {
		return Math.floor(
			23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4),
		);
	}
	return Math.floor(
		24.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4),
	);
}

function toUtcDateString(utcMs: number): string {
	const date = new Date(utcMs);
	return formatUtcDate(
		date.getUTCFullYear(),
		date.getUTCMonth() + 1,
		date.getUTCDate(),
	);
}

function parseUtcMs(dateStr: string): number {
	const match = STRICT_DATE_PATTERN.exec(dateStr);
	if (!match) {
		return NaN;
	}
	return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function buildStatutoryHolidaysForYear(year: number): Map<string, string> {
	const holidays = new Map<string, string>();
	const setHoliday = (month: number, day: number, name: string): void => {
		holidays.set(formatUtcDate(year, month, day), name);
	};

	if (year >= 1949) {
		setHoliday(1, 1, "元日");

		if (year <= 1999) {
			setHoliday(1, 15, "成人の日");
		} else {
			setHoliday(1, getNthWeekdayOfMonth(year, 1, 1, 2), "成人の日");
		}
	}

	if (year >= 1967) {
		setHoliday(2, 11, "建国記念の日");
	}
	if (year >= 2020) {
		setHoliday(2, 23, "天皇誕生日");
	}

	if (year >= 1949) {
		setHoliday(3, getVernalEquinoxDay(year), "春分の日");

		if (year <= 1988) {
			setHoliday(4, 29, "天皇誕生日");
		} else if (year <= 2006) {
			setHoliday(4, 29, "みどりの日");
		} else {
			setHoliday(4, 29, "昭和の日");
		}

		setHoliday(5, 3, "憲法記念日");
		if (year >= 2007) {
			setHoliday(5, 4, "みどりの日");
		}
		setHoliday(5, 5, "こどもの日");
	}

	if (year === 2020) {
		setHoliday(7, 23, "海の日");
		setHoliday(7, 24, "スポーツの日");
	} else if (year === 2021) {
		setHoliday(7, 22, "海の日");
		setHoliday(7, 23, "スポーツの日");
	} else if (year >= 1996 && year <= 2002) {
		setHoliday(7, 20, "海の日");
	} else if (year >= 2003) {
		setHoliday(7, getNthWeekdayOfMonth(year, 7, 1, 3), "海の日");
	}

	if (year === 2020) {
		setHoliday(8, 10, "山の日");
	} else if (year === 2021) {
		setHoliday(8, 8, "山の日");
	} else if (year >= 2016) {
		setHoliday(8, 11, "山の日");
	}

	if (year >= 1966 && year <= 2002) {
		setHoliday(9, 15, "敬老の日");
	} else if (year >= 2003) {
		setHoliday(9, getNthWeekdayOfMonth(year, 9, 1, 3), "敬老の日");
	}

	setHoliday(9, getAutumnalEquinoxDay(year), "秋分の日");

	if (year >= 1966 && year <= 1999) {
		setHoliday(10, 10, "体育の日");
	} else if (year >= 2000 && year <= 2019) {
		setHoliday(10, getNthWeekdayOfMonth(year, 10, 1, 2), "体育の日");
	} else if (year >= 2022) {
		setHoliday(10, getNthWeekdayOfMonth(year, 10, 1, 2), "スポーツの日");
	}

	setHoliday(11, 3, "文化の日");
	setHoliday(11, 23, "勤労感謝の日");

	if (year >= 1989 && year <= 2018) {
		setHoliday(12, 23, "天皇誕生日");
	}

	// Historical one-off national holidays enacted by special statute.
	if (year === 1959) {
		setHoliday(4, 10, "皇太子明仁親王の結婚の儀");
	} else if (year === 1989) {
		setHoliday(2, 24, "昭和天皇の大喪の礼");
	} else if (year === 1990) {
		setHoliday(11, 12, "即位礼正殿の儀");
	} else if (year === 1993) {
		setHoliday(6, 9, "皇太子徳仁親王の結婚の儀");
	} else if (year === 2019) {
		setHoliday(5, 1, "天皇の即位の日");
		setHoliday(10, 22, "即位礼正殿の儀");
	}

	return holidays;
}

function computeHolidaysForYear(year: number): ReadonlyMap<string, string> {
	const statutory = buildStatutoryHolidaysForYear(year);
	const combined = new Map<string, string>(statutory);

	// Citizens' Holiday (国民の休日, 1986+): non-Sunday weekday sandwiched between two statutory holidays.
	if (year >= 1986) {
		const yearStart = Date.UTC(year, 0, 1);
		const yearEnd = Date.UTC(year, 11, 31);
		for (let ms = yearStart + MS_PER_DAY; ms <= yearEnd - MS_PER_DAY; ms += MS_PER_DAY) {
			const dateStr = toUtcDateString(ms);
			if (statutory.has(dateStr)) {
				continue;
			}
			const weekday = new Date(ms).getUTCDay();
			if (weekday === 0) {
				continue;
			}
			const prevStr = toUtcDateString(ms - MS_PER_DAY);
			const nextStr = toUtcDateString(ms + MS_PER_DAY);
			if (statutory.has(prevStr) && statutory.has(nextStr)) {
				combined.set(dateStr, "国民の休日");
			}
		}
	}

	// Substitute Holiday (振替休日, effective 1973-04-12+): statutory holiday falling on Sunday.
	const yearPrefix = `${String(year).padStart(4, "0")}-`;
	for (const dateStr of statutory.keys()) {
		if (dateStr < "1973-04-12") {
			continue;
		}
		const ms = parseUtcMs(dateStr);
		if (Number.isNaN(ms) || new Date(ms).getUTCDay() !== 0) {
			continue;
		}
		if (year < 2007) {
			const nextStr = toUtcDateString(ms + MS_PER_DAY);
			if (nextStr.startsWith(yearPrefix) && !combined.has(nextStr)) {
				combined.set(nextStr, "振替休日");
			}
			continue;
		}
		for (let candidateMs = ms + MS_PER_DAY; ; candidateMs += MS_PER_DAY) {
			const candidateStr = toUtcDateString(candidateMs);
			if (!candidateStr.startsWith(yearPrefix)) {
				break;
			}
			if (!statutory.has(candidateStr) && !combined.has(candidateStr)) {
				combined.set(candidateStr, "振替休日");
				break;
			}
		}
	}

	return combined;
}

/**
 * Returns a date map (`YYYY-MM-DD` -> Japanese holiday name) computed offline
 * according to the Japanese Act on National Holidays (`1948`–`2150`).
 */
export function getJapaneseHolidaysForYear(year: number): ReadonlyMap<string, string> {
	if (!Number.isInteger(year) || year < MIN_SUPPORTED_YEAR || year > MAX_SUPPORTED_YEAR) {
		return new Map();
	}
	const cached = yearHolidayCache.get(year);
	if (cached) {
		return cached;
	}
	const computed = computeHolidaysForYear(year);
	yearHolidayCache.set(year, computed);
	return computed;
}

/**
 * Looks up the Japanese national holiday name for a strict `YYYY-MM-DD` date string, or `null`.
 */
export function getJapaneseHolidayName(dateStr: string): string | null {
	const match = STRICT_DATE_PATTERN.exec(dateStr.trim());
	if (!match) {
		return null;
	}
	const year = Number(match[1]);
	const holidays = getJapaneseHolidaysForYear(year);
	return holidays.get(dateStr.trim()) ?? null;
}
