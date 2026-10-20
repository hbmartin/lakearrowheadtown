const dayFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
});

export const dateLabel = (date: string): string => dayFormat.format(new Date(`${date}T12:00:00Z`));
