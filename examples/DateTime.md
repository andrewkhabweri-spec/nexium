const { DateTime, Duration, Interval, Info } = require('nexium-orm');

const now = DateTime.now();
console.log(now.toISO());
console.log(now.toLocaleString({ dateStyle: 'medium', timeStyle: 'short' }));

const later = now.plus({ hours: 3, minutes: 30 });
console.log(later.toISO());

const diff = later.diff(now);
console.log(diff.as('minutes')); // 210

const interval = Interval.after(now, { hours: 4 });
console.log(interval.length().as('hours')); // 4
const dt1 = DateTime.fromISO('2025-12-02T10:15:00Z');
const dt2 = DateTime.fromObject({ year: 2025, month: 12, day: 2, hour: 13, minute: 30, zone: 'UTC' });



console.log('--- DateTime Format Tests ---');
const dt = DateTime.fromISO('2025-12-02T18:30:15.250Z', { zone: 'UTC', locale: 'en' });
console.log(dt.toFormat('LLLL dd, yyyy HH:mm:ss.SSS ZZZ'));
console.log(dt.toFormat('LLL dd, yy hh:mm a'));
console.log(dt.weekNumber(), dt.weekYear(), dt.quarter());

console.log('
--- Relative Time Tests ---');
const base = DateTime.fromISO('2025-12-02T18:30:00Z');
console.log(dt.plus({ minutes:5 }).toRelative({ base })); // in 5 minutes
console.log(dt.minus({ hours:2 }).toRelative({ base }));  // 2 hours ago
console.log(dt.plus({ days:1 }).toRelativeCalendar({ base }));
console.log(dt.minus({ days:1 }).toRelativeCalendar({ base }));

console.log('
--- Duration Tests ---');
const dur = Duration.fromObject({ days:2, hours:5, minutes:30, seconds:10, milliseconds:500 });
console.log(dur.toISO());
console.log(dur.plus({ hours:2 }).as('hours'));
console.log(dur.minus({ days:1 }).toObjectNormalized());

console.log('
--- Interval Tests ---');
const i = Interval.after(base, { hours:4 });
console.log(i.contains(dt.plus({ hours:1 })));
console.log(i.contains(dt.plus({ hours:10 })));
console.log(i.length().as('hours'));

console.log('
--- Info Locale Tests ---');
console.log(Info.months({ locale: 'fr' }));
console.log(Info.weekdays({ locale: 'de' }));
console.log(Info.timeZones());
