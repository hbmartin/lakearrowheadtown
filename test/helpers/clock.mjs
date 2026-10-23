// Keep injected maintenance sleeps and monotonic time paired. Each test owns one.
export function fakeClock(initial = 0) {
  let time = initial;
  const waits = [];
  const advance = ms => { time += ms; };
  return { now: () => time, advance, waits, sleep: async ms => { waits.push(ms); advance(ms); } };
}
