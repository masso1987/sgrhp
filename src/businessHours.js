/** Business-hours calendar (§5.3): Mon–Fri, 08:00–17:00 (9h/day).
 *  TODO M7: tenant-configurable working days + public holidays. */
const WORK_START = 8, WORK_END = 17;
const isWorkDay = d => d.getDay() >= 1 && d.getDay() <= 5;

function elapsedBusinessHours(fromIso, to = new Date()) {
  let h = 0; const d = new Date(fromIso);
  while (d < to) {
    d.setTime(d.getTime() + 3600e3);
    if (isWorkDay(d) && d.getHours() > WORK_START && d.getHours() <= WORK_END) h++;
  }
  return h;
}
module.exports = { elapsedBusinessHours };
